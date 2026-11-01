/**
 * 测试接缝 1：进程内 pi 会话 + 脚本化假供应商。
 *
 * 经 SDK `createAgentSession` 创建真实会话，把 pi-ai 内置 faux 供应商用
 * `ModelRuntime.registerNativeProvider` 注册进运行时：出站请求走完整 pi
 * 管线（含扩展 context_with_system 钩子与 convertToLlm），最后由假供应商
 * 「应答」。假供应商逐次记录收到的消息（供应商视角），并按脚本顺序返回
 * 响应；脚本耗尽再被请求时 faux 会报错，使欠脚本的测试显式失败。
 *
 * 会话运行在临时目录、内存 settings 与内存 session 里，不触网、不落盘。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxContentBlock,
	type FauxResponseStep,
	type JsonObject,
	type Message,
} from "@earendil-works/pi-ai";

/**
 * 一次脚本化的助手响应：文本（可带 thinking），或一次工具调用
 * （可带 thinking/伴随文本；带 toolCall 时 stopReason 为 toolUse，轮次继续），
 * 或一次错误应答（stopReason=error，如掩码摘要重试耗尽后取消的用例）。
 */
export type ScriptedResponse =
	| { text: string; thinking?: string }
	| { toolCall: { name: string; arguments: JsonObject }; thinking?: string; text?: string }
	| { error: string };

/** 假供应商视角看到的一次模型请求：context 钩子之后、发给「供应商」的全部消息。 */
export interface ProviderRequest {
	modelId: string;
	messages: Message[];
}

/** 假供应商：脚本化响应队列 + 供应商视角请求记录。 */
export interface FakeProvider {
	/** 设定脚本化响应，按请求顺序逐次消耗（一次模型请求消耗一条）。 */
	setScript(responses: ScriptedResponse[]): void;
	/** 供应商视角的全部请求，按时间顺序。 */
	requests(): ProviderRequest[];
}

/** 一个可驱动的进程内 pi 会话。 */
export interface HarnessSession {
	session: AgentSession;
	provider: FakeProvider;
	dispose(): void;
}

/** harness 创建选项。 */
export interface HarnessOptions {
	/** 内联扩展工厂（随会话加载，如冒烟用的哨兵掩码扩展）。 */
	extensionFactories?: InlineExtension[];
	/** 随会话注册的自定义工具（默认内置 read/bash/edit/write 已禁用）。 */
	customTools?: ToolDefinition[];
	/** 扩展文件/目录路径（如本仓库扩展目录里的正式扩展）。 */
	extensionPaths?: string[];
	/** 会话 cwd 临时目录里预置的文件（相对路径 → 内容），如 AGENTS.md
	 *  项目指令（其内容会进入 system 消息的 sections）。 */
	cwdFiles?: Record<string, string>;
	/** 内存 settings 初始值（如调低 compaction.keepRecentTokens 以触发压缩）。 */
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

/** 把一次供应商请求的全部文本叶（含 toolCall 参数深字符串值）拼成可检索文本。 */
export function requestText(request: ProviderRequest): string {
	const parts: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			parts.push(value);
		} else if (Array.isArray(value)) {
			value.forEach(walk);
		} else if (value && typeof value === "object") {
			Object.values(value).forEach(walk);
		}
	};
	request.messages.forEach(walk);
	return parts.join("\n");
}

/** 把脚本化响应包装成 faux 响应步骤：先记录供应商视角，再返回脚本消息。 */
function toRecordedStep(
	scripted: ScriptedResponse,
	requests: ProviderRequest[],
): FauxResponseStep {
	return (context, _options, _state, model) => {
		requests.push({
			modelId: model.id,
			messages: structuredClone(context.messages),
		});
		const blocks: FauxContentBlock[] = [];
		if ("error" in scripted) {
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: scripted.error });
		}
		if (scripted.thinking !== undefined) {
			blocks.push(fauxThinking(scripted.thinking));
		}
		if ("text" in scripted && scripted.text !== undefined) {
			blocks.push(fauxText(scripted.text));
		}
		if ("toolCall" in scripted) {
			blocks.push(fauxToolCall(scripted.toolCall.name, scripted.toolCall.arguments));
			return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(blocks, {});
	};
}

/** 创建测试接缝 1 的 harness：进程内会话 + 脚本化假供应商。 */
export async function createHarnessSession(
	options: HarnessOptions = {},
): Promise<HarnessSession> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-secret-harness-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-keep-secret-cwd-"));
	for (const [relativePath, content] of Object.entries(options.cwdFiles ?? {})) {
		writeFileSync(join(cwd, relativePath), content);
	}
	const requests: ProviderRequest[] = [];

	const faux = fauxProvider({
		api: "pi-keep-secret-fake",
		provider: "keep-secret-fake",
		models: [{ id: "fake-1", name: "Keep Secret Fake Model" }],
	});

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	const settingsManager = SettingsManager.inMemory(options.settings);

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: options.extensionPaths,
		extensionFactories: options.extensionFactories,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		customTools: options.customTools,
		// 假供应商按脚本显式发起工具调用，harness 不启用内置 read/bash/edit/write。
		noTools: "builtin",
	});

	return {
		session,
		provider: {
			setScript(responses) {
				faux.setResponses(responses.map((r) => toRecordedStep(r, requests)));
			},
			requests() {
				return requests.slice();
			},
		},
		dispose() {
			session.dispose();
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}
