/**
 * 测试共享替身：进程内假 classifier（System One 形态）与命令面直测的
 * 注册/记录 stub。
 *
 * 概率脚本锚定真实网关实测校准数字（研究笔记 §1：中文句中密码 0.96 掩码 /
 * 订单号 0.04 丢弃 / gate 0.98）；test/judge-egress.test.ts 与
 * test/e2e-convergence.test.ts 共用同一拼写。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type { JudgeStatus } from "../src/judge/index.ts";

/** 进程内假 classifier 模型（仅测试；api 可指定线缆形态，缺省
 *  typesafe-system-one；插件自定义名用于 T16 线缆偏好用例）。 */
export function fakeClassifierModel(api: string = "typesafe-system-one"): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id: "jev-fake",
		name: "Fake Jev",
		api,
		provider: "keep-secret-fake",
		baseUrl: "http://127.0.0.1:1/fake",
		input: ["text"],
		cost: {},
		contextWindow: 128000,
	} as unknown as ClassifierModel<ClassifierApi>;
}

/** 概率脚本假 classify：记录调用，gate/candidate 概率由脚本给出；可选
 *  stall 挂起制造并发窗口并统计在途峰值（消息级并发观测）。 */
export function scriptClassify(script: {
	gate: (text: string) => number;
	candidate: (value: string) => number;
	error?: boolean;
	stall?: () => Promise<void>;
}) {
	const calls: ClassifierContext[] = [];
	let inFlight = 0;
	let peak = 0;
	const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
		calls.push(structuredClone(context));
		if (script.stall) {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await script.stall();
			inFlight--;
		}
		const base = {
			api: "typesafe-system-one" as const,
			provider: "keep-secret-fake",
			model: "jev-fake",
			timestamp: Date.now(),
		};
		if (script.error) {
			return { ...base, answers: {}, stopReason: "error", errorMessage: "judge down" };
		}
		const answers: Record<string, { type: "bool"; probability: number }> = {};
		const text = typeof context.state.text === "string" ? context.state.text : "";
		for (const id of Object.keys(context.questions)) {
			if (id === "gate") {
				answers[id] = { type: "bool", probability: script.gate(text) };
				continue;
			}
			const candidates = context.state.candidates as Record<string, unknown> | undefined;
			const index = id.slice("cand_".length);
			const value = typeof candidates?.[index] === "string" ? candidates[index] : "";
			answers[id] = { type: "bool", probability: script.candidate(value) };
		}
		return { ...base, answers, stopReason: "stop" };
	};
	return { classify, calls, peak: () => peak };
}

/** 空状态计数（每用例独立实例，断言不静默降级）。 */
export function emptyJudgeStatus(): JudgeStatus {
	return {
		degradedTexts: 0,
		lastResolutionError: undefined,
		judgedTexts: 0,
		failClosed: 0,
		truncatedCandidates: 0,
	};
}

/** stub pi：从扩展工厂提取注册的 input 处理器与 /keep-secret 命令 handler
 *  （与 pi 同一调用面；其余注册面为 no-op）。commands 直测与 e2e 共用
 *  同一替身（架构评审候选 4：替身一份，防测试口径漂移）。 */
export function registerExtension(factory: (pi: ExtensionAPI) => void) {
	const registered: {
		inputHandler?: (
			event: { type: "input"; text: string },
			ctx: ExtensionCommandContext,
		) => unknown;
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

/** 记录 notify 调用的 ctx（命令 handler 直测观察点）。 */
export function recordingContext(mode: "tui" | "print" | "rpc" = "tui", hasUI = true) {
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
