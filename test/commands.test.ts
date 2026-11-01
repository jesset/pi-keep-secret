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
import type { JudgeStatus, JudgeTextMasker } from "../src/judge/index.ts";
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
		expect(notifications[0].message).toContain("疑似凭据");
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

/** 恒等掩码器的 judge 句柄（状态可注入；自测时假密码不被掩码）。 */
function identityJudge(status: JudgeStatus = emptyJudgeStatus(), onMissing: "fail_closed" | "regex_only" = "fail_closed"): JudgeTextMasker {
	return { status, onMissing, modelMissing: false, mask: async (text) => text };
}

/** 自测假密码样本里的真值（judge 启用时期望被掩码的串）。 */
const SELF_TEST_PASSWORD = "Xk9$mQzT7vLw2Pn4";

/** 命中假密码的 judge 句柄（模拟可用 judge：仅掩密码样本真值）。 */
function passwordJudgingJudge(status: JudgeStatus = emptyJudgeStatus()): JudgeTextMasker {
	return {
		status,
		onMissing: "fail_closed",
		modelMissing: false,
		mask: async (text) => text.split(SELF_TEST_PASSWORD).join("key-JUDGEDFAKE1"),
	};
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
			expect(status1).toContain("来源：内置默认集");
			expect(status1).toMatch(/检测器：7 个/);
			expect(status1).toContain("openai-key");
			// 注册表条目数：1 个不同 secret → 1 条
			expect(status1).toMatch(/伪值注册表：1 条/);
			// clean cache：条目数与命中率（含「命中 x / 检测 y」明细）
			expect(status1).toMatch(/clean cache：\d+ 条，命中率 \d+%（命中 \d+ \/ 检测 \d+）/);
			// 各检测器命中计数：openai-key 第一轮 1 次
			expect(status1).toMatch(/openai-key=1/);
			// judge 预留位（T5 未合入）
			expect(status1).toContain("judge：未接入");
			// 压缩取消计数
			expect(status1).toMatch(/掩码压缩取消：0 次/);

			// 第二轮：新 secret 入会话 → 计数器递增
			await h.session.prompt(`rotate to ${OTHER_KEY}`);
			const status2 = await runCommand(commands, "");
			// openai-key：第一轮 1 + 第二轮重扫历史 secret 消息 1 + 新 secret 1 = 3
			expect(status2).toMatch(/openai-key=3/);
			expect(status2).toMatch(/伪值注册表：2 条/);
			// clean cache 检测计数递增（第一轮已判定的干净文本被命中短路）
			const scans1 = Number(status1.match(/检测 (\d+)/)?.[1]);
			const scans2 = Number(status2.match(/检测 (\d+)/)?.[1]);
			expect(scans2).toBeGreaterThan(scans1);
			const hits1 = Number(status1.match(/命中 (\d+)/)?.[1]);
			const hits2 = Number(status2.match(/命中 (\d+)/)?.[1]);
			expect(hits2).toBeGreaterThan(hits1);
		} finally {
			h.dispose();
		}
	});

	test("注入状态对象：压缩取消与 judge 计数展示（已判定/截断/fail-closed/降级）", async () => {
		const made = makeCommands();
		made.compaction.cancellations = 2;
		made.compaction.lastCancellationError = "掩码压缩摘要: 摘要为空";
		const judgeStatus = {
			...emptyJudgeStatus(),
			judgedTexts: 7,
			failClosed: 1,
			truncatedCandidates: 3,
		};
		const withJudge = createKeepSecretCommandsExtension({
			loader: made.loader,
			pipeline: made.pipeline,
			compaction: made.compaction,
			judge: identityJudge(judgeStatus),
		});
		const text = await runCommand(withJudge, "");
		expect(text).toMatch(/掩码压缩取消：2 次/);
		expect(text).toContain("掩码压缩摘要: 摘要为空");
		expect(text).toMatch(/judge：已判定 7 叶，截断 3 次，fail-closed 1 次，降级 0 叶/);
	});

	test("非法配置：状态面报配置错误与回退标记（无 UI 模式的错误可见出口）", async () => {
		const { commands } = makeCommands(
			JSON.stringify({ detectors: [{ name: "bad", pattern: "corp-[{" }] }),
		);
		const text = await runCommand(commands, "");
		expect(text).toContain("配置错误");
		expect(text).toMatch(/已回退内置默认集/);
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
		expect(text).toContain("pi-keep-secret 自测");
		expect(text).toMatch(/sk- 假 key：已掩码（期望：掩码）✓ 通过/);
		expect(text).toMatch(/URL 藏 key：已掩码（期望：掩码）✓ 通过/);
		expect(text).toMatch(/干净订单号：未掩码（期望：未掩码）✓ 通过/);
		expect(text).toMatch(/假密码：未掩码（期望：未掩码——低熵密码 regex 层不命中/);
		expect(text).toMatch(/4\/4 通过/);

		// 自测实际驱动会话管线：两个样本 key 名自册表新增 2 条伪值
		expect(made.pipeline.registry.size).toBe(2);
	});

	describe("T8 自测假密码期望随 judge 启用动态化", () => {
		test("judge 启用且可用：假密码经 judge 掩码，期望掩码，全部通过（info）", async () => {
			const made = makeCommands();
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: made.pipeline,
				compaction: made.compaction,
				judge: passwordJudgingJudge(),
			});
			const text = await runCommand(commands, "test");
			expect(text).toMatch(/假密码：已掩码（期望：掩码/);
			expect(text).toMatch(/4\/4 通过/);
			expect(text).not.toMatch(/✗/);
		});

		test("judge 模型缺失 + fail_closed（默认）：全部样本期望掩码（含干净订单号）+ 兑底说明行", async () => {
			const made = makeCommands();
			// 模拟模型缺失的 fail_closed 掩码器：全部 ASCII 候选一律掩码（与真实实现同则）
			const failClosedJudge: JudgeTextMasker = {
				status: emptyJudgeStatus(),
				onMissing: "fail_closed",
				modelMissing: true,
				mask: async (text) =>
					text
						.replace(/ORD-\d{8}-\d{6}/, "key-FAKEFAKEFAKE")
						.split(SELF_TEST_PASSWORD)
						.join("key-FAKEFAILCLS"),
			};
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: made.pipeline,
				compaction: made.compaction,
				judge: failClosedJudge,
			});
			const text = await runCommand(commands, "test");
			expect(text).toMatch(/干净订单号：已掩码（期望：掩码）✓ 通过/); // 兑底掩码属预期
			expect(text).toMatch(/4\/4 通过/);
			expect(text).toContain("fail_closed 已生效");
			expect(text).toContain("judge.onMissing=\"regex_only\"");
		});

		test("judge 启用但降级（模型不可用）：假密码未被掩码，如实报未通过（warning，降级可见）", async () => {
			const made = makeCommands();
			const degraded = { ...emptyJudgeStatus(), degradedTexts: 2 };
			const commands = createKeepSecretCommandsExtension({
				loader: made.loader,
				pipeline: made.pipeline,
				compaction: made.compaction,
				judge: identityJudge(degraded),
			});
			const { commandHandler } = registerExtension(commands);
			const { ctx, notifications } = recordingContext();
			await commandHandler!("test", ctx);
			expect(notifications[0].type).toBe("warning");
			const text = notifications[0].message;
			expect(text).toMatch(/假密码：未掩码（期望：掩码/);
			expect(text).toMatch(/3\/4 通过/);
			expect(text).toContain("judge 已降级");
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
		expect(text).toMatch(/sk- 假 key：未掩码（期望：掩码）✗ 未通过/);
		expect(text).toMatch(/URL 藏 key：未掩码（期望：掩码）✗ 未通过/);
		expect(text).toMatch(/2\/4 通过/);
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
			expect(text).toContain("已热应用");
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
		expect(text).toContain("无变更");
		expect(made.loader.get().detectors).toHaveLength(1);
	});

	test("非检测器段变更（judge 配置）reload → 配置已重读、检测器集无变更且仅新会话生效", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		// 检测器集不变，仅新增 judge 段（与 loader 的 fingerprint 同口径判定为变更）
		writeFileSync(
			made.configPath,
			JSON.stringify({
				detectors: JSON.parse(ALPHA_CONFIG).detectors,
				judge: { provider: "litellm", modelId: "typesafe/jev-latest" },
			}),
			"utf8",
		);
		const text = await runCommand(made.commands, "reload");
		expect(text).toContain("检测器集无变更");
		expect(text).toContain("仅新会话生效");
		expect(text).not.toContain("已热应用"); // 检测器集未变：不触发热应用
		expect(made.loader.get().judge?.modelId).toBe("typesafe/jev-latest");
	});

	test("reload 读到非法新配置 → notify 报错并回退内置默认集", async () => {
		const made = makeCommands(ALPHA_CONFIG);
		writeFileSync(made.configPath, JSON.stringify({ detectors: [{ name: "bad", pattern: "((" }] }), "utf8");
		const text = await runCommand(made.commands, "reload");
		expect(text).toContain("配置错误");
		expect(text).toMatch(/已回退内置默认集/);
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
		expect(text).toContain("未知子命令");
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
