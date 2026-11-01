/**
 * ticket #4 验收用例（接缝 1）：正式扩展（extension/index.ts）经
 * extensionPaths 加载，断言只看外部行为——假供应商收到什么、本地
 * transcript 收到什么。参考 GitHub issue jesset/pi-keep-secret#4 的
 * Acceptance criteria 逐条落成用例。
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/** 正式扩展入口（目录扩展 index.ts 工厂，内置默认检测器）。 */
const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

/** 各默认检测器格式的真值样本（形状对齐内置默认检测器集）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";

describe("T2 出站掩码：context_with_system 消息树遍历", () => {
	test("user prompt 密钥出站只见伪值，transcript 保留真值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);

			const [request] = h.provider.requests();
			expect(requestText(request)).not.toContain(OPENAI_KEY);
			const masked = requestText(request).match(/sk-[A-Z2-7]{12}/);
			expect(masked).not.toBeNull(); // 格式保真伪值（sk-{hash}）

			// 请求本地改写：本地 transcript 用户消息仍写真值
			const lastUser = [...h.session.messages].reverse().find((m) => m.role === "user");
			expect(JSON.stringify(lastUser?.content)).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("同一 secret 跨两轮出站伪值一致（一致性哈希锚点）", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ack" }, { text: "ok" }]);
			await h.session.prompt(`first use ${OPENAI_KEY}`);
			await h.session.prompt(`second use ${OPENAI_KEY}`);

			const [req1, req2] = h.provider.requests();
			const ph1 = requestText(req1).match(/sk-[A-Z2-7]{12}/)?.[0];
			const ph2 = requestText(req2).match(/sk-[A-Z2-7]{12}/)?.[0];
			expect(ph1).toBeDefined();
			expect(ph2).toBe(ph1);
			// 两轮出站都不含真值；本地 transcript 两轮用户消息都是真值
			for (const request of h.provider.requests()) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
			const userTexts = h.session.messages
				.filter((m) => m.role === "user")
				.map((m) => JSON.stringify(m.content));
			expect(userTexts).toHaveLength(2);
			for (const text of userTexts) {
				expect(text).toContain(OPENAI_KEY);
			}
		} finally {
			h.dispose();
		}
	});

	test("toolResult 文本掩码：工具结果真值进下一轮出站只见伪值，transcript 保留真值", async () => {
		const envParams = Type.Object({});
		const readEnv: ToolDefinition<typeof envParams> = {
			name: "read_env",
			label: "Read Env",
			description: "Returns the .env file contents (contains a key-shaped string).",
			parameters: envParams,
			execute: async () => ({
				content: [{ type: "text", text: `OPENAI_KEY=${OPENAI_KEY}` }],
				details: {},
			}),
		};
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			customTools: [readEnv],
		});
		try {
			h.provider.setScript([
				{ toolCall: { name: "read_env", arguments: {} } },
			{ text: "done" },
			]);
			await h.session.prompt("read the env file");

			// 第二轮出站（含工具结果）：供应商只见伪值
			expect(h.provider.requests()).toHaveLength(2);
			const second = h.provider.requests()[1];
			expect(requestText(second)).not.toContain(OPENAI_KEY);
			expect(requestText(second)).toMatch(/sk-[A-Z2-7]{12}/);

			// 本地 transcript 的工具结果写真值
			const toolResult = h.session.messages.find((m) => m.role === "toolResult");
			expect(JSON.stringify(toolResult?.content)).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("assistant 历史 text/thinking/toolCall 参数深遍历重掩码，transcript 保留真值", async () => {
		const runParams = Type.Object({ cmd: Type.String() });
		const seenCmds: string[] = [];
		const runCmd: ToolDefinition<typeof runParams> = {
			name: "run_cmd",
			label: "Run Cmd",
			description: "Runs a command.",
			parameters: runParams,
			execute: async (_id, params) => {
				seenCmds.push(params.cmd);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			customTools: [runCmd],
		});
		try {
			// 供应商脚本化"泄露"响应：thinking 与深嵌套 toolCall 参数里带真值；
			// 第二次响应带伴随文本（同消息 text+toolCall，轮次继续）以覆盖
			// assistant 文本历史的重掩码
			h.provider.setScript([
				{
					toolCall: {
						name: "run_cmd",
						arguments: {
							cmd: `export KEY=${OPENAI_KEY}`,
							env: { auth: `Bearer ${OPENAI_KEY}` },
						},
					},
					thinking: `用户密钥是 ${OPENAI_KEY}，别外传`,
				},
				{
					toolCall: { name: "run_cmd", arguments: { cmd: "noop" } },
					text: `再确认一次 ${OPENAI_KEY}`,
				},
				{ text: "done" },
			]);
			await h.session.prompt("run the deploy");

			// 轮次 2（assistant toolCall+thinking）与轮次 3（assistant text）出站都只见伪值
			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			for (const request of requests) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
			const second = requestText(requests[1]);
			expect(second.match(/sk-[A-Z2-7]{12}/g)).toHaveLength(3); // thinking + cmd + 深嵌套 env.auth
			expect(requestText(requests[2])).toMatch(/sk-[A-Z2-7]{12}/);

			// 本地 transcript：assistant 消息（thinking/参数/文本）均保留真值
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain(`Bearer ${OPENAI_KEY}`);
			expect(transcript).toContain(`用户密钥是 ${OPENAI_KEY}`);
			expect(transcript).toContain(`再确认一次 ${OPENAI_KEY}`);
			// 工具执行拿到真值（T2 不做回程还原，脚本化参数原样落地）
			expect(seenCmds).toEqual([`export KEY=${OPENAI_KEY}`, "noop"]);
		} finally {
			h.dispose();
		}
	});
});
