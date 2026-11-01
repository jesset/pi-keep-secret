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
import {
	createJudgeEgressExtension,
	createJudgeTextMasker,
	type ClassifierModelRef,
	type JudgeStatus,
} from "../src/judge/index.ts";
import { createEgressMaskingExtension, createMaskingPipeline } from "../src/masking/index.ts";

/** judge 命中锚（真实网关实测 0.96 掩码）与非凭据锚（0.04 丢弃）。 */
const PASSWORD = "N0Judged-K3y9wq";
const ORDER = "1029384756";
/** regex 层锚（内置默认检测器；降级用例证明 regex 照常工作）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";

/** 进程内假 classifier 模型（仅测试；api 可指定两种线缆形态）。 */
function fakeClassifierModel(api: string = "typesafe-system-one"): ClassifierModel<ClassifierApi> {
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
function scriptClassify(script: {
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
function emptyStatus(): JudgeStatus {
	return {
		degradedTexts: 0,
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
			expect(status.degradedTexts).toBe(0);
			expect(status.failClosed).toBe(0);
		} finally {
			h.dispose();
		}
	});

	test("classifier 模型缺失（默认 fail_closed）：未验证候选一律掩码，regex 层共存，零真值出站", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const h = await createHarnessSession({
			extensionFactories: [
				// 缺省 resolveModel → ctx.modelRegistry.findOfType("classifier", ...)
			// harness 注册表没有该模型 → 模型缺失路径（spec 故事 19：down
			// judge never means an unmasked request——与 classify 故障同则）
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
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}，密钥 ${OPENAI_KEY}`);

			const out = requestText(h.provider.requests()[0]);
			// 未验证候选（密码、订单号与 sk- 密钥——同为候选）一律掩为 judge 伪值；
		// regex 层对已签发伪值幂等跳过（两层串联安全）
			expect(out).not.toContain(PASSWORD);
			expect(out).not.toContain(ORDER);
			expect(out).not.toContain(OPENAI_KEY);
			expect(out).toMatch(/key-[A-Z2-7]{12}/);
			// 真值本地可恢复：注册表里能找到 PASSWORD 的 judge 伪值
			const placeholder = [...pipeline.registry.snapshot().entries()]
				.find(([, secret]) => secret === PASSWORD)?.[0];
			expect(placeholder).toBeDefined();
			expect(pipeline.registry.get(placeholder!)).toBe(PASSWORD);
			// 计数语义：fail_closed 生效（非降级放行），解析失败原因可见
			expect(status.failClosed).toBeGreaterThan(0);
			expect(status.degradedTexts).toBe(0);
			expect(status.judgedTexts).toBe(0); // 未发起任何 gate 调用
			expect(status.lastResolutionError).toContain("no-such-provider/no-such-model");
			// 本地 transcript 保留真值（请求本地改写）
			const lastUser = [...h.session.messages].reverse().find((m) => m.role === "user");
			expect(JSON.stringify(lastUser?.content)).toContain(PASSWORD);
		} finally {
			h.dispose();
		}
	});

	test("onMissing=regex_only：模型缺失显式降级——出站仅 regex 掩码 + 状态计数不静默", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const h = await createHarnessSession({
			extensionFactories: [
				createJudgeEgressExtension({
					modelRef: { provider: "no-such-provider", modelId: "no-such-model" },
					pipeline,
					status,
					onMissing: "regex_only",
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
			// 降级按文本叶计数（system + user 两个叶），不静默
			expect(status.degradedTexts).toBeGreaterThanOrEqual(2);
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
			expect(status.degradedTexts).toBe(0);
		} finally {
			h.dispose();
		}
	});

	test("消息级并发：多文本叶的 gate 调用在退道内重叠（信号量限 8）", async () => {
		const pipeline = createMaskingPipeline();
		const fake = scriptClassify({
			gate: () => 0.02, // 干净文本：每叶一次 gate 后短路
			candidate: () => 0.02,
			stall: () => new Promise((resolve) => setTimeout(resolve, 10)),
		});
		const h = await createHarnessSession({
			extensionFactories: [
				createJudgeEgressExtension({
					modelRef: MODEL_REF,
					pipeline,
					resolveModel: () => fakeClassifierModel(),
					classify: (_model, context) => fake.classify(context),
				}),
				createEgressMaskingExtension({ pipeline }),
			],
		});
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt("hello world");
			// system 与 user 两个文本叶的 gate 在退道内重叠（串行则峰值恒为 1）
			expect(fake.peak()).toBeGreaterThan(1);
			expect(fake.peak()).toBeLessThanOrEqual(8); // 会话级信号量上限
		} finally {
			h.dispose();
		}
	});

	test("与 clean cache 协同：干净消息缓存后不再发起 gate（非 clean 记墓碑）", async () => {
		const pipeline = createMaskingPipeline();
		const fake = scriptClassify({
			gate: (text) => (text.includes(PASSWORD) ? 0.98 : 0.02),
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const h = await createHarnessSession({
			extensionFactories: [
				createJudgeEgressExtension({
					modelRef: MODEL_REF,
					pipeline,
					resolveModel: () => fakeClassifierModel(),
					classify: (_model, context) => fake.classify(context),
				}),
				createEgressMaskingExtension({ pipeline }),
			],
		});
		try {
			h.provider.setScript([{ text: "ok" }, { text: "ok" }]);
			const CLEAN_PROMPT = "just chatting about architecture, no secrets here";
			await h.session.prompt(CLEAN_PROMPT);
			const afterFirst = fake.calls.length; // 首轮：system + user 各一次 gate
			expect(afterFirst).toBeGreaterThanOrEqual(2);
			// 同一干净消息第二轮仅新增新 user 叶的 gate：旧 system/user 叶缓存短路
			await h.session.prompt(CLEAN_PROMPT);
			expect(fake.calls.length).toBe(afterFirst + 1);

			// 非 clean 文本记墓碑：gate 命中文本每轮重判（regex 层零命中也不覆写）
			const callsWithSecret = fake.calls.length;
			h.provider.setScript([{ text: "ok" }, { text: "ok" }]);
			await h.session.prompt(`密码 ${PASSWORD} 但 gate 命中零命中场景`);
			await h.session.prompt(`密码 ${PASSWORD} 但 gate 命中零命中场景`);
			expect(fake.calls.length).toBeGreaterThan(callsWithSecret + 1); // 含重复文本重判
		} finally {
			h.dispose();
		}
	});
});

describe("T8 judge 文本掩码器（createJudgeTextMasker）", () => {
	/** 无 UI 的最小 ctx（降级/故障告警在无 UI 模式仅计数）。 */
	const noUiCtx = { hasUI: false } as unknown as ExtensionContext;

	test("模型缺失 + onMissing=regex_only：降级放行 + 计数 + 墓碑（regex 干净结论不得覆写）", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			pipeline,
			status,
			onMissing: "regex_only", // 显式知情选择：保留降级放行行为
			resolveModel: () => undefined, // classifier 模型不可用
		});
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		const masked = await masker.mask(text, noUiCtx);
		expect(masked).toBe(text); // 降级：judge 层放行（regex 层照常工作）
		expect(status.degradedTexts).toBe(1);
		expect(status.failClosed).toBe(0);
		expect(status.lastResolutionError).toContain("keep-secret-fake/jev-fake");
		// 墓碑：regex 层零命中也不得把该文本写成干净（防 judge 恢复后被缓存短路）
		pipeline.maskText(text);
		expect(pipeline.cleanCache.isClean(text)).toBe(false);
	});

	test("模型缺失 + 默认 fail_closed：未验证候选一律掩码（真值本地保留）+ 计数 + 墓碑", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			pipeline,
			status,
			resolveModel: () => undefined, // classifier 模型不可用
		});
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		const masked = await masker.mask(text, noUiCtx);
		// 与 classify 故障同路径：候选（含判非凭据形状的订单号）未验证 → 一律掩码
		expect(masked).not.toBe(text);
		expect(masked).not.toContain(PASSWORD);
		expect(masked).not.toContain(ORDER);
		const placeholder = masked.match(/key-[A-Z2-7]{12}/)![0];
		expect(pipeline.registry.get(placeholder)).toBe(PASSWORD); // 真值注册表本地可恢复
		expect(status.failClosed).toBe(1);
		expect(status.degradedTexts).toBe(0);
		expect(status.lastResolutionError).toContain("keep-secret-fake/jev-fake");
		// 幂等：掩码后的文本再过一次不得嵌套伪值（已是注册表伪值的候选被过滤）
		const twice = await masker.mask(masked, noUiCtx);
		expect(twice.split(placeholder).length - 1).toBe(masked.split(placeholder).length - 1);
		// 墓碑：regex 层零命中也不得把原文写成干净（防 judge 恢复后被缓存短路）
		pipeline.maskText(text);
		expect(pipeline.cleanCache.isClean(text)).toBe(false);
	});

	test("模型恢复后重判：同一段降级放行过的文本被 judge 掩码（墓碑未被覆写）", async () => {
		const pipeline = createMaskingPipeline();
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		let model: ReturnType<typeof fakeClassifierModel> | undefined;
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			pipeline,
			onMissing: "regex_only", // 本用例锚定降级墓碑与恢复重判的协同
			resolveModel: () => model,
			classify: (_m, context) => fake.classify(context),
		});
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		// 阶段 1：模型缺失 → 降级放行 + 墓碑；regex 层零命中后也不得标记干净
		expect(await masker.mask(text, noUiCtx)).toBe(text);
		pipeline.maskText(text);
		// 阶段 2：模型注册后恢复 → 墓碑保证重判而非缓存短路
		model = fakeClassifierModel();
		const masked = await masker.mask(text, noUiCtx);
		expect(masked).not.toBe(text);
		expect(masked).not.toContain(PASSWORD);
		expect(masked).toMatch(/key-[A-Z2-7]{12}/);
		expect(masked).toContain(ORDER); // 判非凭据：保留
	});

	test("自测复用同一掩码器：judge 先行、regex 兑底，与出站链同序", async () => {
		const pipeline = createMaskingPipeline();
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			pipeline,
			resolveModel: () => fakeClassifierModel(),
			classify: (_m, context) => fake.classify(context),
		});
		const text = `密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`;
		// 出站链同序：judge 先判原文，regex 后兑底（伪值幂等跳过）
		const masked = pipeline.maskText(await masker.mask(text, noUiCtx));
		expect(masked).not.toContain(PASSWORD);
		expect(masked).not.toContain(OPENAI_KEY);
		expect(masked).toMatch(/key-[A-Z2-7]{12}/);
		expect(masked).toMatch(/sk-[A-Z2-7]{12}/);
	});
});

describe("T14 judge 双协议（judge.api 与模型注册 api 一致性）", () => {
	/** 无 UI 的最小 ctx（降级/故障告警在无 UI 模式仅计数与 lastResolutionError）。 */
	const noUiCtx = { hasUI: false } as unknown as ExtensionContext;

	test("api 匹配即装配判定：systemone/typesafe-system-one 与 decisions/openai-decisions 两协议各走通", async () => {
		const pairs = [
			["systemone", "typesafe-system-one"],
			["decisions", "openai-decisions"],
		] as const;
		for (const [api, modelApi] of pairs) {
			const pipeline = createMaskingPipeline();
			const fake = scriptClassify({
				gate: () => 0.98,
				candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
			});
			const masker = createJudgeTextMasker({
				modelRef: MODEL_REF,
				pipeline,
				api, // 配置提示与模型注册 api 一致 → 正常装配
				resolveModel: () => fakeClassifierModel(modelApi),
				classify: (_m, context) => fake.classify(context),
			});
			const masked = await masker.mask(`部署密码 ${PASSWORD}，订单 ${ORDER}`, noUiCtx);
			expect(masked).not.toContain(PASSWORD); // judge 命中 → 伪值
			expect(masked).toContain(ORDER); // 判非凭据：保留
			expect(masker.status.judgedTexts).toBeGreaterThan(0);
			expect(masker.status.degradedTexts).toBe(0);
		}
	});

	test("缺省 api：跟随模型注册条目——两种协议假模型均装配并走通两阶段判定", async () => {
		for (const modelApi of ["typesafe-system-one", "openai-decisions"] as const) {
			const pipeline = createMaskingPipeline();
			const fake = scriptClassify({
				gate: () => 0.98,
				candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
			});
			const masker = createJudgeTextMasker({
				modelRef: MODEL_REF,
				pipeline, // 不传 api：不校验，协议由模型注册条目的 api 字段决定
				resolveModel: () => fakeClassifierModel(modelApi),
				classify: (_m, context) => fake.classify(context),
			});
			const masked = await masker.mask(`部署密码 ${PASSWORD}，订单 ${ORDER}`, noUiCtx);
			expect(masked).not.toContain(PASSWORD);
			expect(masked).toContain(ORDER);
			expect(masked).toMatch(/key-[A-Z2-7]{12}/);
			// 两阶段形态：首轮仅 gate 问，命中后第二批才是候选问
			expect(Object.keys(fake.calls[0]!.questions)).toEqual(["gate"]);
			expect(Object.keys(fake.calls[1]!.questions).every((id) => id.startsWith("cand_"))).toBe(true);
		}
	});

	test("api 不匹配：配置错误语义——不装配 judge（文本原样交 regex 层，不 fail_closed 兑底）、错误可见、墓碑", async () => {
		const pipeline = createMaskingPipeline();
		const status = emptyStatus();
		const fake = scriptClassify({ gate: () => 0.98, candidate: () => 0.96 });
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			pipeline,
			status,
			api: "decisions", // 与模型注册的 typesafe-system-one 不一致
			resolveModel: () => fakeClassifierModel("typesafe-system-one"),
			classify: (_m, context) => fake.classify(context),
		});
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		const masked = await masker.mask(text, noUiCtx);
		expect(masked).toBe(text); // 配置错误 ≠ judge 故障：不走 fail_closed 兑底，文本原样交 regex 层
		expect(status.judgedTexts).toBe(0);
		expect(fake.calls.length).toBe(0); // 未发起任何判定调用
		expect(status.degradedTexts).toBe(1); // 降级按文本叶计数，不静默
		expect(status.lastResolutionError).toContain("decisions");
		expect(status.lastResolutionError).toContain("typesafe-system-one");
		expect(status.lastResolutionError).toContain("keep-secret-fake/jev-fake");
		// 墓碑：regex 层零命中也不得把该文本写成干净（防配置修正后 judge 恢复被缓存短路）
		pipeline.maskText(text);
		expect(pipeline.cleanCache.isClean(text)).toBe(false);
	});
});
