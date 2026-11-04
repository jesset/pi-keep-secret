/**
 * judge 文本掩码器（T8 抽自出站钩子；ADR-0001 起为掩码管线的内聚 judge 层）：
 * 对单段文本做 judge 判定与掩码，返回带结论的 outcome。
 *
 * Clean Verdict 协议（clean = 两层都判干净、墓碑拦截干净写入）自 ADR-0001
 * 起整体归掩码管线（src/masking/pipeline.ts）：本掩码器**不读写 clean
 * cache**，只向管线报告本层结论——`verdict: "clean"`（judge 判定无密钥，
 * 未掩码）/ `"masked"`（已掩码：命中、gate 命中、fail_closed 兜底——
 * 含模型缺失 fail_closed 与 classify 故障）/ `"unverified"`（无法判定：
 * 模型缺失且 onMissing=regex_only 的显式降级放行——该文本永不得记干净）。
 *
 * 模型解析惰性发生在首次 mask（classifier 模型引用来自 config.json 的
 * judge 段）；模型缺失（含解析通道异常）按 `onMissing` 策略处理（spec
 * 故事 19「down judge never means an unmasked request」）：
 * - fail_closed（默认）：与 classify 故障同路径——该文本未验证候选
 *   （engine 抽取）一律掩码（真值由注册表本地保留，可恢复）；
 * - regex_only（显式知情选择）：降级放行——文本原样交后置 regex 阶段，
 *   ctx.ui.notify（有 UI 时）+ 状态栏标记 + JudgeStatus 每请求计数
 *   （无 UI 模式仅计数）。
 *
 * T14（ticket #14）→ T16（ticket #16）：`api` 选项（config.json 的
 * judge.api）是**线缆偏好**而非名称校验——三分支：缺省跟随模型注册
 * 条目的 api 字段；模型注册为 pi-ai 已知 classifier api 时按偏好覆盖
 * 分发线缆（classify 收到浅拷贝仅改 api 的模型）；模型注册为插件
 * 自定义 api（如 litellm-decisions）时尊重插件实现、正常装配，偏好
 * 记为未生效（一次性 info 通知 + 状态面标记）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { extractCandidates, type Span } from "../engine/index.ts";
import type { JudgeApi, JudgeConfig, JudgeOnMissing } from "../config/loader.ts";
import type { PlaceholderRegistry } from "../masking/registry.ts";
import { redactSpansWithRegistry } from "../masking/registry.ts";
import {
	DEFAULT_DETECTOR_NAME,
	createSystemOneJudge,
	type SystemOneJudge,
	type SystemOneJudgeOptions,
} from "./system-one.ts";

/** judge 命中伪值模板默认（参考实现 systemone 检测器 redact_template 示例）。 */
export const DEFAULT_JUDGE_TEMPLATE = "key-{hash}";

/** 告警状态栏键（降级/fail_closed 发生后持续可见，由用户清除）。 */
const STATUS_KEY = "keep-secret-judge";

/**
 * judge.api 偏好值 ↔ pi-ai classifier 模型注册 api（T14 引入，T16 改用途）：
 * 两处分工——loader（config/loader.ts）只校验 judge.api 合法值
 * （systemone|decisions）；本掩码器在模型解析后按三分支应用偏好（见
 * JudgeTextMaskerOptions.api 文档）：模型注册为已知 classifier api 时本映射
 * 给出覆盖分发的目标 api；插件自定义 api 时尊重插件实现、偏好不生效。
 */
export const MODEL_API_BY_JUDGE_API: Record<JudgeApi, string> = {
	systemone: "typesafe-system-one",
	decisions: "openai-decisions",
};

/** pi-ai 已知 classifier 线缆（内置传输）——judge.api 偏好可覆盖的分发目标。
 *  值域即 MODEL_API_BY_JUDGE_API 的映射值（同一拼写单一来源）。 */
const KNOWN_MODEL_APIS = new Set(Object.values(MODEL_API_BY_JUDGE_API));

/** classifier 模型配置引用（provider/modelId；判定模型/端点是配置，规格 #1 故事 34）。 */
export interface ClassifierModelRef {
	provider: string;
	modelId: string;
}

/** 模型解析注入点（缺省 ctx.modelRegistry.findOfType("classifier", ...)）。 */
export type ModelResolver = (
	ctx: ExtensionContext,
	ref: ClassifierModelRef,
) => ClassifierModel<ClassifierApi> | undefined;

/** classify 通道注入点（缺省 ctx.modelRegistry.classify(已解析模型, ...)）。 */
export type ClassifyChannel = (
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
) => Promise<ClassifierResult>;

/** judge 故障与降级状态（/keep-secret 状态面与测试断言用；不静默降级）。 */
export interface JudgeStatus {
	/** classifier 模型解析失败而降级放行的文本叶数（onMissing=regex_only 时
	 *  递增；judge 层不工作、文本交后置 regex 阶段）。 */
	degradedTexts: number;
	/** 最近一次模型解析/协议一致性失败原因（降级与 fail_closed 两路径都记录）。 */
	lastResolutionError: string | undefined;
	/** 已判定文本叶数（至少发起一次 gate）。 */
	judgedTexts: number;
	/** fail_closed 生效（存在未验证候选被兜底掩码）的次数：classify 故障，或
	 *  （onMissing=fail_closed 默认）classifier 模型缺失。 */
	failClosed: number;
	/** 累计被 maxBatches 截断丢弃的候选数（丢弃者按未验证掩码，仅记录）。 */
	truncatedCandidates: number;
}

/** 生效线缆信息（T16：模型解析后定格；/keep-secret 状态面展示用）。
 *  source=registered——缺省偏好，跟随模型注册条目；override——偏好
 *  覆盖分发线缆（已知 classifier api 模型）；plugin——模型注册为插件
 *  自定义 api，线缆由该实现决定（偏好未生效，ineffectivePreference 记录
 *  未生效的偏好值）。 */
export type JudgeWire =
	| { source: "registered"; api: string }
	| { source: "override"; preference: JudgeApi; api: string }
	| { source: "plugin"; api: string; ineffectivePreference: JudgeApi };

/** judge 层对单个文本叶的结论（掩码管线据以维护 Clean Verdict 协议）。 */
export interface JudgeLayerOutcome {
	/** 掩码后的文本（未掩码时为原文）。 */
	text: string;
	/**
	 * clean——judge 判定无密钥且未掩码（可与其他层的干净结论合成 Clean
	 *  Verdict）；masked——已掩码（命中/gate 命中/fail_closed 兜底，记墓
	 *  碑）；unverified——无法判定（模型缺失 regex_only 降级放行，永不得
	 *  记干净，防 judge 恢复后被缓存短路漏判）。
	 */
	verdict: "clean" | "masked" | "unverified";
}

export interface JudgeTextMaskerOptions extends Omit<SystemOneJudgeOptions, "classify"> {
	/** classifier 模型配置引用。 */
	modelRef: ClassifierModelRef;
	/** 会话级伪值注册表（与掩码管线共享同一实例——伪值一致性的事实来源）。 */
	registry: PlaceholderRegistry;
	/** judge 命中伪值模板，默认 "key-{hash}"。 */
	template?: string;
	/** 模型解析注入点（测试替身）。 */
	resolveModel?: ModelResolver;
	/** classify 通道注入点（测试替身）。 */
	classify?: ClassifyChannel;
	/** classifier 模型缺失策略，默认 fail_closed（见 config/loader.ts JudgeOnMissing）。 */
	onMissing?: JudgeOnMissing;
	/** 线缆偏好（config.json 的 judge.api；缺省 undefined 跟随模型注册条目
	 *  的 api 字段。填写时按三分支应用（T16）：模型注册为 pi-ai 已知
	 *  classifier api（typesafe-system-one/openai-decisions）→ 覆盖分发
	 *  线缆（classify 收到 {...model, api: 映射值} 浅拷贝，仅改 api 字段，
	 *  baseUrl/provider/headers 不变，认证按 provider 解析不受影响）；
	 *  模型注册为插件自定义 api → 尊重插件实现（插件作者已选定线缆），
	 *  正常装配 + 偏好未生效一次性 info 通知 + 状态面标记。 */
	api?: JudgeApi;
}

/**
 * judge 文本掩码器：对单段文本做 judge 判定与掩码，返回本层结论。
 * 掩码管线的完整出站入口（mask/maskText）消费它；clean cache 的读写
 * 全部在管线入口（一次查、一次写），本层不触碰。
 */
export interface JudgeTextMasker {
	/** 故障与降级状态（管线 judgeInfo() 快照透出给状态面与自测）。 */
	readonly status: JudgeStatus;
	/** 生效的模型缺失策略（fail_closed / regex_only；状态面与自测期望动态化用）。 */
	readonly onMissing: JudgeOnMissing;
	/** 最近一次 mask 时 classifier 模型是否缺失（自测期望动态化：fail_closed 下
	 *  未验证候选一律掩码，全部样本期望掩码）。 */
	readonly modelMissing: boolean;
	/** 生效线缆（T16：模型解析后定格；解析前 undefined。状态面展示生效
	 *  线缆与偏好未生效标记）。 */
	readonly wire: JudgeWire | undefined;
	/** 判定并掩码一段文本；模型缺失按 onMissing 策略（默认 fail_closed 掩码，
	 *  regex_only 降级放行交 regex 阶段）。不读写 clean cache。 */
	mask(text: string, ctx: ExtensionContext): Promise<JudgeLayerOutcome>;
}

const defaultResolveModel: ModelResolver = (ctx, ref) =>
	ctx.modelRegistry.findOfType("classifier", ref.provider, ref.modelId);

/** 创建 judge 文本掩码器（模型缺失不抛错——按 onMissing 策略 fail_closed 或降级）。 */
export function createJudgeTextMasker(options: JudgeTextMaskerOptions): JudgeTextMasker {
	const { modelRef, registry } = options;
	const onMissing: JudgeOnMissing = options.onMissing ?? "fail_closed";
	const minCandidateLength = options.minCandidateLength ?? 6;
	const status: JudgeStatus = {
		degradedTexts: 0,
		lastResolutionError: undefined,
		judgedTexts: 0,
		failClosed: 0,
		truncatedCandidates: 0,
	};
	const detectorName = options.detectorName ?? DEFAULT_DETECTOR_NAME;
	const template = options.template ?? DEFAULT_JUDGE_TEMPLATE;
	const templates = new Map([[detectorName, template]]);

	let judge: SystemOneJudge | undefined;
	let notifiedModelMissing = false;
	let notifiedApiPreference = false;
	let notifiedError: string | undefined;
	let modelMissing = false;
	let wire: JudgeWire | undefined;

	/** 模型缺失的 fail_closed 兜底：与 classify 故障同路径——该文本抽取出的
	 *  候选未获判定结论，一律掩码（与 regex 阶段共享掩码尾段，幂等过滤已是
	 *  伪值的候选，防嵌套）。 */
	const maskUnverifiedLocally = (text: string): string => {
		const spans: Span[] = extractCandidates(text, minCandidateLength).map((candidate) => ({
			start: candidate.start,
			end: candidate.end,
			detector: detectorName,
		}));
		return redactSpansWithRegistry(text, spans, registry, templates).text;
	};

	const mask = async (text: string, ctx: ExtensionContext): Promise<JudgeLayerOutcome> => {
		if (judge === undefined) {
			let model: ClassifierModel<ClassifierApi> | undefined;
			let resolutionError: string | undefined;
			try {
				model = (options.resolveModel ?? defaultResolveModel)(ctx, modelRef);
			} catch (error) {
				// 解析通道异常与模型缺失同语义：按 onMissing 策略处理（不静默、不中断掩码链）
				resolutionError = `classifier 模型解析失败：${
					error instanceof Error ? error.message : String(error)
				}`;
			}
			if (model === undefined) {
				modelMissing = true;
				status.lastResolutionError =
					resolutionError ?? `classifier 模型未注册：${modelRef.provider}/${modelRef.modelId}`;
				if (!notifiedModelMissing) {
					notifiedModelMissing = true;
					if (ctx.hasUI) {
						ctx.ui.notify(
							onMissing === "regex_only"
								? `pi-keep-secret: judge classifier model ${modelRef.provider}/${modelRef.modelId} is not registered (onMissing=regex_only) — outbound masking runs on the regex layer only`
								: `pi-keep-secret: judge classifier model ${modelRef.provider}/${modelRef.modelId} is not registered — fail_closed is active (every unverified candidate is masked). Register the classifier model, or set judge.onMissing="regex_only" explicitly`,
							"warning",
						);
						ctx.ui.setStatus(
							STATUS_KEY,
							onMissing === "regex_only"
								? "pi-keep-secret judge degraded (regex layer only)"
								: "pi-keep-secret judge fail_closed (classifier model missing)",
						);
					}
				}
				if (onMissing === "regex_only") {
					// 显式知情选择：降级放行（后置 regex 阶段继续工作）+ 计数；
					// 结论 unverified——管线据此记墓碑，防 judge 恢复后被缓存短路
					status.degradedTexts += 1;
					return { text, verdict: "unverified" };
				}
				// fail_closed（默认）：模型缺失与 classify 故障同路径——未验证候选
				// 一律掩码（真值注册表本地保留）
				status.failClosed += 1;
				return { text: maskUnverifiedLocally(text), verdict: "masked" };
			}
			// T16 三分支线缆偏好（彻底移除「不一致 → 不装配」硬校验——
			// modelRegistry.classify 本身按 model.api 正确分发，名称检查只会
			// 误杀插件注册的 classifier 模型）：
			// 1) 缺省偏好 → 跟随模型注册条目的 api 字段；
			// 2) 偏好 + 模型注册为 pi-ai 已知 classifier api → 覆盖分发线缆
			//    （浅拷贝仅改 api 字段，baseUrl/provider/headers 不变）；
			// 3) 偏好 + 模型注册为插件自定义 api → 尊重插件实现（插件作者已
			//    选定线缆），正常装配 + 偏好未生效一次性 info 通知（非错误、
			//    非降级：不减分、不占状态栏）+ 状态面 wire 标记。
			let effectiveModel = model;
			if (options.api === undefined) {
				wire = { source: "registered", api: model.api };
			} else if (KNOWN_MODEL_APIS.has(model.api)) {
				const preferredApi = MODEL_API_BY_JUDGE_API[options.api];
				if (model.api !== preferredApi) {
					effectiveModel = { ...model, api: preferredApi };
				}
				wire = { source: "override", preference: options.api, api: preferredApi };
			} else {
				wire = { source: "plugin", api: model.api, ineffectivePreference: options.api };
				if (!notifiedApiPreference) {
					notifiedApiPreference = true;
					if (ctx.hasUI) {
						ctx.ui.notify(
							`pi-keep-secret: judge.api preference "${options.api}" has no effect — model ${modelRef.provider}/${modelRef.modelId} is registered with the custom api "${model.api}", so the plugin implementation picks the wire (judge is wired normally)`,
							"info",
						);
					}
				}
			}
			// classify 通道绑定首次解析到的 modelRegistry 与模型（会话生命周期稳定）
			modelMissing = false;
			const channel: ClassifyChannel =
				options.classify ?? ((m, context) => ctx.modelRegistry.classify(m, context));
			judge = createSystemOneJudge({
				...options,
				detectorName,
				classify: (context) => channel(effectiveModel, context),
			});
		}
		const activeJudge = judge;
		const verdict = await activeJudge.judgeText(text);
		status.judgedTexts += 1;
		if (verdict.failClosed) {
			status.failClosed += 1;
			if (verdict.error !== undefined && verdict.error !== notifiedError) {
				notifiedError = verdict.error;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`pi-keep-secret: judge failure, fail_closed is active (every unverified candidate is masked) — ${verdict.error}`,
						"warning",
					);
					ctx.ui.setStatus(STATUS_KEY, "pi-keep-secret judge fail_closed");
				}
			}
		}
		status.truncatedCandidates += verdict.truncatedCandidates;
		if (!verdict.clean) {
			// 非 clean 结论（命中/gate 命中/fail_closed）：掩码 span，结论 masked
			// ——管线据此记墓碑（永不缓存干净、每轮重判）
			// 幂等与签发在共享尾段内完成（redactSpansWithRegistry：已是本注册表
			// 伪值的命中跳过，防嵌套；与 regex 阶段同语义）
			return { text: redactSpansWithRegistry(text, verdict.spans, registry, templates).text, verdict: "masked" };
		}
		return { text, verdict: "clean" };
	};

	return {
		status,
		onMissing,
		get modelMissing() { return modelMissing; },
		get wire() { return wire; },
		mask,
	};
}

/** judge 配置段（config.json 的 judge 段）→ 掩码器选项映射（阈值/批参/并发/
 *  模板全部来自配置；注入点透传）。由掩码管线构造时消费（ADR-0001：judge
 *  创建内聚进管线构造）；api 为线缆偏好（T16），模型解析后按三分支应用。 */
export function createJudgeTextMaskerFor(
	config: JudgeConfig,
	deps: {
		registry: PlaceholderRegistry;
		resolveModel?: ModelResolver;
		classify?: ClassifyChannel;
	},
): JudgeTextMasker {
	return createJudgeTextMasker({
		modelRef: { provider: config.provider, modelId: config.modelId },
		registry: deps.registry,
		gateThreshold: config.gateThreshold,
		candidateThreshold: config.candidateThreshold,
		batchSize: config.batchSize,
		maxBatches: config.maxBatches,
		maxChars: config.maxChars,
		minCandidateLength: config.minCandidateLength,
		concurrency: config.concurrency,
		template: config.redactTemplate,
		onMissing: config.onMissing,
		api: config.api,
		resolveModel: deps.resolveModel,
		classify: deps.classify,
	});
}
