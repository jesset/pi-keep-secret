/**
 * ticket #9 验收用例（T7）：input 预检通知 + /keep-secret 命令面。
 *
 * 断言口径（ticket「接缝 1 或命令 handler 直测」）：
 * - input 预检：handler 直测（stub pi 记录注册面，ctx.ui 注入记录 notify
 *   调用——与 pi 调用处理器同一签名面）；非阻断语义经真实 harness 会话
 *   锚定（prompt 照常出站且已掩码）。
 * - /keep-secret 状态：harness 会话驱动会话事件（掩码/缓存计数递增），
 *   handler 直测断言 notify 文本含各计数器。
 * - /keep-secret test / reload：handler 直测 + harness 行为（reload 后新
 *   pattern 立即生效经 provider 视角断言）。
 * - 三模式安全降级：handler 仅经 ctx.ui.notify 输出（无交互原语），
 *   print 模式（no-op UI）运行无异常。
 *
 * 全部配置走临时文件，不触真实 ~/.pi 路径。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createConfiguredMaskingExtension, CONFIG_PATH_ENV } from "../src/config/index.ts";
import type { MaskedCompactionStatus } from "../src/compaction/index.ts";
import { createKeepSecretCommandsExtension } from "../src/commands/index.ts";
import type { JudgeLayerOutcome, JudgeStatus, JudgeTextMasker, JudgeWire } from "../src/judge/index.ts";
import { createMaskingPipeline } from "../src/masking/index.ts";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";

/** 各测试的临时目录登记（afterEach 统一清理）。 */
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** 组装命令面依赖：configContent 给定时写入临时配置文件（缺省不存在 → 内置默认集）。 */
function makeCommands(configContent?: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t7-"));
	tempDirs.push(dir);
	const configPath = join(dir, "config.json");
	if (configContent !== undefined) {
		writeFileSync(configPath, configContent, "utf8");
	}
	const { factory, loader, pipeline } = createConfiguredMaskingExtension({ configPath });
	const compaction: MaskedCompactionStatus = { cancellations: 0, lastCancellationError: undefined };
	const commands = createKeepSecretCommandsExtension({ loader, pipeline, compaction });
	return { factory, commands, loader, pipeline, compaction, configPath };
}

/** stub pi：记录注册的 input 处理器与 /keep-secret 命令 handler（与 pi 同一调用面）。 */
function registerExtension(factory: (pi: ExtensionAPI) => void) {
	const registered: {
		inputHandler?: (event: { type: "input"; text: string }, ctx: ExtensionCommandContext) => unknown;
		commandHandler?: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
	} = {};
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "input") {
				registered.inputHandler = handler as NonNullable<typeof registered.inputHandler>;
			}
		},
		registerCommand: (name: string, options: { handler: unknown }) => {
			if (name === "keep-secret") {
				registered.commandHandler = options.handler as NonNullable<typeof registered.commandHandler>;
			}
		},
	} as unknown as ExtensionAPI;
	factory(pi);
	return registered;
}

/** 记录 notify 调用的 ctx（handler 直测观察点）。 */
function recordingContext(mode: "tui" | "print" | "rpc" = "tui", hasUI = true) {
	const notifications: { message: string; type?: "info" | "warning" | "error" }[] = [];
	const ctx = {
		mode,
		hasUI,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

describe("T7 input 预检通知（默认 regex 集快扫，非阻塞）", () => {
	test("提交含 sk- 假 key 的 prompt → notify 告警含检测器名；返回 undefined 不改写不阻断", async () => {
		const { commands } = makeCommands();
		const { inputHandler } = registerExtension(commands);
		expect(inputHandler).toBeDefined();
		const { ctx, notifications } = recordingContext();

		const result = await inputHandler!({ type: "input", text: `deploy with ${OPENAI_KEY}` }, ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].type).toBe("warning");
		expect(notifications[0].message).toContain("looks like it contains a credential");
		expect(notifications[0].message).toContain("openai-key");
		expect(result).toBeUndefined(); // 纯通知：不返回 transform/handled
	});

	test("干净 prompt 不 notify；无 UI（print）模式静默", async () => {
		const { commands } = makeCommands();
		const { inputHandler } = registerExtension(commands);
		const clean = recordingContext();
		await inputHandler!({ type: "input", text: "status please" }, clean.ctx);
		expect(clean.notifications).toHaveLength(0);

		// print 模式 no-op UI：处理器照常运行、不因无 UI 抛错
		const silent = recordingContext("print", false);
		await inputHandler!({ type: "input", text: `deploy with ${OPENAI_KEY}` }, silent.ctx);
		expect(silent.notifications).toHaveLength(1); // 记录器视角；真实 print 模式此处为 no-op
	});

	test("真实会话不阻断：含 sk- 假 key 的 prompt 照常出站且已掩码", async () => {
		const { factory, commands } = makeCommands();
		const h = await createHarnessSession({ extensionFactories: [factory, commands] });
		try {
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			expect(h.provider.requests()).toHaveLength(1); // 未被阻断
		} finally {
			h.dispose();
		}
	});
});

/** 直调命令 handler 并取全部 notify 文本。 */
async function runCommand(commands: (pi: ExtensionAPI) => void, args: string): Promise<string> {
	const { commandHandler } = registerExtension(commands);
	expect(commandHandler).toBeDefined();
	const { ctx, notifications } = recordingContext();
	await commandHandler!(args, ctx);
	return notifications.map((n) => n.message).join("\n");
}

/** 折叠空白（报告按 72 列预算预先折行；断言多词短语前先归一）。 */
function flat(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** 空状态计数（每用例独立实例）。 */
function emptyJudgeStatus(): JudgeStatus {
	return {
		degradedTexts: 0,
		lastResolutionError: undefined,
		judgedTexts: 0,
		failClosed: 0,
		truncatedCandidates: 0,
	};
}

/** 恒等掩码器的 judge 替身（状态可注入；自测时假密码不被掩码；恒 clean）。 */
function identityJudge(status: JudgeStatus = emptyJudgeStatus(), onMissing: "fail_closed" | "regex_only" = "fail_closed"): JudgeTextMasker {
	const mask = async (text: string): Promise<JudgeLayerOutcome> => ({ text, verdict: "clean" });
	return { status, onMissing, modelMissing: false, wire: undefined, mask };
}

/** 自测假密码样本里的真值（judge 启用时期望被掩码的串）。 */
const SELF_TEST_PASSWORD = "Xk9$mQzT7vLw2Pn4";

/** 命中假密码的 judge 句柄（模拟可用 judge：仅掩密码样本真值）。 */
function passwordJudgingJudge(status: JudgeStatus = emptyJudgeStatus()): JudgeTextMasker {
	const mask = async (text: string): Promise<JudgeLayerOutcome> => ({
		text: text.split(SELF_TEST_PASSWORD).join("key-JUDGEDFAKE1"),
		verdict: "masked",
	});
	return { status, onMissing: "fail_closed", modelMissing: false, wire: undefined, mask };
}

describe("T7 /keep-secret 状态面板", () => {
	const OTHER_KEY = "sk-live-zyxwvutsrqponmlkjih";

	test("含各计数器且随会话事件递增（harness 会话驱动）", async () => {
		const { factory, commands } = makeCommands();
		const h = await createHarnessSession({ extensionFactories: [factory, commands] });
		try {
			h.provider.setScript([{ text: "ok" }, { text: "done" }]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			const status1 = await runCommand(commands, "");

			// 检测器配置摘要：来源（默认集）、条数（内置默认集 7 个）、名列表
			expect(status1).toContain("pi-keep-secret");
			expect(status1).toContain("built-in defaults (no config file at");
			expect(status1).toMatch(/detectors\s+7 · mode replace/);
			expect(status1).toContain("openai-key");
			// 注册表条目数：1 个不同 secret → 1 条
			expect(status1).toMatch(/placeholders\s+1 placeholder issued/);
			// clean cache：条目数与命中率（含「hits / scans」明细）
			expect(status1).toMatch(
				/clean cache\s+\d+ entries · hit rate \d+% \(\d+ hits? \/ \d+ scans?\)/,
			);
			// 各检测器命中计数：openai-key 第一轮 1 次
			expect(status1).toMatch(/openai-key=1/);
			// judge 预留位（未配置 judge 段）
			expect(status1).toContain("regex only (no judge config)");
			// 压缩取消计数
			expect(status1).toMatch(/cancelled\s+0/);

			// 第二轮：新 secret 入会话 → 计数器递增
			await h.session.prompt(`rotate to ${OTHER_KEY}`);
			const status2 = await runCommand(commands, "");
			// openai-key：第一轮 1 + 第二轮重扫历史 secret 消息 1 + 新 secret 1 = 3
			expect(status2).toMatch(/openai-key=3/);
			expect(status2).toMatch(/2 placeholders issued/);
			// clean cache 检测计数递增（第一轮已判定的干净文本被命中短路）
			const scans1 = Number(status1.match(/(\d+) scans?/)?.[1]);
			const scans2 = Number(status2.match(/(\d+) scans?/)?.[1]);
			expect(scans2).toBeGreaterThan(scans1);
			const hits1 = Number(status1.match(/(\d+) hits?/)?.[1]);
			const hits2 = Number(status2.match(/(\d+) hits?/)?.[1]);
			expect(hits2).toBeGreaterThan(hits1);
		} finally {
			h.dispose();
		}
	});

	test("状态面显示 detectorsMode 与生效检测器数（T13：merge 计数含内置+新增）", async () => {
		// replace（缺省）：用户集整体替换，1 个
		const replaceText = await runCommand(
			makeCommands(
				JSON.stringify({
					detectors: [
						{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9]{20,}", redactTemplate: "corp-{hash}" },
					],
				}),
			).commands,
			"",
		);
		expect(replaceText).toMatch(/detectors\s+1 · mode replace/);

		// merge：内置 7（同名 openai-key 被覆盖仍在原位）+ 新增 corp，共 8 个
		const mergeText = await runCommand(
			makeCommands(
				JSON.stringify({
					detectorsMode: "merge",
					detectors: [
						{ name: "openai-key", pattern: "sk-live-[A-Za-z0-9_-]{20,}", redactTemplate: "key-{hash}" },
						{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9]{20,}", redactTemplate: "corp-{hash}" },
					],
				}),
			).commands,
			"",
		);
		expect(mergeText).toMatch(/detectors\s+8 · mode merge/);
		expect(mergeText).toContain("corp-api-key");
	});

	test("注入状态对象：压缩取消与 judge 计数展示（已判定/截断/fail-closed/降级）", async () => {
		const made = makeCommands();
		made.compaction.cancellations = 2;
		made.compaction.lastCancellationError = "masked compaction summary: empty summary";
		const judgeStatus = {
			...emptyJudgeStatus(),
			judgedTexts: 7,
			failClosed: 1,
			truncatedCandidates: 3,
		};
		const withJudge = createKeepSecretCommandsExtension({
			loader: made.loader,
			// judge 替身经管线 options 注入（ADR-0001：命令面不再单独持有 judge）
			pipeline: createMaskingPipeline({ judge: { masker: identityJudge(judgeStatus) } }),
			compaction: made.compaction,
		});
		const text = await runCommand(withJudge, "");
		expect(text).toMatch(/cancelled\s+2/);
		expect(text).toContain("masked compaction summary: empty summary");
		expect(text).toMatch(/judged\s+7 texts/);
		expect(text).toMatch(/truncated\s+3 candidates/);
		expect(text).toMatch(/fail-closed\s+1 text/);
		expect(text).toMatch(/degraded\s+0 texts/);
	});

	test("T16 状态面线缆展示：跟随注册 / 偏好覆盖 / 插件自定义（偏好未生效）；解析前不展示线缆段", async () => {
		const made = makeCommands();
		const statusLine = async (wire: JudgeWire | undefined): Promise<string> => {
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: createMaskingPipeline({ judge: { masker: { ...identityJudge(), wire } } }),
				compaction: made.compaction,
			});
			return await runCommand(commands, "");
		};
		// 模型未解析前（wire undefined）：不展示线缆段
		expect(await statusLine(undefined)).not.toContain("wire");
		// 分支 1：缺省偏好——跟随模型注册条目
		expect(await statusLine({ source: "registered", api: "typesafe-system-one" })).toContain(
			"follows registration (typesafe-system-one)",
		);
		// 分支 2：已知 classifier api + 偏好——覆盖分发线缆
		expect(
			await statusLine({ source: "override", preference: "systemone", api: "typesafe-system-one" }),
		).toContain("override systemone (typesafe-system-one)");
		expect(
			await statusLine({ source: "override", preference: "decisions", api: "openai-decisions" }),
		).toContain("override decisions (openai-decisions)");
		// 分支 3：插件自定义 api——尊重插件实现 + 偏好未生效标记
		expect(
			flat(await statusLine({ source: "plugin", api: "litellm-decisions", ineffectivePreference: "systemone" })),
		).toContain("plugin custom litellm-decisions (judge.api preference systemone ignored)");
	});

	test("非法配置：状态面报配置错误与回退标记（无 UI 模式的错误可见出口）", async () => {
		const { commands } = makeCommands(
			JSON.stringify({ detectors: [{ name: "bad", pattern: "corp-[{" }] }),
		);
		const text = await runCommand(commands, "");
		expect(text).toContain("Config errors");
		expect(flat(text)).toMatch(/fell back to built-in defaults/);
	});
});

describe("T7 /keep-secret test 合成样本自测", () => {
	test("逐项报告掩码结果：样本 key 掩码、干净订单号不掩码，全部通过（info）", async () => {
		const made = makeCommands();
		const { commandHandler } = registerExtension(made.commands);
		const { ctx, notifications } = recordingContext();
		await commandHandler!("test", ctx);
		const text = notifications.map((n) => n.message).join("\n");

		expect(notifications).toHaveLength(1);
		expect(notifications[0].type).toBe("info");
		expect(text).toContain("pi-keep-secret · self-test");
		expect(text).toMatch(/✓\s+sk- fake key\s+masked\s+expected masked/);
		expect(text).toMatch(/✓\s+key in URL\s+masked\s+expected masked/);
		expect(text).toMatch(/✓\s+clean order number\s+unmasked\s+expected unmasked/);
		expect(text).toMatch(/✓\s+fake password\s+unmasked\s+expected unmasked/);
		expect(flat(text)).toContain("covered by the judge layer once a judge section is configured");
		expect(text).toMatch(/✓ 4\/4 passed/);

		// 自测实际驱动会话管线：两个样本 key 名自册表新增 2 条伪值
		expect(made.pipeline.registry.size).toBe(2);
	});

	describe("T8 自测假密码期望随 judge 启用动态化", () => {
		test("judge 启用且可用：假密码经 judge 掩码，期望掩码，全部通过（info）", async () => {
			const made = makeCommands();
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: createMaskingPipeline({ judge: { masker: passwordJudgingJudge() } }),
				compaction: made.compaction,
			});
			const text = await runCommand(commands, "test");
			expect(text).toMatch(/✓\s+fake password\s+masked\s+expected masked/);
			expect(text).toMatch(/✓ 4\/4 passed/);
			expect(text).not.toMatch(/✗/);
		});

		test("judge 模型缺失 + fail_closed（默认）：全部样本期望掩码（含干净订单号）+ 兑底说明行", async () => {
			const made = makeCommands();
			// 模拟模型缺失的 fail_closed 掩码器：全部 ASCII 候选一律掩码（与真实实现同则）
			const failClosedJudge: JudgeTextMasker = {
				status: emptyJudgeStatus(),
				onMissing: "fail_closed",
				modelMissing: true,
				wire: undefined,
				mask: async (text): Promise<JudgeLayerOutcome> => ({
					text: text
						.replace(/ORD-\d{8}-\d{6}/, "key-FAKEFAKEFAKE")
						.split(SELF_TEST_PASSWORD)
						.join("key-FAKEFAILCLS"),
					verdict: "masked",
				}),
			};
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: createMaskingPipeline({ judge: { masker: failClosedJudge } }),
				compaction: made.compaction,
			});
			const text = await runCommand(commands, "test");
			expect(text).toMatch(/✓\s+clean order number\s+masked\s+expected masked/); // 兑底掩码属预期
			expect(text).toMatch(/✓ 4\/4 passed/);
			expect(text).toContain("fail_closed is active");
			expect(text).toContain("judge.onMissing=\"regex_only\"");
		});

		test("judge 启用但降级（模型不可用）：假密码未被掩码，如实报未通过（warning，降级可见）", async () => {
			const made = makeCommands();
			const degraded = { ...emptyJudgeStatus(), degradedTexts: 2 };
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: createMaskingPipeline({ judge: { masker: identityJudge(degraded) } }),
				compaction: made.compaction,
			});
			const { commandHandler } = registerExtension(commands);
			const { ctx, notifications } = recordingContext();
			await commandHandler!("test", ctx);
			expect(notifications[0].type).toBe("warning");
			const text = notifications[0].message;
			expect(text).toMatch(/✗\s+fake password\s+unmasked\s+expected masked/);
			expect(text).toMatch(/✗ 3\/4 passed/);
			expect(text).toContain("judge degraded");
		});
	});

	test("当前检测器集未覆盖 sk- 时如实报告未通过（warning）", async () => {
		const { commands } = makeCommands(
			JSON.stringify({
				detectors: [{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9]{20,}", redactTemplate: "corp-{hash}" }],
			}),
		);
		const { commandHandler } = registerExtension(commands);
		const { ctx, notifications } = recordingContext();
		await commandHandler!("test", ctx);
		const text = notifications.map((n) => n.message).join("\n");

		expect(notifications[0].type).toBe("warning");
		expect(text).toMatch(/✗\s+sk- fake key\s+unmasked\s+expected masked/);
		expect(text).toMatch(/✗\s+key in URL\s+unmasked\s+expected masked/);
		expect(text).toMatch(/✗ 2\/4 passed/);
	});
});

describe("T7 /keep-secret reload 配置热重载", () => {
	const ALPHA_CONFIG = JSON.stringify({
		detectors: [{ name: "alpha-key", pattern: "alpha-[A-Za-z0-9]{20,}", redactTemplate: "alpha-{hash}" }],
	});
	const ALPHA_BETA_CONFIG = JSON.stringify({
		detectors: [
			{ name: "alpha-key", pattern: "alpha-[A-Za-z0-9]{20,}", redactTemplate: "alpha-{hash}" },
			{ name: "beta-key", pattern: "beta-[A-Za-z0-9]{20,}", redactTemplate: "beta-{hash}" },
		],
	});
	const BETA_KEY = "beta-qwertyuiopasdfghjklz";

	test("reload 后新 pattern 立即生效（provider 视角），notify 报告已热应用", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		const h = await createHarnessSession({ extensionFactories: [made.factory, made.commands] });
		try {
			h.provider.setScript([{ text: "ok" }, { text: "done" }]);
			// v1（仅 alpha）：beta 形状放行
			await h.session.prompt(`rotate ${BETA_KEY}`);
			expect(requestText(h.provider.requests()[0])).toContain(BETA_KEY);

			// 重写配置为 v2（补 beta 检测器），经命令面 reload
			writeFileSync(made.configPath, ALPHA_BETA_CONFIG, "utf8");
			const text = await runCommand(made.commands, "reload");
			expect(text).toContain("hot-applied");
			expect(text).toContain("beta-key");

			// 新 pattern 立即生效：历史 beta 消息重掩码出站
			await h.session.prompt("status");
			const second = requestText(h.provider.requests()[1]);
			expect(second).not.toContain(BETA_KEY);
			expect(second).toMatch(/beta-[A-Z2-7]{12}/);
		} finally {
			h.dispose();
		}
	});

	test("配置无变更 reload → notify 报告无变更（不动检测器集）", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		const text = await runCommand(made.commands, "reload");
		expect(text).toContain("unchanged");
		expect(made.loader.get().detectors).toHaveLength(1);
	});

	test("非检测器段变更（judge 配置）reload → 配置已重读、检测器集无变更且仅新会话生效", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		// 检测器集不变，仅新增 judge 段（reload 分类：judge=true、detectors=false）
		writeFileSync(
			made.configPath,
			JSON.stringify({
				detectors: JSON.parse(ALPHA_CONFIG).detectors,
				judge: { provider: "litellm", modelId: "typesafe/jev-latest" },
			}),
			"utf8",
		);
		const text = await runCommand(made.commands, "reload");
		expect(text).toMatch(/detectors\s+unchanged/);
		// 文案由分类驱动：仅列出实际变更的 session-only 段名
		expect(flat(text)).toContain("judge change(s) take effect in new sessions");
		expect(text).not.toContain("hot-applied"); // 检测器集未变：不触发热应用
		expect(made.loader.get().judge?.modelId).toBe("typesafe/jev-latest");
	});

	test("混合变更（检测器 + hashLength）reload → 热应用并列出 session-only 变更段名", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		writeFileSync(
			made.configPath,
			JSON.stringify({
				detectors: [
					...JSON.parse(ALPHA_CONFIG).detectors,
					{ name: "beta-key", pattern: "beta-[A-Za-z0-9]{20,}", redactTemplate: "beta-{hash}" },
				],
				hashLength: 20,
			}),
			"utf8",
		);
		const text = await runCommand(made.commands, "reload");
		expect(text).toContain("hot-applied");
		expect(text).toContain("beta-key");
		expect(flat(text)).toContain("hashLength change(s) take effect in new sessions");
	});

	test("reload 读到非法新配置 → notify 报错并回退内置默认集", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		writeFileSync(made.configPath, JSON.stringify({ detectors: [{ name: "bad", pattern: "((" }] }), "utf8");
		const text = await runCommand(made.commands, "reload");
		expect(text).toContain("reload failed");
		expect(flat(text)).toMatch(/fell back to built-in defaults/);
		expect(made.loader.get().detectors.map((d) => d.name)).toContain("openai-key");
	});
});

describe("T7 组合入口与三模式安全降级", () => {
	/** 正式扩展入口（目录扩展 index.ts 工厂，读 JSON 配置）。 */
	const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

	test("正式入口：三个子命令均被 pi 分发执行（无模型请求），与掩码共享同一管线", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t7-entry-"));
		tempDirs.push(dir);
		const saved = process.env[CONFIG_PATH_ENV];
		process.env[CONFIG_PATH_ENV] = join(dir, "config.json"); // 不存在 → 内置默认集
		try {
			const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
			try {
				// 预置脚本：若 /keep-secret 未被识别为命令，会作为 prompt 发给模型并消耗脚本、
			// 记录请求（.requests() > 0）；命令被分发执行则零请求、脚本零消耗
				h.provider.setScript([{ text: "ok" }, { text: "ok" }, { text: "ok" }]);
				await h.session.prompt("/keep-secret");
				await h.session.prompt("/keep-secret test");
				await h.session.prompt("/keep-secret reload");
				expect(h.provider.requests()).toHaveLength(0);
			} finally {
				h.dispose();
			}
		} finally {
			if (saved === undefined) {
				delete process.env[CONFIG_PATH_ENV];
			} else {
				process.env[CONFIG_PATH_ENV] = saved;
			}
		}
	});

	test("未知子命令 → 用法提示（不抛错）", async () => {
		const made = makeCommands();
		const text = await runCommand(made.commands, "bogus");
		expect(text).toContain("unknown subcommand");
		expect(text).toContain("/keep-secret test");
	});

	test("print 模式 no-op UI 下三个子命令均正常运行（安全降级：无交互原语）", async () => {
		const made = makeCommands();
		const { commandHandler } = registerExtension(made.commands);
		const { ctx, notifications } = recordingContext("print", false);
		for (const args of ["", "test", "reload"]) {
			await commandHandler!(args, ctx);
		}
		expect(notifications).toHaveLength(3); // 动作均执行（真实 print 模式 notify 为 no-op，不抛错）
	});
});

/**
 * UI 语言守卫：用户可见字符串一律英文（源码注释与 docs 保持中文）。
 *
 * 两面夹住回归：
 * - 静态面：所有 `ctx.ui.notify(` / `ctx.ui.setStatus(` / `pi.registerCommand(`
 *   调用点内的字符串字面量不得含 CJK（注释、样例载荷不在字面量内，不误伤）；
 * - 行为面：状态/自测/reload/未知子命令/预检通知的实际输出不得含 CJK
 *   （含 judge 启用、降级、模型缺失、非法配置等分支）。
 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 用户可见 UI 串所在源文件（组合根 + 三处 notify/setStatus 调用点）。 */
const UI_SOURCES = [
	join(import.meta.dir, "..", "src", "commands", "extension.ts"),
	join(import.meta.dir, "..", "src", "config", "extension.ts"),
	join(import.meta.dir, "..", "src", "judge", "masker.ts"),
	join(import.meta.dir, "..", "src", "compaction", "extension.ts"),
	join(import.meta.dir, "..", "extension", "index.ts"),
];

/** 提取 `callee(` 的平衡括号参数块（覆盖模板字面量中的括号）。 */
function callArgumentBlocks(source: string, callee: string): string[] {
	const blocks: string[] = [];
	let from = 0;
	for (;;) {
		const start = source.indexOf(`${callee}(`, from);
		if (start < 0) break;
		let depth = 0;
		let end = start + callee.length;
		for (; end < source.length; end++) {
			const char = source[end];
			if (char === "(") depth += 1;
			else if (char === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		blocks.push(source.slice(start + callee.length + 1, end));
		from = end + 1;
	}
	return blocks;
}

/** 参数块内的字符串字面量（中英混排、模板插值均可）。 */
function stringLiterals(text: string): string[] {
	return text.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
}

describe("T7 UI 语言守卫（用户可见字符串一律英文）", () => {
	test("notify / setStatus / 命令注册的字符串字面量不含 CJK", async () => {
		const offenders: string[] = [];
		for (const path of UI_SOURCES) {
			const source = await Bun.file(path).text();
			for (const callee of ["ctx.ui.notify", "ctx.ui.setStatus", "pi.registerCommand"]) {
				for (const block of callArgumentBlocks(source, callee)) {
					for (const literal of stringLiterals(block)) {
						if (CJK_PATTERN.test(literal)) {
							offenders.push(`${path} → ${callee}: ${literal}`);
						}
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("命令面输出不含 CJK（状态/自测/reload/未知子命令/预检各分支）", async () => {
		const passwordJudge: JudgeTextMasker = {
			status: emptyJudgeStatus(),
			onMissing: "fail_closed",
			modelMissing: false,
			wire: { source: "registered", api: "typesafe-system-one" },
			mask: async (text): Promise<JudgeLayerOutcome> => ({ text, verdict: "clean" }),
		};
		const variants = [
			{ masker: undefined },
			{
				masker: {
					...passwordJudge,
					status: { ...emptyJudgeStatus(), judgedTexts: 7, failClosed: 1, degradedTexts: 2 },
				},
			},
			{ masker: { ...passwordJudge, modelMissing: true } },
		];
		const outputs: string[] = [];
		for (const variant of variants) {
			const made = makeCommands();
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: createMaskingPipeline({ judge: variant.masker === undefined ? undefined : { masker: variant.masker } }),
				compaction: made.compaction,
			});
			const { commandHandler } = registerExtension(commands);
			const { ctx, notifications } = recordingContext();
			for (const args of ["", "test", "reload", "bogus"]) {
				await commandHandler!(args, ctx);
			}
			outputs.push(...notifications.map((notification) => notification.message));
		}
		// 非法配置分支（状态面错误列表）
		const bad = makeCommands(JSON.stringify({ detectors: [{ name: "bad", pattern: "corp-[{" }] }));
		outputs.push(await runCommand(bad.commands, ""));
		// 预检通知
		const { inputHandler } = registerExtension(makeCommands().commands);
		const precheck = recordingContext();
		await inputHandler!({ type: "input", text: `deploy with ${OPENAI_KEY}` }, precheck.ctx);
		outputs.push(...precheck.notifications.map((notification) => notification.message));

		expect(outputs.length).toBeGreaterThan(5);
		for (const output of outputs) {
			expect(output).not.toMatch(CJK_PATTERN);
		}
	});
});
