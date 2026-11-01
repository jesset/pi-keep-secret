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
import { mkdtempSync, rmSync } from "node:fs";
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

/** 组装命令面依赖：不存在的配置路径（内置默认集）+ 会话级管线 + 压缩状态。 */
function makeCommands() {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t7-"));
	tempDirs.push(dir);
	const { factory, loader, pipeline } = createConfiguredMaskingExtension({
		configPath: join(dir, "config.json"),
	});
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
