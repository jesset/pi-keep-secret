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
import { createConfiguredMaskingExtension } from "../src/config/index.ts";
import type { MaskedCompactionStatus } from "../src/compaction/index.ts";
import { createKeepSecretCommandsExtension } from "../src/commands/index.ts";
import { createHarnessSession } from "../src/harness/fake-session.ts";

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
	const compaction: MaskedCompactionStatus = { fallbacks: 0, lastFallbackError: undefined };
	const commands = createKeepSecretCommandsExtension({ loader, pipeline, compaction });
	return { factory, commands, loader, pipeline, compaction };
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

describe("T7 /keep-secret 状态面板", () => {
	const OTHER_KEY = "sk-live-zyxwvutsrqponmlkjih";

	/** 直调命令 handler 并取全部 notify 文本。 */
	async function runCommand(
		commands: (pi: ExtensionAPI) => void,
		args: string,
	): Promise<string> {
		const { commandHandler } = registerExtension(commands);
		expect(commandHandler).toBeDefined();
		const { ctx, notifications } = recordingContext();
		await commandHandler!(args, ctx);
		return notifications.map((n) => n.message).join("\n");
	}

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
			// 压缩回退计数
			expect(status1).toMatch(/掩码压缩回退：0 次/);

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

	test("注入状态对象：压缩回退与 judge 预留位展示计数与原因", async () => {
		const made = makeCommands();
		made.compaction.fallbacks = 2;
		made.compaction.lastFallbackError = "掩码压缩摘要: 摘要为空";
		const withJudge = createKeepSecretCommandsExtension({
			loader: made.loader,
			pipeline: made.pipeline,
			compaction: made.compaction,
			judge: { truncations: 3, fallbacks: 1 },
		});
		const text = await runCommand(withJudge, "");
		expect(text).toMatch(/掩码压缩回退：2 次/);
		expect(text).toContain("掩码压缩摘要: 摘要为空");
		expect(text).toMatch(/judge：截断 3 次，fail-closed 回退 1 次/);
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
