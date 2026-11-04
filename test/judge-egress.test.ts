/**
 * ticket #7 验收用例（接缝 1）：judge 出站扩展在进程内 pi 会话的
 * context_with_system 链上工作——classifier 模型解析、judge span 掩码、
 * 模型缺失降级（仅 regex 层 + 状态计数不静默）与 fail_closed 全链路。
 *
 * 假 classifier 方案（研究笔记 §4）：适配器逻辑已在 src/judge/system-one.test.ts
 * 以注入 ClassifyFn 的纯替身覆盖；本文件在管线的两个注入点（resolveModel/
 * classify）挂进程内替身驱动完整钩子链，概率脚本锚定真实网关实测校准数字
 * （§1：中文句中密码 0.96 掩码 / 订单号 0.04 丢弃 / gate 0.98）。真实网关
 * 验证见 research/systemone-gateway.test.ts（默认跳过，环境变量启用）。
 * ADR-0001：出站为单扩展单次遍历，消费管线统一入口（judge→regex 组合内聚
 * 管线）；测试装配只建一个 judged 管线 + 单出站扩展。
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";
import { createJudgeTextMasker, type ClassifierModelRef } from "../src/judge/index.ts";
import {
	createEgressMaskingExtension,
	createMaskingPipeline,
	createPlaceholderRegistry,
} from "../src/masking/index.ts";
import { fakeClassifierModel, scriptClassify } from "./helpers.ts";

/** judge 命中锚（真实网关实测 0.96 掩码）与非凭据锚（0.04 丢弃）。 */
const PASSWORD = "N0Judged-K3y9wq";
const ORDER = "1029384756";
/** regex 层锚（内置默认检测器；降级用例证明 regex 照常工作）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";

const MODEL_REF: ClassifierModelRef = { provider: "keep-secret-fake", modelId: "jev-fake" };

describe("T5 judge 出站扩展（接缝 1）", () => {
	test("模型在位：judge 命中出站只见 key-{hash} 伪值，非凭据保留，regex 层共存", async () => {
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: MODEL_REF.provider, modelId: MODEL_REF.modelId },
				resolveModel: () => fakeClassifierModel(),
				classify: (_model, context) => fake.classify(context),
			},
		});
		const status = pipeline.judgeInfo()!.status;
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
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
		// 缺省 resolveModel → ctx.modelRegistry.findOfType("classifier", ...)
		// harness 注册表没有该模型 → 模型缺失路径（spec 故事 19：down
		// judge never means an unmasked request——与 classify 故障同则）
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: "no-such-provider", modelId: "no-such-model" },
			},
		});
		const status = pipeline.judgeInfo()!.status;
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
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
		const pipeline = createMaskingPipeline({
			judge: {
				config: {
					provider: "no-such-provider",
					modelId: "no-such-model",
					onMissing: "regex_only",
				},
			},
		});
		const status = pipeline.judgeInfo()!.status;
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
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
		const fake = scriptClassify({ gate: () => 0.98, candidate: () => 0.96, error: true });
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: MODEL_REF.provider, modelId: MODEL_REF.modelId },
				resolveModel: () => fakeClassifierModel(),
				classify: (_model, context) => fake.classify(context),
			},
		});
		const status = pipeline.judgeInfo()!.status;
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
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
		const fake = scriptClassify({
			gate: () => 0.02, // 干净文本：每叶一次 gate 后短路
			candidate: () => 0.02,
			stall: () => new Promise((resolve) => setTimeout(resolve, 10)),
		});
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: MODEL_REF.provider, modelId: MODEL_REF.modelId },
				resolveModel: () => fakeClassifierModel(),
				classify: (_model, context) => fake.classify(context),
			},
		});
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
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
		const fake = scriptClassify({
			gate: (text) => (text.includes(PASSWORD) ? 0.98 : 0.02),
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: MODEL_REF.provider, modelId: MODEL_REF.modelId },
				resolveModel: () => fakeClassifierModel(),
				classify: (_model, context) => fake.classify(context),
			},
		});
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
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

describe("T8 judge 文本掩码器（经管线统一入口）", () => {
	/** 无 UI 的最小 ctx（降级/故障告警在无 UI 模式仅计数）。 */
	const noUiCtx = { hasUI: false } as unknown as ExtensionContext;

	test("模型缺失 + onMissing=regex_only：降级放行 + 计数 + 墓碑（未写成干净，每轮重走 judge 层）", async () => {
		const registry = createPlaceholderRegistry();
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			registry,
			onMissing: "regex_only", // 显式知情选择：保留降级放行行为
			resolveModel: () => undefined, // classifier 模型不可用
		});
		const pipeline = createMaskingPipeline({ registry, judge: { masker } });
		const status = pipeline.judgeInfo()!.status;
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		expect(await pipeline.mask(text, noUiCtx)).toBe(text); // 降级：judge 层放行（regex 阶段照常工作）
		expect(status.degradedTexts).toBe(1);
		expect(status.failClosed).toBe(0);
		expect(status.lastResolutionError).toContain("keep-secret-fake/jev-fake");
		// 墓碑（行为断言，ADR-0001）：降级放行过、regex 零命中的文本不得被
		// 写成干净——第二次 mask 仍重走 judge 层（非缓存短路）
		expect(await pipeline.mask(text, noUiCtx)).toBe(text);
		expect(status.degradedTexts).toBe(2);
	});

	test("模型缺失 + 默认 fail_closed：未验证候选一律掩码（真值本地保留）+ 计数 + 墓碑", async () => {
		const registry = createPlaceholderRegistry();
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			registry,
			resolveModel: () => undefined, // classifier 模型不可用
		});
		const pipeline = createMaskingPipeline({ registry, judge: { masker } });
		const status = pipeline.judgeInfo()!.status;
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		const masked = await pipeline.mask(text, noUiCtx);
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
		const twice = await pipeline.mask(masked, noUiCtx);
		expect(twice.split(placeholder).length - 1).toBe(masked.split(placeholder).length - 1);
		expect(status.failClosed).toBe(2); // 每次完整掩码都经 fail_closed 兜底（含幂等重过）
		// 墓碑（行为断言）：原文每轮重判（failClosed 递增），未被缓存短路
		await pipeline.mask(text, noUiCtx);
		expect(status.failClosed).toBe(3);
	});

	test("模型恢复后重判：同一段降级放行过的文本被 judge 掩码（墓碑未被覆写）", async () => {
		const registry = createPlaceholderRegistry();
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		let model: ReturnType<typeof fakeClassifierModel> | undefined;
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			registry,
			onMissing: "regex_only", // 本用例锚定降级墓碑与恢复重判的协同
			resolveModel: () => model,
			classify: (_m, context) => fake.classify(context),
		});
		const pipeline = createMaskingPipeline({ registry, judge: { masker } });
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		// 阶段 1：模型缺失 → 降级放行 + 墓碑（regex 零命中也不得标记干净）
		expect(await pipeline.mask(text, noUiCtx)).toBe(text);
		// 阶段 2：模型注册后恢复 → 墓碑保证重判而非缓存短路
		model = fakeClassifierModel();
		const masked = await pipeline.mask(text, noUiCtx);
		expect(masked).not.toBe(text);
		expect(masked).not.toContain(PASSWORD);
		expect(masked).toMatch(/key-[A-Z2-7]{12}/);
		expect(masked).toContain(ORDER); // 判非凭据：保留
	});

	test("统一出站入口：单次 mask 即双层结果（judge 先行、regex 兑底，与出站链同一入口）", async () => {
		const registry = createPlaceholderRegistry();
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			registry,
			resolveModel: () => fakeClassifierModel(),
			classify: (_m, context) => fake.classify(context),
		});
		const pipeline = createMaskingPipeline({ registry, judge: { masker } });
		const text = `密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`;
		// 出站链同一入口：一次调用完成 judge 判原文 + regex 兑底（伪值幂等跳过）
		const masked = await pipeline.mask(text, noUiCtx);
		expect(masked).not.toContain(PASSWORD);
		expect(masked).not.toContain(OPENAI_KEY);
		expect(masked).toMatch(/key-[A-Z2-7]{12}/);
		expect(masked).toMatch(/sk-[A-Z2-7]{12}/);
	});
});

describe("T16 judge.api 线缆偏好（三分支装配，无名称硬校验）", () => {
	/** 无 UI 的最小 ctx（告警在无 UI 模式仅计数与 lastResolutionError）。 */
	const noUiCtx = { hasUI: false } as unknown as ExtensionContext;

	/** 有 UI 的最小 ctx：记录 notify/setStatus 调用（偏好未生效 info 通知断言用）。 */
	function uiCtx() {
		const notifications: { message: string; type?: string }[] = [];
		const statusKeys: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				setStatus: (key: string) => statusKeys.push(key),
			},
		} as unknown as ExtensionContext;
		return { ctx, notifications, statusKeys };
	}

	test("分支 1（缺省 api）：跟随模型注册条目——两种协议假模型均装配并走通两阶段判定", async () => {
		for (const modelApi of ["typesafe-system-one", "openai-decisions"] as const) {
			const registry = createPlaceholderRegistry();
			const fake = scriptClassify({
				gate: () => 0.98,
				candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
			});
			const masker = createJudgeTextMasker({
				modelRef: MODEL_REF,
				registry, // 不传 api：跟随模型注册条目的 api 字段（线缆由注册决定）
				resolveModel: () => fakeClassifierModel(modelApi),
				classify: (_m, context) => fake.classify(context),
			});
			const { text: masked } = await masker.mask(
				`部署密码 ${PASSWORD}，订单 ${ORDER}`,
				noUiCtx,
			);
			expect(masked).not.toContain(PASSWORD);
			expect(masked).toContain(ORDER);
			expect(masked).toMatch(/key-[A-Z2-7]{12}/);
			// 两阶段形态：首轮仅 gate 问，命中后第二批才是候选问
			expect(Object.keys(fake.calls[0]!.questions)).toEqual(["gate"]);
			expect(Object.keys(fake.calls[1]!.questions).every((id) => id.startsWith("cand_"))).toBe(true);
			expect(masker.wire).toEqual({ source: "registered", api: modelApi });
		}
	});

	test("分支 2（已知 classifier api + 偏好）：分发覆盖——classify 收到的 model.api 恒为偏好映射值", async () => {
		// 三个子形态：偏好与注册一致（覆盖为幂等）× 1、偏好覆盖另一线缆 × 2
		const cases = [
			{ api: "systemone", modelApi: "typesafe-system-one", classifyApi: "typesafe-system-one" },
			{ api: "systemone", modelApi: "openai-decisions", classifyApi: "typesafe-system-one" },
			{ api: "decisions", modelApi: "typesafe-system-one", classifyApi: "openai-decisions" },
		] as const;
		for (const { api, modelApi, classifyApi } of cases) {
			const registry = createPlaceholderRegistry();
			const fake = scriptClassify({
				gate: () => 0.98,
				candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
			});
			const seenApis: string[] = [];
			const masker = createJudgeTextMasker({
				modelRef: MODEL_REF,
				registry,
				api, // 配置选择线缆：classify 分发走偏好映射的 pi-ai 传输
				resolveModel: () => fakeClassifierModel(modelApi),
				classify: (m, context) => {
					seenApis.push(m.api);
					return fake.classify(context);
				},
			});
			const { text: masked } = await masker.mask(
				`部署密码 ${PASSWORD}，订单 ${ORDER}`,
				noUiCtx,
			);
			expect(masked).not.toContain(PASSWORD); // 覆盖线缆照常判定掩码
			expect(masked).toContain(ORDER);
			expect(masker.status.judgedTexts).toBeGreaterThan(0);
			expect(masker.status.degradedTexts).toBe(0); // 覆盖非降级、非错误
			expect(seenApis.length).toBeGreaterThan(0);
			expect(new Set(seenApis)).toEqual(new Set([classifyApi])); // 断言 classify 收到的 model.api 为覆盖值
			expect(masker.wire).toEqual({ source: "override", preference: api, api: classifyApi });
		}
	});

	test("分支 3（插件自定义 api + 偏好）：尊重插件实现——正常装配掩码 + 一次性 info 通知 + 偏好未生效标记", async () => {
		const registry = createPlaceholderRegistry();
		const fake = scriptClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const seenApis: string[] = [];
		const { ctx, notifications, statusKeys } = uiCtx();
		const masker = createJudgeTextMasker({
			modelRef: MODEL_REF,
			registry,
			api: "systemone", // 用户现场场景（#16）：插件注册的自定义 api，偏好不生效但正常装配
			resolveModel: () => fakeClassifierModel("litellm-decisions"),
			classify: (m, context) => {
				seenApis.push(m.api);
				return fake.classify(context);
			},
		});
		const text = `部署密码 ${PASSWORD}，订单 ${ORDER}`;
		const { text: masked } = await masker.mask(text, ctx);
		expect(masked).not.toContain(PASSWORD); // 正常装配：judge 判定掩码照常
		expect(masked).toContain(ORDER);
		expect(masked).toMatch(/key-[A-Z2-7]{12}/);
		expect(masker.status.judgedTexts).toBeGreaterThan(0);
		expect(masker.status.degradedTexts).toBe(0); // 非错误、非降级
		expect(masker.status.failClosed).toBe(0);
		expect(seenApis.length).toBeGreaterThan(0);
		expect(new Set(seenApis)).toEqual(new Set(["litellm-decisions"])); // 模型原样（插件实现不被改写）
		// 一次性 info 通知：偏好未生效，线缆由插件实现决定
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.type).toBe("info");
		expect(notifications[0]!.message).toContain("systemone");
		expect(notifications[0]!.message).toContain("litellm-decisions");
		expect(notifications[0]!.message).toContain("has no effect");
		expect(statusKeys).toEqual([]); // 非降级不占状态栏
		// 状态面标记：生效线缆为插件自定义名 + 偏好未生效
		expect(masker.wire).toEqual({
			source: "plugin",
			api: "litellm-decisions",
			ineffectivePreference: "systemone",
		});
		// 同一掩码器的后续文本不重复通知（一次性）
		await masker.mask(`再说一次 ${PASSWORD}`, ctx);
		expect(notifications).toHaveLength(1);
	});
});

describe("T20 placeholder form unification (first-issuer-wins, #21)", () => {
	// One secret must never reach the provider in two different placeholder
	// forms: whichever detection path issues first (judge leaf or regex leaf)
	// pins the form and the other path reuses it. Pre-T20 a judge-hit leaf
	// issued key-{hash} while a regex-hit leaf issued sk-{hash} for the same
	// secret, so the model saw both forms in one request.

	test("one secret, one form per request: whichever layer issues first pins it (concurrent leaves)", async () => {
		const fake = scriptClassify({
			// Gate by leaf content: the system leaf (GATEHIT) is judged and masks
			// the secret (first issuance); the user leaf passes to the regex layer.
			gate: (text) => (text.includes("GATEHIT") ? 0.98 : 0.02),
			candidate: (value) => (value === OPENAI_KEY ? 0.96 : 0.04),
		});
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: MODEL_REF.provider, modelId: MODEL_REF.modelId },
				resolveModel: () => fakeClassifierModel(),
				classify: (_model, context) => fake.classify(context),
			},
		});
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
			cwdFiles: {
				"AGENTS.md": `# Project rules\n\nDeploy key (GATEHIT): ${OPENAI_KEY}\n`,
			},
		});
		try {
			h.provider.setScript([{ text: "ack" }]);
			await h.session.prompt(`internal audit note: the shared key ${OPENAI_KEY} stays private`);

			const out = requestText(h.provider.requests()[0]);
			expect(out).not.toContain(OPENAI_KEY);
			// Leaves are masked concurrently (message-level concurrency), so
			// which layer issues first — the judged system leaf or the regex-only
			// user leaf — is genuinely racy. The invariant the registry guarantees
			// is: ONE form per secret. Both leaves carry the same placeholder and
			// the other template's form never appears in the request.
			const forms = out.match(/(?:key|sk)-[A-Z2-7]{12}/g);
			expect(forms).not.toBeNull();
			expect(forms).toHaveLength(2); // system leaf + user leaf
			expect(new Set(forms).size).toBe(1); // exactly one form for one secret
			expect(pipeline.registry.get(forms![0]!)).toBe(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("regex-hit leaf pins the form; a judge-hit leaf in a later turn reuses it", async () => {
		const fake = scriptClassify({
			gate: (text) => (text.includes("GATEHIT") ? 0.98 : 0.02),
			candidate: (value) => (value === OPENAI_KEY ? 0.96 : 0.04),
		});
		const pipeline = createMaskingPipeline({
			judge: {
				config: { provider: MODEL_REF.provider, modelId: MODEL_REF.modelId },
				resolveModel: () => fakeClassifierModel(),
				classify: (_model, context) => fake.classify(context),
			},
		});
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ pipeline })],
		});
		try {
			h.provider.setScript([{ text: "ok" }, { text: "ok" }]);
			// Turn 1: the judge gate misses the secret; only the regex layer sees
			// it, so sk-{hash} is the first-issued form.
			await h.session.prompt(`internal audit note: the shared key ${OPENAI_KEY} stays private`);
			// Turn 2: the judge gate hits the same secret on a new leaf; the judge
			// masker must reuse the regex-issued form instead of key-{hash}.
			await h.session.prompt(`GATEHIT deploy with the shared key ${OPENAI_KEY}`);

			const out = requestText(h.provider.requests()[1]);
			expect(out).not.toContain(OPENAI_KEY);
			const forms = out.match(/sk-[A-Z2-7]{12}/g);
			expect(forms).not.toBeNull();
			expect(new Set(forms).size).toBe(1);
			expect(forms).toHaveLength(2); // turn-1 leaf + turn-2 leaf
			expect(out).not.toMatch(/key-[A-Z2-7]{12}/);
			expect(pipeline.registry.get(forms![0]!)).toBe(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});
});
