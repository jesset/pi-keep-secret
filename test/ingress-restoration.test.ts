/**
 * ticket #5 验收用例（接缝 1）：回程还原——脚本化响应回显的伪值在
 * transcript 落盘与工具执行之前还原为真值。参考 GitHub issue
 * jesset/pi-keep-secret#5 的 Acceptance criteria 逐条落成用例。
 *
 * 断言只看外部行为：假供应商收到什么（供应商视角，只见过伪值、只能
 * 回显伪值）、本地 transcript 与工具执行收到什么（真值）。
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { makePlaceholder } from "../src/engine/index.ts";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/** 正式扩展入口（目录扩展 index.ts 工厂：出站掩码 + 回程还原组合）。 */
const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

/** 真值样本（形状对齐内置默认 openai-key 检测器）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";
/** 出站确定性伪值（默认 hashLength=12；脚本化回显只能用供应商见过的伪值）。 */
const OPENAI_PH = makePlaceholder(OPENAI_KEY, "sk-{hash}", 12);

/** 记录 cmd 参数的探针工具（bash 透明性验收的进程内等价物：fauxToolCall
 * 路径 + 记录工具；真 bash 对真模型的验证见 research/probe.ts 探针实验 2）。 */
function runCmdTool(seenCmds: string[]): ToolDefinition {
	const params = Type.Object({
		cmd: Type.String(),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
	});
	return {
		name: "run_cmd",
		label: "Run Cmd",
		description: "Runs a command.",
		parameters: params,
		execute: async (_id, input) => {
			seenCmds.push(input.cmd);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

describe("T3 回程还原：message_end + tool_call", () => {
	test("脚本化文本响应回显伪值：transcript 落真值，供应商全程只见伪值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			// 供应商只见过伪值，脚本化回显伪值
			h.provider.setScript([{ text: `the key is ${OPENAI_PH}` }]);
			await h.session.prompt(`use my key ${OPENAI_KEY}`);

			// 供应商视角：出站只见伪值
			const [request] = h.provider.requests();
			expect(requestText(request)).toContain(OPENAI_PH);
			expect(requestText(request)).not.toContain(OPENAI_KEY);
			// 本地 transcript：助手文本已还原为真值
			expect(h.session.getLastAssistantText()).toBe(`the key is ${OPENAI_KEY}`);

			// 还原后的助手历史进入本地 transcript；下一轮出站重新掩码（伪值确定性）
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt("again");
			const requests = h.provider.requests();
			const last = requests[requests.length - 1];
			expect(requestText(last)).not.toContain(OPENAI_KEY);
			expect(requestText(last)).toContain(OPENAI_PH);
		} finally {
			h.dispose();
		}
	});

	test("脚本化 toolCall 参数回显伪值：工具实际执行参数与 transcript 均为真值", async () => {
		const seenCmds: string[] = [];
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			customTools: [runCmdTool(seenCmds)],
		});
		try {
			// 供应商回 toolCall：参数里只有它见过的伪值（含深嵌套 env 值）
			h.provider.setScript([
				{
					toolCall: {
						name: "run_cmd",
						arguments: {
							cmd: `export KEY=${OPENAI_PH}`,
							env: { auth: `Bearer ${OPENAI_PH}` },
						},
					},
				},
				{ text: "done" },
			]);
			await h.session.prompt(`rotate the key ${OPENAI_KEY}`);

			// 工具实际执行参数为真值（message_end 还原在工具执行之前生效）
			expect(seenCmds).toEqual([`export KEY=${OPENAI_KEY}`]);
			// 本地 transcript：toolCall 参数（含深嵌套 env.auth）保留真值
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain(`export KEY=${OPENAI_KEY}`);
			expect(transcript).toContain(`Bearer ${OPENAI_KEY}`);
			// 供应商视角：全部请求只见伪值
			expect(h.provider.requests()).toHaveLength(2);
			for (const request of h.provider.requests()) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
		} finally {
			h.dispose();
		}
	});

	test("脚本化 thinking 回显伪值：transcript 的 thinking 块落真值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([
				{ text: "ack", thinking: `用户密钥是 ${OPENAI_PH}，我用它部署` },
			]);
			await h.session.prompt(`use my key ${OPENAI_KEY}`);

			// 本地 transcript：thinking 块已还原为真值
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain(`用户密钥是 ${OPENAI_KEY}，我用它部署`);
			expect(transcript).not.toContain(OPENAI_PH);
		} finally {
			h.dispose();
		}
	});

	test("max_tokens 截断的半个伪值：尾部前缀兑底还原为完整真值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			// 流式在伪值中间被截断：只剩伪值前 len-4 位（尾部重叠 ≥ min(20, len/2)）
			const truncated = OPENAI_PH.slice(0, OPENAI_PH.length - 4);
			h.provider.setScript([{ text: `deploying with ${truncated}` }]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);

			// 本地 transcript：半个伪值按前缀兑底还原为完整真值
			expect(h.session.getLastAssistantText()).toBe(`deploying with ${OPENAI_KEY}`);
		} finally {
			h.dispose();
		}
	});

	test("无伪值的响应消息零改动（幂等）：注册表非空也不误还原", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			// 第一轮掩码签发伪值（注册表非空）；响应不含任何伪值
			const PLAIN = "部署完成，未回显任何凭据。";
			h.provider.setScript([{ text: PLAIN, thinking: "nothing to echo" }]);
			await h.session.prompt(`use my key ${OPENAI_KEY}`);

			// 助手消息零改动：文本与 thinking 原样落盘
			expect(h.session.getLastAssistantText()).toBe(PLAIN);
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain("nothing to echo");
			expect(transcript).not.toContain(OPENAI_PH);
		} finally {
			h.dispose();
		}
	});
});
