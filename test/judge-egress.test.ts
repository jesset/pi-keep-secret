/**
 * ticket #7 验收用例（接缝 1）：judge 出站扩展在进程内 pi 会话的
 * context_with_system 链上工作——classifier 模型解析、judge span 掩码、
 * 模型缺失降级（仅 regex 层 + 状态计数不静默）与 fail_closed 全链路。
 *
 * 假 classifier 方案（研究笔记 §4）：适配器逻辑已在 src/judge/system-one.test.ts
 * 以注入 ClassifyFn 的纯替身覆盖；本文件在扩展工厂的两个注入点
 * （resolveModel/classify）挂进程内替身驱动完整钩子链，概率脚本锚定
 * 真实网关实测校准数字（§1：中文句中密码 0.96 掩码 / 订单号 0.04 丢弃 /
 * gate 0.98）。真实网关验证见 research/systemone-gateway.test.ts（默认
 * 跳过，环境变量启用）。judge 扩展必须先于 regex 出站扩展注册（判定
 * 需要原文；regex 层幂等过滤已签发伪值）。
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";
import { createJudgeEgressExtension, type ClassifierModelRef, type JudgeStatus } from "../src/judge/index.ts";
import { createEgressMaskingExtension, createMaskingPipeline } from "../src/masking/index.ts";

/** judge 命中锚（真实网关实测 0.96 掩码）与非凭据锚（0.04 丢弃）。 */
const PASSWORD = "N0Judged-K3y9wq";
const ORDER = "1029384756";
/** regex 层锚（内置默认检测器；降级用例证明 regex 照常工作）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";

/** 进程内假 classifier 模型（typesafe-system-one 形态，仅测试）。 */
function fakeClassifierModel(): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id: "jev-fake",
		name: "Fake Jev",
		api: "typesafe-system-one",
		provider: "keep-secret-fake",
		baseUrl: "http://127.0.0.1:1/fake",
		input: ["text"],
		cost: {},
		contextWindow: 128000,
	} as unknown as ClassifierModel<ClassifierApi>;
}

/** 概率脚本假 classify：记录调用，gate/candidate 概率由脚本给出。 */
function scriptClassify(script: {
	gate: (text: string) => number;
	candidate: (value: string) => number;
	error?: boolean;
}) {
	const calls: ClassifierContext[] = [];
	const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
		calls.push(structuredClone(context));
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
	return { classify, calls };
}

/** 空状态计数（每用例独立实例，断言不静默降级）。 */
function emptyStatus(): JudgeStatus {
	return {
		degradedRequests: 0,
		lastResolutionError: undefined,
		judgedTexts: 0,
		failClosed: 0,
		truncatedCandidates: 0,
	};
}

const MODEL_REF: ClassifierModelRef = { provider: "keep-secret-fake", modelId: "jev-fake" };

describe("T5 judge 出站扩展（接缝 1）", () => {
	test("模型在位：judge 命中出站只见 key-{hash} 伪值，非凭据保留，regex 层共存", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const h = await createHarnessSession({
			extensionFactories: [
				createJudgeEgressExtension({
					modelRef: MODEL_REF,
					pipeline,
					status,
					resolveModel: () => fakeClassifierModel(),
					classify: (_model, context) => fake.classify(context),
				}),
				createEgressMaskingExtension({ pipeline }),
			],
		});
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}，密钥 ${OPENAI_KEY}`);

			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(PASSWORD); // judge 命中 → key-{hash} 伪值
			const placeholder = out.match(/key-[A-Z2-7]{12}/);
			expect(placeholder).not.toBeNull();
			expect(out).toContain(ORDER); // 判非凭据（0.04）：保留
			expect(out).not.toContain(OPENAI_KEY); // regex 层照常掩码
			// 本地可恢复：注册表持有 judge 伪值→真值映射（还原链共用）
			expect(pipeline.registry.snapshot().get(placeholder![0])).toBe(PASSWORD);
			// transcript 保留真值（请求本地改写）
			const lastUser = [...h.session.messages].reverse().find((m) => m.role === "user");
			expect(JSON.stringify(lastUser?.content)).toContain(PASSWORD);
			expect(status.judgedTexts).toBeGreaterThan(0);
			expect(status.degradedRequests).toBe(0);
			expect(status.failClosed).toBe(0);
		} finally {
			h.dispose();
		}
	});

	test("classifier 模型缺失 → 扩展降级：出站仅 regex 掩码 + 状态计数不静默", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const h = await createHarnessSession({
			extensionFactories: [
				// 缺省 resolveModel → ctx.modelRegistry.findOfType("classifier", ...)
				// harness 注册表没有该模型 → 降级路径
				createJudgeEgressExtension({
					modelRef: { provider: "no-such-provider", modelId: "no-such-model" },
					pipeline,
					status,
				}),
				createEgressMaskingExtension({ pipeline }),
			],
		});
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密钥 ${OPENAI_KEY}`);

			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(OPENAI_KEY); // 仅 regex 层工作
			expect(out).toMatch(/sk-[A-Z2-7]{12}/);
			expect(status.degradedRequests).toBe(1); // 每次出站计数，不静默
			expect(status.lastResolutionError).toContain("no-such-provider/no-such-model");
			expect(status.judgedTexts).toBe(0); // 未发起任何判定调用
		} finally {
			h.dispose();
		}
	});

	test("judge 故障注入 → 该消息未验证候选全掩（fail_closed 全链路）", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const fake = scriptClassify({ gate: () => 0.98, candidate: () => 0.96, error: true });
		const h = await createHarnessSession({
			extensionFactories: [
				createJudgeEgressExtension({
					modelRef: MODEL_REF,
					pipeline,
					status,
					resolveModel: () => fakeClassifierModel(),
					classify: (_model, context) => fake.classify(context),
				}),
				createEgressMaskingExtension({ pipeline }),
			],
		});
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}`);

			const out = requestText(h.provider.requests()[0]);
			// classify 全错 → gate 故障 → 候选（含订单号）一律掩码：零未验证出站
			expect(out).not.toContain(PASSWORD);
			expect(out).not.toContain(ORDER);
			expect(out).toMatch(/key-[A-Z2-7]{12}/);
			expect(status.failClosed).toBeGreaterThan(0);
			expect(status.degradedRequests).toBe(0);
		} finally {
			h.dispose();
		}
	});
});
