/**
 * 测试接缝 1 冒烟测试：进程内 pi 会话 + 脚本化假供应商 harness。
 *
 * 断言只走外部行为：假供应商收到什么（供应商视角）、transcript 与工具执行收到什么。
 * 参考 GitHub issue jesset/pi-keep-secret#1 的 Testing Decisions。
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/** 冒烟用哨兵真值与伪值（硬编码，非正式掩码实现）。 */
const REAL = "sk-sentinel-real-4f9d2c";
const FAKE = "sk-masked-000000000001";

function mask(s: string): string {
	return s.split(REAL).join(FAKE);
}

/** 深遍历字符串值做替换（toolCall 参数等嵌套结构）。 */
function deepReplace(value: unknown, from: string, to: string): unknown {
	if (typeof value === "string") return value.split(from).join(to);
	if (Array.isArray(value)) return value.map((v) => deepReplace(v, from, to));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, deepReplace(v, from, to)]),
		);
	}
	return value;
}

const recordSecretParams = Type.Object({ payload: Type.String() });

/** 记录工具：把收到的 payload 参数原样记录并回显（证明工具拿到真值）。 */
function recordingTool(seen: string[]): ToolDefinition<typeof recordSecretParams> {
	return {
		name: "record_secret",
		label: "Record Secret",
		description: "Records its payload argument for test assertions.",
		parameters: recordSecretParams,
		execute: async (_toolCallId, params) => {
			seen.push(params.payload);
			return {
				content: [{ type: "text", text: `Recorded: ${params.payload}` }],
				details: {},
			};
		},
	};
}

/** 内联哨兵掩码扩展（fixture）：出站把真值替换为伪值，message_end 回程还原。 */
function sentinelMaskingExtension(pi: ExtensionAPI): void {
	pi.on("context_with_system", (event) => {
		const messages = event.messages.map((message) => {
			if (message.role === "user") {
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
			}
			// 助手历史（含回程还原后的文本与 toolCall 参数）每轮出站重新掩码
			if (message.role === "assistant") {
				return {
					...message,
					content: message.content.map((block) => {
						if (block.type === "text") return { ...block, text: mask(block.text) };
						if (block.type === "toolCall") {
							return {
								...block,
								arguments: deepReplace(block.arguments, REAL, FAKE) as typeof block.arguments,
							};
						}
						return block;
					}),
				};
			}
			// 工具结果文本（含回显的真值）出站掩码
			if (message.role === "toolResult") {
				return {
					...message,
					content: message.content.map((part) =>
						part.type === "text" ? { ...part, text: mask(part.text) } : part,
					),
				};
			}
			return message;
		});
		return { messages };
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return undefined;
		let changed = false;
		const content = event.message.content.map((block) => {
			if (block.type === "text" && block.text.includes(FAKE)) {
				changed = true;
				return { ...block, text: block.text.split(FAKE).join(REAL) };
			}
			if (block.type === "toolCall" && JSON.stringify(block.arguments).includes(FAKE)) {
				changed = true;
				return {
					...block,
					arguments: deepReplace(block.arguments, FAKE, REAL) as typeof block.arguments,
				};
			}
			return block;
		});
		return changed ? { message: { ...event.message, content } } : undefined;
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

	test("message_end 还原断言：脚本化回显伪值的助手文本，transcript 落真值", async () => {
		const h = await createHarnessSession({ extensionFactories: [sentinelMaskingExtension] });
		try {
			// 供应商视角回显伪值（模型只见过伪值，只能回显伪值）
			h.provider.setScript([{ text: `the key is ${FAKE}` }]);
			await h.session.prompt(`use my key ${REAL}`);

			// 本地 transcript：助手文本已被还原为真值
			expect(h.session.getLastAssistantText()).toBe(`the key is ${REAL}`);

			// 还原后的助手历史进入本地 transcript；下一轮出站须重新掩码（伪值确定性）
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt("again");
			const requests = h.provider.requests();
			const lastRequest = requests[requests.length - 1];
			expect(requestText(lastRequest)).not.toContain(REAL);
			expect(requestText(lastRequest)).toContain(FAKE);
		} finally {
			h.dispose();
		}
	});

	test("toolCall 参数还原断言：工具执行收到真值，工具结果出站重掩码", async () => {
		const seenPayloads: string[] = [];
		const h = await createHarnessSession({
			extensionFactories: [sentinelMaskingExtension],
			customTools: [recordingTool(seenPayloads)],
		});
		try {
			// 供应商回 toolCall：参数里只有它见过的伪值
			h.provider.setScript([
				{ toolCall: { name: "record_secret", arguments: { payload: `Bearer ${FAKE}` } } },
				{ text: "done" },
			]);
			await h.session.prompt(`rotate the key ${REAL}`);

			// 工具执行与 transcript 都收到还原后的真值参数
			expect(seenPayloads).toEqual([`Bearer ${REAL}`]);
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain(`Bearer ${REAL}`);

			// 供应商视角：全部请求（含工具结果回合）都只有伪值
			expect(h.provider.requests()).toHaveLength(2);
			for (const request of h.provider.requests()) {
				expect(requestText(request)).not.toContain(REAL);
				expect(requestText(request)).toContain(FAKE);
			}
		} finally {
			h.dispose();
		}
	});
});
