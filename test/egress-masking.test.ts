/**
 * ticket #4 验收用例（接缝 1）：正式扩展（extension/index.ts）经
 * extensionPaths 加载，断言只看外部行为——假供应商收到什么、本地
 * transcript 收到什么。参考 GitHub issue jesset/pi-keep-secret#4 的
 * Acceptance criteria 逐条落成用例。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { makePlaceholder } from "../src/engine/index.ts";
import { createEgressMaskingExtension } from "../src/masking/extension.ts";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/**
 * 正式扩展入口（目录扩展 index.ts 工厂）。T4 起入口读取 JSON 配置：
 * 钉扎环境变量指向确定不存在的路径，使默认集用例不受机器上真实的
 * ~/.pi 配置文件影响（测试一律不触真实 ~/.pi 路径）。
 */
process.env.PI_KEEP_SECRET_CONFIG = join(tmpdir(), `pi-keep-secret-absent-${process.pid}.json`);

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

	test("system 消息 prose 掩码（AGENTS.md 项目指令），toolsAdded 工具 schema 不被触碰", async () => {
		// 工具描述里带同形 key：若遍历器误掩 toolsAdded 会破坏工具接线
		const SCHEMA_EXAMPLE = "sk-examplekey1234567890abcd";
		const params = Type.Object({ payload: Type.String() });
		const recordSecret: ToolDefinition<typeof params> = {
			name: "record_secret",
			label: "Record",
			description: `Records its payload. Shaped example: ${SCHEMA_EXAMPLE}`,
			parameters: params,
			execute: async () => ({ content: [{ type: "text", text: "recorded" }], details: {} }),
		};
		// AGENTS.md 项目指令进 system 消息 sections（project_context）：
		// 模拟项目指令里粘了 key 的真实场景
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			customTools: [recordSecret],
			cwdFiles: {
				"AGENTS.md": `# Project rules\n\nDeploy key: ${OPENAI_KEY}\n`,
			},
		});
		try {
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt("hello");

			const [request] = h.provider.requests();
			const system = request.messages.find((m) => m.role === "system");
			expect(system).toBeDefined();
			// prose/sections：供应商只见伪值
			const systemText = JSON.stringify(system);
			expect(systemText).not.toContain(OPENAI_KEY);
			expect(systemText).toMatch(/sk-[A-Z2-7]{12}/);
			// toolsAdded：工具 schema（含同形示例 key）原样保留
			const added = system?.toolsAdded?.find((t) => t.name === "record_secret");
			expect(added?.description).toContain(SCHEMA_EXAMPLE);
			// 本地 cwd 文件仍写真值
		} finally {
			h.dispose();
		}
	});

	test("toolResult 图片 data 字节不变（内嵌同形 key 也不动），同消息文本块照常掩码", async () => {
		// 假 base64 图片数据：内嵌命中 AWS 检测器的同形串——若遍历器误掩
		// ImageContent.data，此串会被改写（参考实现曾因 base64 内嵌 AIza/
		// AKIA 模式误命中损坏图片）
		const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAKIAIOSFODNN7EXAMPLE==";
		const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // 纯文本对照组：同形 key 在文本里必须被掩
		const params = Type.Object({});
		const readScreenshot: ToolDefinition<typeof params> = {
			name: "read_screenshot",
			label: "Read Screenshot",
			description: "Returns a text part and an image part.",
			parameters: params,
			execute: async () => ({
				content: [
					{ type: "text", text: `env aws key: ${AWS_KEY}` },
					{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
				],
				details: {},
			}),
		};
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			customTools: [readScreenshot],
		});
		try {
			h.provider.setScript([
				{ toolCall: { name: "read_screenshot", arguments: {} } },
				{ text: "done" },
			]);
			await h.session.prompt("show me the screenshot and env");

			expect(h.provider.requests()).toHaveLength(2);
			const second = h.provider.requests()[1];
			// 图片 data 字节不变（结构豁免）
			const toolResult = second.messages.find((m) => m.role === "toolResult");
			const image = toolResult?.content.find(
				(part): part is ImageContent => part.type === "image",
			);
			expect(image?.data).toBe(IMAGE_DATA);
			expect(image?.mimeType).toBe("image/png");
			// 同消息文本块照常掩码：同形 key 只见伪值
			const textParts = toolResult?.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n") ?? "";
			expect(textParts).not.toContain(AWS_KEY);
			expect(textParts).toMatch(/AKIA[A-Z2-7]{12}/);
		} finally {
			h.dispose();
		}
	});

	test("bashExecution 消息（!命令）：command/output 掩码后投影出站，transcript 保留真值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			// !命令 的 bashExecution 自定义消息：pi 经 bashExecutionToText 把
			// command+output 投影为 user 文本进 LLM 上下文（convertToLlm），
			// 两字段都必须在出站遍历器被掩码
			h.session.recordBashResult(`echo ${OPENAI_KEY}`, {
				output: `deploy key: ${OPENAI_KEY}`,
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt("status");

			const [request] = h.provider.requests();
			expect(requestText(request)).not.toContain(OPENAI_KEY);
			expect(requestText(request)).toMatch(/sk-[A-Z2-7]{12}/); // 伪值进入投影文本
			// 本地 session 保留真值（请求本地改写）
			const bash = h.session.messages.find((m) => m.role === "bashExecution");
			expect(bash?.command).toContain(OPENAI_KEY);
			expect(bash?.output).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("custom 自定义消息（sendMessage 注入）：string 与 text 块 content 掩码出站，transcript 保留真值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ok" }, { text: "ok" }]);
			// string content 形态
			await h.session.sendCustomMessage(
				{ customType: "deploy-note", content: `rotate key ${OPENAI_KEY}`, display: false },
				{ triggerTurn: true },
			);
			const first = h.provider.requests()[0];
			expect(requestText(first)).not.toContain(OPENAI_KEY);
			expect(requestText(first)).toMatch(/sk-[A-Z2-7]{12}/);
			// text 块数组形态（custom content 的另一合法形态）
			await h.session.sendCustomMessage(
				{
					customType: "deploy-note",
					content: [{ type: "text", text: `second key ${OPENAI_KEY}` }],
					display: false,
				},
				{ triggerTurn: true },
			);
			const second = h.provider.requests()[1];
			expect(requestText(second)).not.toContain(OPENAI_KEY);
			expect(requestText(second)).toMatch(/sk-[A-Z2-7]{12}/);
			// 本地 session 保留真值（请求本地改写）
			const custom = h.session.messages.find((m) => m.role === "custom");
			expect(JSON.stringify(custom?.content)).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("注册表层幂等过滤：助手历史回显的伪值不再嵌套掩码", async () => {
		// hashLength=30 时伪值本身也命中 sk- 检测器——若无幂等过滤，
		// 回显伪值会被再掩成「伪值的伪值」，还原链断裂
		const echoedPh = makePlaceholder(OPENAI_KEY, "sk-{hash}", 30);
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ hashLength: 30 })],
		});
		try {
			h.provider.setScript([
				// 供应商只见过伪值，脚本化回显伪值
				{ text: `got the key ${echoedPh}` },
				{ text: "ok" },
			]);
			await h.session.prompt(`use my key ${OPENAI_KEY}`);
			await h.session.prompt("again");

			// 第二轮出站：user 消息重掩得同一伪值 + 助手回显的伪值原样保留
			const [, second] = h.provider.requests();
			const text = requestText(second);
			expect(text).not.toContain(OPENAI_KEY);
			expect(text.split(echoedPh).length - 1).toBe(2);
		} finally {
			h.dispose();
		}
	});

	test("哈希碰撞 x 后缀兜底（端到端）：同轮两个碰撞 secret 各得稳定伪值", async () => {
		// 两字面量尾部均 ≥20 字符（命中 openai 检测器）且 sha256 首
		// base32 字符均为 "G"（hashLength=1 时伪值碰撞）
		const COLLIDE_A = "sk-collide-aaaa-0001-xy";
		const COLLIDE_B = "sk-collide-aaaa-0005-xy";
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ hashLength: 1 })],
		});
		try {
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt(`keys ${COLLIDE_A} and ${COLLIDE_B}`);

			const [request] = h.provider.requests();
			const text = requestText(request);
			expect(text).not.toContain(COLLIDE_A);
			expect(text).not.toContain(COLLIDE_B);
			// 一个得 sk-G，另一个得 x 后缀兜底 sk-Gx（与处理顺序无关）
			expect(text).toContain("sk-G");
			expect(text).toContain("sk-Gx");
			expect(text.match(/sk-Gx?/g)).toHaveLength(2);
		} finally {
			h.dispose();
		}
	});
});
