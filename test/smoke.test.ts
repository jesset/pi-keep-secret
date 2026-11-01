/**
 * 测试接缝 1 冒烟测试：进程内 pi 会话 + 脚本化假供应商 harness。
 *
 * 断言只走外部行为：假供应商收到什么（供应商视角）、transcript 与工具执行收到什么。
 * 参考 GitHub issue jesset/pi-keep-secret#1 的 Testing Decisions。
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/** 冒烟用哨兵真值与伪值（硬编码，非正式掩码实现）。 */
const REAL = "sk-sentinel-real-4f9d2c";
const FAKE = "sk-masked-000000000001";

function mask(s: string): string {
	return s.split(REAL).join(FAKE);
}

/** 内联哨兵掩码扩展（fixture）：context_with_system 出站把真值替换为伪值。 */
function sentinelMaskingExtension(pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => {
		const messages = event.messages.map((message) => {
			if (message.role !== "user") return message;
			// AgentMessage 的 user content 在钩子处可能是 string 或 text 块数组，两种都掩
			if (typeof message.content === "string") {
				return { ...message, content: mask(message.content) };
			}
			return {
				...message,
				content: message.content.map((part) =>
					part.type === "text" ? { ...part, text: mask(part.text) } : part,
				),
			};
		});
		return { messages };
	});
}

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

	test("出站断言：扩展掩码后假供应商只见伪值，transcript 保留真值", async () => {
		const h = await createHarnessSession({ extensionFactories: [sentinelMaskingExtension] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`use my key ${REAL}`);

			// 供应商视角：每个请求里都只有伪值、没有真值
			for (const request of h.provider.requests()) {
				expect(requestText(request)).toContain(FAKE);
				expect(requestText(request)).not.toContain(REAL);
			}
			// 本地 transcript：用户消息保留真值（请求本地改写，会话文件不受影响）
			const lastUser = [...h.session.messages].reverse().find((m) => m.role === "user");
			expect(JSON.stringify(lastUser?.content)).toContain(REAL);
			expect(JSON.stringify(lastUser?.content)).not.toContain(FAKE);
		} finally {
			h.dispose();
		}
	});
});
