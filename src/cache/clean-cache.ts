/**
 * clean cache（干净消息缓存）：sha256(文本) → 过期时刻，进程内 Map +
 * LRU 上限 + TTL（ticket #6 / T4）。
 *
 * 语义对齐参考实现 secret_mask.py `_detect` 的 OrderedDict 缓存：
 * - 键为文本的 sha256（hex），值为过期时刻（毫秒时间戳）；
 * - `expire > now` 视为干净（命中不续期、不刷新 LRU 位序）；
 * - 干净结论写入时刷新 LRU 位序（Map 尾部 = 最近写入），超上限逐出最旧；
 * - 命中 secret 或 gate 的文本**永不缓存**（`ScanOutcome.hasSecret`），
 *   每轮重扫——占比极小，一致性哈希保证跨轮同伪值。
 *
 * 挂接点：掩码管线检测入口（masking/extension.ts 的 maskText）——
 * `isClean` 未命中 = 实际执行一次检测，stats().misses 即检测计数。
 * T5 judge 接入后：gate 命中以 hasSecret=true 记墓碑（dirty 标记）——
 * 同一文本后续的干净结论（如后置 regex 层零命中）不得覆写，每轮重判。
 */
import { createHash } from "node:crypto";
import { evictLRU } from "./lru.ts";

/** 默认容量上限（对齐参考实现 CLEAN_CACHE_MAX 20000）。 */
const DEFAULT_LIMIT = 20000;
/** 默认 TTL：24 小时（毫秒）。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 一次检测扫描的结论（缓存写入依据）。 */
export interface ScanOutcome {
	/**
	 * 命中秘密信号——regex 检测器命中 span，或（T5）judge gate 命中/
	 * fail_closed。此类文本永不缓存：记墓碑拦截后续干净结论，每轮重扫。
	 */
	hasSecret: boolean;
}

/** 缓存统计（/keep-secret status 与验收「检测计数」断言用）。 */
export interface CleanCacheStats {
	/** 当前缓存条目数。 */
	size: number;
	/** isClean 命中次数（= 跳过检测的文本数）。 */
	hits: number;
	/** isClean 未命中次数（= 实际执行检测的文本数）。 */
	misses: number;
	/** LRU 超上限逐出的条数（不含 TTL 过期）。 */
	evictions: number;
}

export interface CleanCacheOptions {
	/** 容量上限，默认 20000；超出按 LRU 逐出最旧写入。 */
	limit?: number;
	/** TTL（毫秒），默认 24 小时；到期条目视为未命中。 */
	ttlMs?: number;
	/** 时钟注入（TTL 行为测试用），默认 Date.now。 */
	now?: () => number;
}

export interface CleanCache {
	/** 检测入口查询：文本是否已判定干净且未过期。 */
	isClean(text: string): boolean;
	/** 记录一次扫描结论：干净才入缓存；hasSecret 记墓碑（永不缓存，
	 *  且拦截后续对同一文本的干净结论）。 */
	remember(text: string, outcome: ScanOutcome): void;
	stats(): CleanCacheStats;
	/** 清空条目（检测器集热更新后旧的干净判定不再可信）。 */
	clear(): void;
}

/** 文本 → sha256(hex) 缓存键。 */
function cacheKey(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 创建进程内 clean cache（会话生命周期，随扩展工厂持有）。 */
export function createCleanCache(options: CleanCacheOptions = {}): CleanCache {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const now = options.now ?? Date.now;
	/** sha256(文本) → 过期时刻；Map 迭代序即 LRU 位序（头部 = 最旧）。 */
	const expiry = new Map<string, number>();
	/** 墓碑（hasSecret 文本）：拦截后续干净结论直至 clear（与条目同上限）。 */
	const dirty = new Set<string>();
	let hits = 0;
	let misses = 0;
	let evictions = 0;

	return {
		isClean(text) {
			const key = cacheKey(text);
			if (dirty.has(key)) {
				misses++;
				return false; // 墓碑：永不视为干净（每轮重扫）
			}
			const deadline = expiry.get(key);
			if (deadline === undefined) {
				misses++;
				return false;
			}
			if (now() >= deadline) {
				expiry.delete(key); // 过期条目就地清除（视为未命中）
				misses++;
				return false;
			}
			// 命中不续期、不刷新 LRU 位序（对齐参考实现：读零副作用）
			hits++;
			return true;
		},
		remember(text, outcome) {
			const key = cacheKey(text);
			if (outcome.hasSecret) {
				expiry.delete(key); // 若曾有干净条目一并作废
				dirty.add(key); // Set 尾部 = 最近插入
				evictions += evictLRU(dirty, limit);
				return; // 命中 secret/gate 的文本不缓存
			}
			if (dirty.has(key)) {
				return; // 墓碑优先：gate 命中文本的后续干净结论不覆写
			}
			expiry.delete(key);
			expiry.set(key, now() + ttlMs); // 尾部 = 最近写入
			evictions += evictLRU(expiry, limit);
		},
		stats() {
			return { size: expiry.size, hits, misses, evictions };
		},
		clear() {
			expiry.clear();
			dirty.clear();
		},
	};
}
