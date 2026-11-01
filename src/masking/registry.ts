/**
 * 伪值注册表：进程内 Map<伪值,真值>，会话生命周期，上限 5000 LRU。
 *
 * 生命周期：随扩展工厂创建（每会话一份闭包状态），进程退出即失效，
 * 不做跨进程共享或持久化（规格 #1 Implementation Decisions）。
 *
 * 访问接口（T3 回程还原 / T5 judge 共用）：
 * - `issue(secret, template)`：签发伪值。幂等——同一真值重复签发恒得
 *   同一伪值（一致性哈希），并在每次签发时刷新 LRU 顺序。
 * - 哈希碰撞兜底：伪值已映射到**不同**真值时按参考实现追加 "x" 后缀
 *   直到空闲（secret_mask.py `_placeholder` 的 ph+"x" 策略，在注册表
 *   写入处做）。
 * - `has`/`get`：掩码层幂等过滤（命中文本已是伪值则跳过）与还原查值。
 * - `snapshot()`：伪值→真值副本（引擎 unmaskText 的 tokens 入参）。
 */
import { makePlaceholder } from "../engine/index.ts";

/** 注册表默认容量上限（对齐参考实现 registry 5000 LRU）。 */
const DEFAULT_LIMIT = 5000;
/** 伪值哈希段默认长度（引擎 makePlaceholder 同款默认）。 */
const DEFAULT_HASH_LENGTH = 12;

export interface PlaceholderRegistryOptions {
	/** 容量上限，默认 5000；超出按 LRU 逐出最旧写入。 */
	limit?: number;
	/** 伪值哈希段长度，默认 12。 */
	hashLength?: number;
}

export interface PlaceholderRegistry {
	/** 为真值签发伪值（确定性；碰撞时 x 后缀兜底；写入刷新 LRU）。 */
	issue(secret: string, template: string): string;
	/** 值是否已是注册表中的伪值（防嵌套掩码的幂等过滤用）。 */
	has(placeholder: string): boolean;
	/** 伪值 → 真值；未注册返回 undefined。 */
	get(placeholder: string): string | undefined;
	/** 全量伪值→真值副本（还原层 tokens；修改副本不影响注册表）。 */
	snapshot(): Map<string, string>;
	/** 当前条目数。 */
	readonly size: number;
	/** 清空（会话结束/测试用）。 */
	clear(): void;
}

/** 创建进程内伪值注册表。 */
export function createPlaceholderRegistry(
	options: PlaceholderRegistryOptions = {},
): PlaceholderRegistry {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const hashLength = options.hashLength ?? DEFAULT_HASH_LENGTH;
	const entries = new Map<string, string>();

	return {
		issue(secret, template) {
			let placeholder = makePlaceholder(secret, template, hashLength);
			while (
				entries.has(placeholder) &&
				entries.get(placeholder) !== secret
			) {
				placeholder += "x";
			}
			// 重复写入（含幂等重签）都刷新为最新（Map 尾部 = 最近使用）
			entries.delete(placeholder);
			entries.set(placeholder, secret);
			while (entries.size > limit) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
			return placeholder;
		},
		has(placeholder) {
			return entries.has(placeholder);
		},
		get(placeholder) {
			return entries.get(placeholder);
		},
		snapshot() {
			return new Map(entries);
		},
		get size() {
			return entries.size;
		},
		clear() {
			entries.clear();
		},
	};
}
