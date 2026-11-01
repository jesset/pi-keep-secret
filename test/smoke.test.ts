/**
 * 测试接缝 1 冒烟测试：进程内 pi 会话 + 脚本化假供应商 harness。
 *
 * 断言只走外部行为：假供应商收到什么（供应商视角）、transcript 与工具执行收到什么。
 * 参考 GitHub issue jesset/pi-keep-secret#1 的 Testing Decisions。
 */
import { describe, expect, test } from "bun:test";
import { createHarnessSession } from "../src/harness/fake-session.ts";

describe("测试接缝 1：进程内会话 + 脚本化假供应商", () => {
	test("脚本化文本响应到达 transcript，假供应商记录到该次请求", async () => {
		const h = await createHarnessSession();
		try {
			h.provider.setScript([{ text: "pong" }]);
			await h.session.prompt("ping");

			expect(h.session.getLastAssistantText()).toBe("pong");
			expect(h.provider.requests()).toHaveLength(1);
		} finally {
			h.dispose();
		}
	});
});
