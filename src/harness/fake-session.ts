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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
	type Message,
} from "@earendil-works/pi-ai";

/** 一次脚本化的助手响应：文本，或一次工具调用。 */
export type ScriptedResponse =
	| { text: string }
	| { toolCall: { name: string; arguments: Record<string, unknown> } };

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
		if ("text" in scripted) {
			return fauxAssistantMessage(scripted.text);
		}
		return fauxAssistantMessage(
			[fauxToolCall(scripted.toolCall.name, scripted.toolCall.arguments)],
			{ stopReason: "toolUse" },
		);
	};
}

/** 创建测试接缝 1 的 harness：进程内会话 + 脚本化假供应商。 */
export async function createHarnessSession(): Promise<HarnessSession> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-keep-secret-harness-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-keep-secret-cwd-"));
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

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(),
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
