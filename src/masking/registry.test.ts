/**
 * 伪值注册表（进程内 Map<伪值,真值>，会话生命周期）接口用例。
 *
 * 注册表是 ticket #4 的交付物之一：T2 出站掩码写入，T3（回程还原）/
 * T5（judge）共用——此处直接按其导出接口测试（签发幂等、LRU 上限、
 * 哈希碰撞后缀兜底），出站行为另由接缝 1 harness 用例覆盖。
 */
import { describe, expect, test } from "bun:test";
import { makePlaceholder } from "../engine/index.ts";
import { createPlaceholderRegistry } from "./registry.ts";

const SECRET_A = "sk-abcdefghijklmnopqrstuvwx";

describe("伪值注册表", () => {
	test("同一真值重复签发同一伪值，且与引擎 makePlaceholder 一致", () => {
		const registry = createPlaceholderRegistry();
		const first = registry.issue(SECRET_A, "sk-{hash}");
		const second = registry.issue(SECRET_A, "sk-{hash}");
		expect(second).toBe(first);
		// 独立真值来源：T1 引擎的确定性伪值算法
		expect(first).toBe(makePlaceholder(SECRET_A, "sk-{hash}", 12));
		expect(registry.get(first)).toBe(SECRET_A);
		expect(registry.has(first)).toBe(true);
	});

	test("不同真值签发不同伪值，snapshot/clear 按接口运转", () => {
		const registry = createPlaceholderRegistry();
		const a = registry.issue(SECRET_A, "sk-{hash}");
		const b = registry.issue("ghp_0123456789abcdefghijklmnopqrstuvwxyz", "ghp_{hash}");
		expect(a).not.toBe(b);
		expect(registry.size).toBe(2);

		const snapshot = registry.snapshot();
		expect(snapshot.get(a)).toBe(SECRET_A);
		snapshot.set(a, "tampered");
		expect(registry.get(a)).toBe(SECRET_A); // snapshot 是副本

		registry.clear();
		expect(registry.size).toBe(0);
		expect(registry.has(a)).toBe(false);
	});

	test("哈希碰撞后缀兜底：碰撞者得 x 后缀，且各自跨次签发稳定", () => {
		// hashLength=1 时伪值哈希段只有 1 个 base32 字符；两个字面量的
		// sha256 首字符均为 "R"（由 sha256 决定，与实现无关）
		const registry = createPlaceholderRegistry({ hashLength: 1 });
		const a = registry.issue("sk-collide0000xy", "sk-{hash}");
		const b = registry.issue("sk-collide0012xy", "sk-{hash}");
		expect(a).toBe("sk-R");
		expect(b).toBe("sk-Rx"); // 参考实现的 ph+"x" 兜底
		expect(registry.get("sk-R")).toBe("sk-collide0000xy");
		expect(registry.get("sk-Rx")).toBe("sk-collide0012xy");
		// 再签发：各自仍得同一伪值（跨轮确定性不因碰撞破坏）
		expect(registry.issue("sk-collide0000xy", "sk-{hash}")).toBe(a);
		expect(registry.issue("sk-collide0012xy", "sk-{hash}")).toBe(b);
	});

	test("LRU 上限逐出最旧写入，重签被逐出者按一致性哈希自愈", () => {
		const registry = createPlaceholderRegistry({ limit: 2 });
		const a = registry.issue("sk-aaaaaaaaaaaaaaaaaaaa", "sk-{hash}");
		registry.issue("sk-bbbbbbbbbbbbbbbbbbbb", "sk-{hash}");
		registry.issue("sk-cccccccccccccccccccc", "sk-{hash}"); // 逐出最旧的 a
		expect(registry.size).toBe(2);
		expect(registry.has(a)).toBe(false);

		// 被逐出后重签：同一真值仍得同一伪值（consistent hash，无需外部状态）
		expect(registry.issue("sk-aaaaaaaaaaaaaaaaaaaa", "sk-{hash}")).toBe(a);
		expect(registry.get(a)).toBe("sk-aaaaaaaaaaaaaaaaaaaa");
	});

	test("写入刷新 LRU 顺序：近期签发过的真值不被先逐出", () => {
		const registry = createPlaceholderRegistry({ limit: 2 });
		const a = registry.issue("sk-aaaaaaaaaaaaaaaaaaaa", "sk-{hash}");
		registry.issue("sk-bbbbbbbbbbbbbbbbbbbb", "sk-{hash}");
		registry.issue("sk-aaaaaaaaaaaaaaaaaaaa", "sk-{hash}"); // a 刷新为最新
		registry.issue("sk-cccccccccccccccccccc", "sk-{hash}"); // 逐出 b
		expect(registry.has(a)).toBe(true);
		expect(registry.get(a)).toBe("sk-aaaaaaaaaaaaaaaaaaaa");
		expect(registry.size).toBe(2);
	});
});
