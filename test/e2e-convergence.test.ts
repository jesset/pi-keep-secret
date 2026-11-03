/**
 * ticket #10（T8）验收用例（接缝 1）：正式组合入口的端到端收敛。
 *
 * 正式组合入口 = extension/index.ts 的装配（配置 × judge × regex 出站 ×
 * 回程还原 × 掩码压缩 × /keep-secret 命令面，共享同一管线/注册表/clean
 * cache）。无注入需求的用例直接经 extensionPaths 加载扩展目录入口文件；
 * 需要 judge 替身的用例经 createKeepSecretExtension（同一装配函数）注入
 * resolveModel/classify（judge 扩展的既有注入点）。
 *
 * 覆盖（ticket Acceptance）：
 * 1. 正式组合接线：judge 接入（配置 judge 段 → judge 先于 regex 注册 →
 *    密码类 secret 掩码 / 阈值配置生效 / 未配置仅 regex / 模型不可用降级）；
 * 2. 多轮对话掩码-还原-再掩码确定性；
 * 3. judge 故障 fail_closed 全链路（正式入口形态）；
 * 4. 压缩后对话继续且伪值一致；
 * 5. 图片内容字节不变。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { CONFIG_PATH_ENV } from "../src/config/index.ts";
import { makePlaceholder } from "../src/engine/index.ts";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";
import { createKeepSecretExtension } from "../extension/index.ts";
import {
	emptyJudgeStatus,
	fakeClassifierModel,
	recordingContext,
	registerCommandHandler,
	scriptClassify,
} from "./helpers.ts";

/** 正式扩展入口（目录扩展 index.ts：完整组合装配）。 */
const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

/** regex 层锚（内置默认检测器）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";
/** judge 层锚（regex 不可见的低熵密码）。 */
const PASSWORD = "N0Judged-K3y9wq";
/** judge 判非凭据锚。 */
const ORDER = "1029384756";

/** 本文件创建的临时目录与环境变量（afterEach 统一清理/恢复）。 */
const tempDirs: string[] = [];
const savedEnv: { key: string; value: string | undefined }[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	for (const { key, value } of savedEnv.splice(0)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

/** 建临时目录并写入配置文件，返回路径。 */
function writeTempConfig(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t8-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "config.json"), content, "utf8");
	return join(dir, "config.json");
}

/** 临时接管 PI_KEEP_SECRET_CONFIG（afterEach 恢复）。 */
function setConfigEnv(path: string): void {
	savedEnv.push({ key: CONFIG_PATH_ENV, value: process.env[CONFIG_PATH_ENV] });
	process.env[CONFIG_PATH_ENV] = path;
}

/** judge 配置段样例（密码判定可用/故障注入用例的公共形态）。 */
const JUDGE_CONFIG = JSON.stringify({
	judge: { provider: "keep-secret-fake", modelId: "jev-fake", redactTemplate: "key-{hash}" },
});

/** 空参数工具 schema（图片用例）。 */
const EMPTY_ARGS = Type.Object({});

/** 自测假密码样本里的真值（/keep-secret test 的固定样本）。 */
const SELF_TEST_PASSWORD = "Xk9$mQzT7vLw2Pn4";

/** 命中 PASSWORD 与自测密码的假 judge（gate 全命中；命中锚 0.96，其余 0.04）。 */
function passwordJudge() {
	return scriptClassify({
		gate: () => 0.98,
		candidate: (value) => (value === PASSWORD || value === SELF_TEST_PASSWORD ? 0.96 : 0.04),
	});
}

/** 直调同一组合实例的 /keep-secret 命令并取全部 notify 文本。 */
async function runKeepSecretCommand(
	factory: ReturnType<typeof createKeepSecretExtension>,
	args: string,
): Promise<string> {
	const { commandHandler } = registerCommandHandler(factory);
	expect(commandHandler).toBeDefined();
	const { ctx, notifications } = recordingContext();
	await commandHandler!(args, ctx);
	return notifications.map((n) => n.message).join("\n");
}

/** 折叠空白（报告按 72 列预算预先折行；断多词短语前先归一）。 */
function flat(text: string): string {
	return text.replace(/\s+/g, " ");
}

describe("T8 正式组合接线（judge 接入 extension/index.ts）", () => {
	test("配置 judge 段 + 可用 classifier：密码类 secret 掩码为 key-{hash}，regex 层共存，命令面点亮", async () => {
		const fake = passwordJudge();
		const ext = createKeepSecretExtension({
			configPath: writeTempConfig(JUDGE_CONFIG),
			resolveModel: () => fakeClassifierModel(),
			classify: (_model, context) => fake.classify(context),
		});
		const h = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}，密钥 ${OPENAI_KEY}`);

			// 出站（正式入口形态）：judge 层掩密码、regex 层掩 sk-，非凭据保留
			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(PASSWORD);
			expect(out).not.toContain(OPENAI_KEY);
			expect(out).toMatch(/key-[A-Z2-7]{12}/);
			expect(out).toMatch(/sk-[A-Z2-7]{12}/);
			expect(out).toContain(ORDER);

			// 命令面点亮：状态行展示 judge 计数；自测假密码期望掩码且 4/4 通过
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/judged\s+\d+ texts/);
			expect(status).toMatch(/truncated\s+0 candidates/);
			expect(status).toMatch(/fail-closed\s+0 texts/);
			expect(status).toMatch(/degraded\s+0 texts/);
			const selfTest = await runKeepSecretCommand(ext, "test");
			expect(selfTest).toMatch(/✓\s+fake password\s+masked\s+expected masked/);
			expect(selfTest).toMatch(/✓ 4\/4 passed/);
		} finally {
			h.dispose();
		}
	});

	test("配置阈值生效：gate 阈值高于脚本概率 → gate 短路，密码不掩（仅判计数）", async () => {
		const fake = passwordJudge(); // gate 恒 0.98 < 配置阈值 0.99 → 短路
		const ext = createKeepSecretExtension({
			configPath: writeTempConfig(
				JSON.stringify({ judge: { ...JSON.parse(JUDGE_CONFIG).judge, gateThreshold: 0.99 } }),
			),
			resolveModel: () => fakeClassifierModel(),
			classify: (_model, context) => fake.classify(context),
		});
		const h = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}`);
			// gate 短路：judge 不发候选问题，密码按「无命中」放行（配置即行为）
			expect(requestText(h.provider.requests()[0])).toContain(PASSWORD);
			expect(fake.calls.every((call) => Object.keys(call.questions).length === 1)).toBe(true);
		} finally {
			h.dispose();
		}
	});

	test("未配置 judge：仅 regex 检测层，命令面 judge 未接入，自测假密码期望未掩码", async () => {
		const configPath = writeTempConfig(JSON.stringify({ hashLength: 12 }));
		setConfigEnv(configPath);
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			const out = requestText(h.provider.requests()[0]);
			expect(out).toContain(PASSWORD); // regex 层不可见：放行（未启用 judge 属预期）
			expect(out).not.toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
		// 命令面（同一装配经工厂形态提取）：未接入行 + 自测期望未掩码
		const ext = createKeepSecretExtension({ configPath });
		const status = await runKeepSecretCommand(ext, "");
		expect(status).toContain("regex only (no judge config)");
		const selfTest = await runKeepSecretCommand(ext, "test");
		expect(selfTest).toMatch(/✓\s+fake password\s+unmasked\s+expected unmasked/);
		expect(selfTest).toMatch(/✓ 4\/4 passed/);
	});

	test("配置 judge 但模型不可用（默认 fail_closed）：未验证候选一律掩码，命令面 fail-closed 计数与策略可见", async () => {
		// 不注入 resolveModel：默认解析走 ctx.modelRegistry，harness 注册表无该
		// classifier 模型 → 模型缺失路径（spec 故事 19：与 classify 故障同则）
		setConfigEnv(writeTempConfig(JUDGE_CONFIG));
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}，密钥 ${OPENAI_KEY}`);
			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(OPENAI_KEY); // sk- 密钥同为未验证候选，被 judge 兑底掩码
			expect(out).not.toContain(PASSWORD); // 模型缺失 fail_closed：未验证候选一律掩码
			expect(out).not.toContain(ORDER);
			expect(out).toMatch(/key-[A-Z2-7]{12}/);
		} finally {
			h.dispose();
		}
		// 同一配置的工厂形态：fail-closed 计数与缺省策略展示；自测全过（fail_closed 掩码）
		const ext = createKeepSecretExtension({ configPath: process.env[CONFIG_PATH_ENV] });
		const h2 = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h2.provider.setScript([{ text: "ack" }, { text: "ack" }]);
			await h2.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			await h2.session.prompt("继续");
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/judged\s+0 texts/);
			expect(status).toMatch(/truncated\s+0 candidates/);
			expect(status).toMatch(/fail-closed\s+[1-9]\d* texts/);
			expect(status).toMatch(/degraded\s+0 texts/);
			expect(status).toMatch(/on missing\s+fail_closed/);
			const selfTest = await runKeepSecretCommand(ext, "test");
			expect(selfTest).toMatch(/✓\s+fake password\s+masked\s+expected masked/);
			expect(selfTest).toMatch(/✓ 4\/4 passed/);
		} finally {
			h2.dispose();
		}
	});

	test("配置 judge.onMissing=regex_only 且模型不可用：降级仅 regex 层，命令面降级可见（正式入口文件路径）", async () => {
		const regexOnlyConfig = JSON.stringify({
			judge: {
				...JSON.parse(JUDGE_CONFIG).judge,
				onMissing: "regex_only", // 显式知情选择：模型缺失时降级仅 regex 层
			},
		});
		setConfigEnv(writeTempConfig(regexOnlyConfig));
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(OPENAI_KEY); // regex 层照常工作
			expect(out).toMatch(/sk-[A-Z2-7]{12}/);
			expect(out).toContain(PASSWORD); // 降级：judge 层不可用（可见性由命令面计数保证）
		} finally {
			h.dispose();
		}
		// 同一配置的工厂形态：降级计数与策略展示可见，自测假密码项如实报未通过
		const ext = createKeepSecretExtension({ configPath: process.env[CONFIG_PATH_ENV] });
		const h2 = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h2.provider.setScript([{ text: "ack" }, { text: "ack" }]);
			await h2.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			await h2.session.prompt("继续");
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/judged\s+0 texts/);
			expect(status).toMatch(/truncated\s+0 candidates/);
			expect(status).toMatch(/fail-closed\s+0 texts/);
			expect(status).toMatch(/degraded\s+\d+ texts/);
			expect(status).toMatch(/on missing\s+regex_only/);
			const selfTest = await runKeepSecretCommand(ext, "test");
			expect(selfTest).toMatch(/✗\s+fake password\s+unmasked\s+expected masked/);
			expect(selfTest).toMatch(/✗ 3\/4 passed/);
			expect(selfTest).toContain("judge degraded");
		} finally {
			h2.dispose();
		}
	});
});

describe("T8 端到端收敛用例（正式组合入口）", () => {
	test("多轮对话：掩码-还原-再掩码确定性（供应商视角恒伪值，本地恒真值）", async () => {
		setConfigEnv(writeTempConfig(JSON.stringify({ hashLength: 12 })));
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			// 轮 1：提交真值；助手回显伪值（供应商只见伪值，只能回显伪值）
			h.provider.setScript([
				{ text: `已记录，密钥是 sk-live-abcdefghijklmnopqrst 的掩码形式` },
				{ text: "ok" },
				{ text: "done" },
			]);
			await h.session.prompt(`轮换密钥 ${OPENAI_KEY}`);
			// message_end 还原：transcript 助手文本落真值
			expect(h.session.getLastAssistantText()).toContain(OPENAI_KEY);

			// 轮 2/3：还原后的助手历史每轮重新掩码，且伪值跨轮字节一致
			const placeholder = requestText(h.provider.requests()[0]).match(/sk-[A-Z2-7]{12}/)![0];
			await h.session.prompt("继续");
			await h.session.prompt("再继续");
			expect(h.provider.requests()).toHaveLength(3);
			for (const request of h.provider.requests()) {
				const text = requestText(request);
				expect(text).not.toContain(OPENAI_KEY);
				expect(text).toContain(placeholder); // 同一真值恒同一伪值（确定性）
			}
			// 本地 transcript：用户与助手消息均保留真值
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain(OPENAI_KEY);
			expect(transcript).not.toContain(placeholder);
		} finally {
			h.dispose();
		}
	});

	test("judge 故障 fail_closed 全链路：未验证候选一律掩码，零未验证出站", async () => {
		const fake = scriptClassify({ gate: () => 0.98, candidate: () => 0.96, error: true });
		const ext = createKeepSecretExtension({
			configPath: writeTempConfig(JUDGE_CONFIG),
			resolveModel: () => fakeClassifierModel(),
			classify: (_model, context) => fake.classify(context),
		});
		const h = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h.provider.setScript([{ text: "ack" }, { text: "ok" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}，密钥 ${OPENAI_KEY}`);
			// classify 全错 → gate 故障 → 候选（含订单号）一律掩码：零未验证出站
			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(PASSWORD);
			expect(out).not.toContain(ORDER);
			expect(out).not.toContain(OPENAI_KEY);
			// 第二轮同判：故障持续时每轮 fail_closed（非 clean 不缓存）
			await h.session.prompt("继续");
			const second = requestText(h.provider.requests()[1]);
			expect(second).not.toContain(PASSWORD);
			expect(second).not.toContain(ORDER);
			// 命令面故障可见
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/fail-closed\s+[1-9]\d* texts/);
		} finally {
			h.dispose();
		}
	});

	test("压缩后对话继续且伪值一致：掩码摘要 → 还原落盘 → 保留区重掩码同一伪值", async () => {
		setConfigEnv(writeTempConfig(JSON.stringify({ hashLength: 12 })));
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			const PAD = "context padding for cut point placement. ".repeat(24);
			// 默认 hashLength=12 下该真值的确定性伪值（与扩展注册表同一算法）
			const PLACEHOLDER = makePlaceholder(OPENAI_KEY, "sk-{hash}", 12);
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				// 摘要「模型」回显伪值（它只见伪值，只能回显伪值）
				{ text: `## Critical Context\n- 部署密钥 ${PLACEHOLDER}` },
				{ text: "post-compact ack" },
			]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			const placeholder = requestText(h.provider.requests()[0]).match(/sk-[A-Z2-7]{12}/)![0];
			expect(placeholder).toBe(PLACEHOLDER);
			await h.session.prompt(PAD);
			await h.session.compact();

			// 摘要请求只见伪值；压缩 summary 还原真值落盘（掩码压缩链）
			const summaryRequest = requestText(h.provider.requests()[2]);
			expect(summaryRequest).not.toContain(OPENAI_KEY);
			expect(summaryRequest).toContain(PLACEHOLDER);
			const compaction = h.session.sessionManager
				.getEntries()
				.find((entry) => entry.type === "compaction");
			expect(compaction?.summary).toContain(OPENAI_KEY);
			expect(compaction?.summary).not.toContain(PLACEHOLDER);

			// 压缩后对话继续：summary（本地真值）与保留区出站重掩码，仍同一伪值
			await h.session.prompt("continue");
			const after = requestText(h.provider.requests()[3]);
			expect(after).not.toContain(OPENAI_KEY);
			expect(after).toContain(PLACEHOLDER); // 跨压缩伪值一致（确定性 = 还原链成立）
			// 本地会话历史保留真值
			expect(JSON.stringify(h.session.messages)).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("图片内容字节不变：工具结果图片出站字节一致，同消息文本照常掩码", async () => {
		setConfigEnv(writeTempConfig(JSON.stringify({ hashLength: 12 })));
		// 固定字节的合成图片 base64（确定性内容，逐字节比对）
		const IMAGE_B64 = Buffer.from(
			String.fromCharCode(...Array.from({ length: 256 }, (_, i) => (i * 7 + 13) % 256)),
		).toString("base64");
		const imageTool: ToolDefinition<typeof EMPTY_ARGS> = {
			name: "grab_screenshot",
			label: "Grab Screenshot",
			description: "Returns a synthetic screenshot image plus a text note.",
			parameters: EMPTY_ARGS,
			execute: async () => ({
				content: [
					{ type: "image", data: IMAGE_B64, mimeType: "image/png" },
					{ type: "text", text: `screenshot of env with key ${OPENAI_KEY}` },
				],
				details: {},
			}),
		};
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			customTools: [imageTool],
		});
		try {
			h.provider.setScript([
				{ toolCall: { name: "grab_screenshot", arguments: {} } },
				{ text: "done" },
			]);
			await h.session.prompt("请抓取截图");

			// 供应商视角：图片 data 逐字节一致；同消息文本的密钥已掩码
			const toolResultRound = h.provider.requests()[1];
			expect(toolResultRound).toBeDefined();
			let imageSeen = 0;
			for (const message of toolResultRound.messages) {
				if (message.role !== "toolResult") continue;
				for (const part of message.content) {
					if (part.type === "image") {
						imageSeen += 1;
						expect(part.data).toBe(IMAGE_B64);
						expect(part.mimeType).toBe("image/png");
					}
				}
			}
			expect(imageSeen).toBe(1);
			const roundText = requestText(toolResultRound);
			expect(roundText).not.toContain(OPENAI_KEY);
			expect(roundText).toMatch(/sk-[A-Z2-7]{12}/);
			// 本地 transcript：图片与文本（真值）原样保留
			const transcript = JSON.stringify(h.session.messages);
			expect(transcript).toContain(IMAGE_B64);
			expect(transcript).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});
});

describe("T16 judge.api 线缆偏好（正式组合入口）", () => {
	test("偏好与注册线缆一致：正常装配判定，命令面无降级且展示覆盖线缆", async () => {
		const fake = passwordJudge();
		const seenApis: string[] = [];
		const ext = createKeepSecretExtension({
			configPath: writeTempConfig(
				JSON.stringify({ judge: { ...JSON.parse(JUDGE_CONFIG).judge, api: "systemone" } }),
			),
			resolveModel: () => fakeClassifierModel(), // typesafe-system-one：与偏好 systemone 一致（覆盖幂等）
			classify: (m, context) => {
				seenApis.push(m.api);
				return fake.classify(context);
			},
		});
		const h = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(PASSWORD); // judge 照常判定掩码
			expect(out).not.toContain(OPENAI_KEY);
			expect(seenApis.length).toBeGreaterThan(0);
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/judged\s+\d+ texts/);
			expect(status).toMatch(/truncated\s+0 candidates/);
			expect(status).toMatch(/fail-closed\s+0 texts/);
			expect(status).toMatch(/degraded\s+0 texts/);
			expect(status).toContain("override systemone (typesafe-system-one)");
		} finally {
			h.dispose();
		}
	});

	test("偏好覆盖另一线缆：内置 api 模型按配置分发——classify 收到覆盖值，密码照常掩码", async () => {
		const fake = passwordJudge();
		const seenApis: string[] = [];
		const ext = createKeepSecretExtension({
			configPath: writeTempConfig(
				JSON.stringify({ judge: { ...JSON.parse(JUDGE_CONFIG).judge, api: "decisions" } }),
			),
			resolveModel: () => fakeClassifierModel(), // typesafe-system-one：偏好 decisions → 覆盖分发
			classify: (m, context) => {
				seenApis.push(m.api);
				return fake.classify(context);
			},
		});
		const h = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(PASSWORD); // 覆盖线缆照常判定掩码（不再拒绝装配）
			expect(out).not.toContain(OPENAI_KEY);
			expect(out).toMatch(/key-[A-Z2-7]{12}/);
			expect(seenApis.length).toBeGreaterThan(0);
			expect(new Set(seenApis)).toEqual(new Set(["openai-decisions"])); // classify 收到的 model.api 为覆盖值
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/fail-closed\s+0 texts/);
			expect(status).toMatch(/degraded\s+0 texts/);
			expect(status).toContain("override decisions (openai-decisions)");
		} finally {
			h.dispose();
		}
	});

	test("插件自定义 api + 偏好（用户现场场景）：尊重插件实现——正常装配掩码，命令面插件线缆与偏好未生效可见", async () => {
		const fake = passwordJudge();
		const seenApis: string[] = [];
		const ext = createKeepSecretExtension({
			configPath: writeTempConfig(
				JSON.stringify({ judge: { ...JSON.parse(JUDGE_CONFIG).judge, api: "systemone" } }),
			),
			resolveModel: () => fakeClassifierModel("litellm-decisions"), // 插件注册的自定义 api（#16 现场）
			classify: (m, context) => {
				seenApis.push(m.api);
				return fake.classify(context);
			},
		});
		const h = await createHarnessSession({ extensionFactories: [ext] });
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			const out = requestText(h.provider.requests()[0]);
			// 正常装配：judge 判定掩码照常（不再因名称不一致拒绝装配）
			expect(out).not.toContain(PASSWORD);
			expect(out).not.toContain(OPENAI_KEY);
			expect(out).toMatch(/key-[A-Z2-7]{12}/);
			expect(seenApis.length).toBeGreaterThan(0);
			expect(new Set(seenApis)).toEqual(new Set(["litellm-decisions"])); // 插件实现不被改写
			// 命令面：无降级计数，插件线缆与偏好未生效标记可见
			const status = await runKeepSecretCommand(ext, "");
			expect(status).toMatch(/judged\s+\d+ texts/);
			expect(status).toMatch(/truncated\s+0 candidates/);
			expect(status).toMatch(/fail-closed\s+0 texts/);
			expect(status).toMatch(/degraded\s+0 texts/);
			expect(flat(status)).toContain("plugin custom litellm-decisions (judge.api preference systemone ignored)");
			const selfTest = await runKeepSecretCommand(ext, "test");
			expect(selfTest).toMatch(/✓ 4\/4 passed/); // judge 正常工作：假密码项掩码通过
		} finally {
			h.dispose();
		}
	});
});
