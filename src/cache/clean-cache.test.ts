/**
 * clean cache（干净消息缓存）接口用例：sha256(文本)→过期时刻，LRU +
 * TTL，命中 secret/gate 的文本永不缓存（ticket #6 / T4）。
 *
 * 缓存挂接在掩码管线检测入口：isClean 未命中 = 实际执行一次检测，
 * stats().misses 即「检测计数」（验收用例的断言口径）；TTL/LRU 行为
 * 经注入时钟与容量直接验证（参考实现 secret_mask.py `_detect` 的
 * OrderedDict 语义：写时刷新 LRU 位序，命中不续期）。
 */
import { describe, expect, test } from "bun:test";
import { createCleanCache } from "./clean-cache.ts";

const CLEAN_TEXT = "just an ordinary message about deployment";
const OTHER_CLEAN = "another ordinary sentence";

describe("clean cache", () => {
	test("未见过文本 isClean 为 miss；判定干净后缓存命中；stats 记录命中/未命中", () => {
		const cache = createCleanCache();
		expect(cache.isClean(CLEAN_TEXT)).toBe(false); // miss = 需要执行检测
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		expect(cache.isClean(CLEAN_TEXT)).toBe(true); // 命中 = 跳过检测

		const stats = cache.stats();
		expect(stats.hits).toBe(1);
		expect(stats.misses).toBe(1);
		expect(stats.size).toBe(1);
	});

	test("hasSecret 的文本永不缓存（每轮重扫）", () => {
		const cache = createCleanCache();
		cache.remember(CLEAN_TEXT, { hasSecret: true });
		expect(cache.isClean(CLEAN_TEXT)).toBe(false);
		// T5 gate 命中同样经 hasSecret 标记表达（接口预留语义位）
		cache.remember(OTHER_CLEAN, { hasSecret: true });
		expect(cache.isClean(OTHER_CLEAN)).toBe(false);
		expect(cache.stats().size).toBe(0);
	});

	test("hasSecret 墓碑拦截后续干净结论（T5 gate 命中文本永不缓存）", () => {
		const cache = createCleanCache();
		cache.remember(CLEAN_TEXT, { hasSecret: true });
		// 同一文本后置的零命中结论（如 regex 层）不得覆写墓碑：gate 命中文本每轮重判
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		expect(cache.isClean(CLEAN_TEXT)).toBe(false);
		expect(cache.stats().size).toBe(0);
		// clear（检测器集热更新）后重新可缓存
		cache.clear();
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		expect(cache.isClean(CLEAN_TEXT)).toBe(true);
	});

	test("clear 清空条目（检测器集热更新后干净判定失效时使用）", () => {
		const cache = createCleanCache();
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		cache.clear();
		expect(cache.isClean(CLEAN_TEXT)).toBe(false);
		expect(cache.stats().size).toBe(0);
	});

	test("TTL 过期：到期条目视为未命中并就地清除，未到期仍命中", () => {
		let clock = 1_000_000;
		const cache = createCleanCache({ ttlMs: 60_000, now: () => clock });
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		clock += 59_999;
		expect(cache.isClean(CLEAN_TEXT)).toBe(true); // 差一毫秒仍未过期
		clock += 1; // 恰好到达过期时刻
		expect(cache.isClean(CLEAN_TEXT)).toBe(false);
		expect(cache.stats().size).toBe(0); // 过期条目不残留
		// TTL 过期不计入 LRU 逐出统计
		expect(cache.stats().evictions).toBe(0);
	});

	test("LRU 上限逐出最旧写入；重写刷新位序改变逐出对象", () => {
		const cache = createCleanCache({ limit: 2 });
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		cache.remember(OTHER_CLEAN, { hasSecret: false });
		// 重写 CLEAN_TEXT 刷新其 LRU 位序（尾部 = 最近）
		cache.remember(CLEAN_TEXT, { hasSecret: false });
		cache.remember("third clean text", { hasSecret: false }); // 超上限
		expect(cache.stats().evictions).toBe(1);
		expect(cache.isClean(OTHER_CLEAN)).toBe(false); // 最旧者被逐出
		expect(cache.isClean(CLEAN_TEXT)).toBe(true); // 重写过的仍留存
		expect(cache.isClean("third clean text")).toBe(true);
	});
});
