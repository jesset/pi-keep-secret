/**
 * System One judge 出站扩展（ticket #7 / T5）：regex 之外的检测器。
 *
 * 注册 `context_with_system`，对消息树文本叶做 judge 两阶段判定并把命中/
 * fail_closed 兜底 span 掩码为确定性伪值（经共享管线注册表签发，同一真值
 * 恒同一伪值——出站、回程还原、掩码压缩共用同一映射）。
 *
 * 注册顺序契约：本扩展必须先于 regex 出站扩展（createEgressMaskingExtension）
 * 注册——judge 判定需要原文；regex 层对已签发伪值幂等跳过，两层串联安全。
 *
 * classifier 模型解析：配置引用（provider/modelId；T8 起由 config.json 的
 * judge 段驱动正式组合接线，装配方亦可显式传入）→
 * `ctx.modelRegistry.findOfType("classifier", ...)`。
 * 模型缺失（含解析通道异常）→ 按 `onMissing` 策略处理（spec 故事 19
 * 「down judge never means an unmasked request」）：
 * - fail_closed（默认）：与 classify 故障同路径——该消息未验证候选
 *   （engine 抽取）一律掩码（真值由注册表本地保留，可恢复）；
 * - regex_only（显式知情选择）：降级放行——文本原样交后置 regex 层，
 *   ctx.ui.notify（有 UI 时）+ 状态栏标记 + JudgeStatus 每请求计数
 *   （无 UI 模式仅计数）。
 *
 * fail_closed：judge verdict 中未验证候选已并入 spans 掩码（真值由注册表
 * 本地保留，可恢复）；classify 错误计入状态并（有 UI 时）告警。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { extractCandidates, type Span } from "../engine/index.ts";
import type { JudgeOnMissing } from "../config/loader.ts";
import type { MaskingPipeline } from "../masking/index.ts";
import { maskMessageTreeAsync, redactSpansWithRegistry } from "../masking/index.ts";
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
	 *  递增；该类叶仅 regex 层工作）。 */
	degradedTexts: number;
	/** 最近一次模型解析失败原因（fail_closed / regex_only 两策略都记录）。 */
	lastResolutionError: string | undefined;
	/** 已判定文本叶数（至少发起一次 gate）。 */
	judgedTexts: number;
	/** fail_closed 生效（存在未验证候选被兜底掩码）的次数：classify 故障，或
	 *  （onMissing=fail_closed 默认）classifier 模型缺失。 */
	failClosed: number;
	/** 累计被 maxBatches 截断丢弃的候选数（丢弃者按未验证掩码，仅记录）。 */
	truncatedCandidates: number;
}

export interface JudgeEgressOptions extends Omit<SystemOneJudgeOptions, "classify"> {
	/** classifier 模型配置引用。 */
	modelRef: ClassifierModelRef;
	/** 会话级掩码管线（与 regex 出站/回程还原/压缩共享同一注册表）。 */
	pipeline: MaskingPipeline;
	/** 故障与降级状态（缺省随工厂新建）；需要观测的调用方传入。 */
	status?: JudgeStatus;
	/** judge 命中伪值模板，默认 "key-{hash}"。 */
	template?: string;
	/** 模型解析注入点（测试替身）。 */
	resolveModel?: ModelResolver;
	/** classify 通道注入点（测试替身）。 */
	classify?: ClassifyChannel;
	/**
	 * 复用既有掩码器（T8 组合根与命令面共享同一实例/状态时传入；
	 * 提供时本扩展直接使用它，其余 judge 选项由掩码器创建方 consumed）。
	 */
	masker?: JudgeTextMasker;
	/** classifier 模型缺失策略，默认 fail_closed（见 config/loader.ts JudgeOnMissing）。 */
	onMissing?: JudgeOnMissing;
}

const defaultResolveModel: ModelResolver = (ctx, ref) =>
	ctx.modelRegistry.findOfType("classifier", ref.provider, ref.modelId);

/**
 * judge 文本掩码器（T8 抽自出站钩子）：对单段文本做 judge 判定与掩码。
 * 出站钩子与 /keep-secret 自测共用同一实例（同一状态计数与 clean cache
 * 协同）。
 *
 * 模型缺失按 onMissing 策略处理：regex_only（显式知情选择）——文本原样
 * 放行（后置 regex 层继续工作）+ 状态计数；fail_closed（默认）——未验证
 * 候选一律掩码（与 classify 故障同路径）。两策略都记**墓碑**——该文本
 * 不得被 regex 层的零命中结论写成干净，否则 judge 恢复后会被 clean cache
 * 短路而漏判（clean = 两层都过）。
 */
export interface JudgeTextMasker {
	/** 故障与降级状态（/keep-secret 状态面与组合根共享同一实例）。 */
	readonly status: JudgeStatus;
	/** 生效的模型缺失策略（fail_closed / regex_only；状态面与自测期望动态化用）。 */
	readonly onMissing: JudgeOnMissing;
	/** 最近一次 mask 时 classifier 模型是否缺失（自测期望动态化：fail_closed 下
	 *  未验证候选一律掩码，全部样本期望掩码）。 */
	readonly modelMissing: boolean;
	/** 对一段文本判定并掩码；模型缺失按 onMissing 策略（默认 fail_closed 掩码，
	 *  regex_only 原样返回交 regex 层）。 */
	mask(text: string, ctx: ExtensionContext): Promise<string>;
}

/** 创建 judge 文本掩码器（模型缺失不抛错——按 onMissing 策略 fail_closed 或降级）。 */
export function createJudgeTextMasker(options: JudgeEgressOptions): JudgeTextMasker {
	const { modelRef, pipeline } = options;
	const onMissing: JudgeOnMissing = options.onMissing ?? "fail_closed";
	const minCandidateLength = options.minCandidateLength ?? 6;
	const status: JudgeStatus = options.status ?? {
		degradedTexts: 0,
		lastResolutionError: undefined,
		judgedTexts: 0,
		failClosed: 0,
		truncatedCandidates: 0,
	};
	const detectorName = options.detectorName ?? DEFAULT_DETECTOR_NAME;
	const template = options.template ?? DEFAULT_JUDGE_TEMPLATE;
	const templates = new Map([[detectorName, template]]);
	const registry = pipeline.registry;

	let judge: SystemOneJudge | undefined;
	let notifiedModelMissing = false;
	let notifiedError: string | undefined;
	let modelMissing = false;

	/** 模型缺失的 fail_closed 兜底：与 classify 故障同路径——该文本抽取出的
	 *  候选未获判定结论，一律掩码（与 regex 管线共享掩码尾段，幂等过滤已是
	 *  伪值的候选，防嵌套）。 */
	const maskUnverifiedLocally = (text: string): string => {
		const spans: Span[] = extractCandidates(text, minCandidateLength).map((candidate) => ({
			start: candidate.start,
			end: candidate.end,
			detector: detectorName,
		}));
		return redactSpansWithRegistry(text, spans, registry, templates).text;
	};

	const mask = async (text: string, ctx: ExtensionContext): Promise<string> => {
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
								? `pi-keep-secret: judge classifier 模型 ${modelRef.provider}/${modelRef.modelId} 未注册（onMissing=regex_only），出站仅 regex 检测层工作`
								: `pi-keep-secret: judge classifier 模型 ${modelRef.provider}/${modelRef.modelId} 未注册，已 fail_closed（未验证候选一律掩码）——请注册该 classifier 模型，或显式配置 judge.onMissing="regex_only"`,
							"warning",
						);
						ctx.ui.setStatus(
							STATUS_KEY,
							onMissing === "regex_only"
								? "pi-keep-secret judge 已降级（仅 regex 检测）"
								: "pi-keep-secret judge fail_closed（classifier 模型缺失）",
						);
					}
				}
				if (onMissing === "regex_only") {
					// 显式知情选择：降级放行（后置 regex 出站扩展继续工作）+ 计数；
					// 墓碑防 judge 恢复后被 clean cache 短路
					status.degradedTexts += 1;
					pipeline.cleanCache.remember(text, { hasSecret: true });
					return text;
				}
				// fail_closed（默认）：模型缺失与 classify 故障同路径——未验证候选
				// 一律掩码（真值注册表本地保留）；已判干净（两层都过）的文本不重复兜底
				if (pipeline.cleanCache.isClean(text)) {
					return text;
				}
				status.failClosed += 1;
				pipeline.cleanCache.remember(text, { hasSecret: true }); // 墓碑同记
				return maskUnverifiedLocally(text);
			}
			// classify 通道绑定首次解析到的 modelRegistry 与模型（会话生命周期稳定）
			modelMissing = false;
			const channel: ClassifyChannel =
				options.classify ?? ((m, context) => ctx.modelRegistry.classify(m, context));
			judge = createSystemOneJudge({
				...options,
				detectorName,
				classify: (context) => channel(model, context),
			});
		}
		const activeJudge = judge;
		// clean cache 协同（T4）：已判干净的文本不再发起 gate（短路）；
		// 干净条目由后置 regex 层零命中时写入（clean = 两层都过）。
		if (pipeline.cleanCache.isClean(text)) {
			return text;
		}
		const verdict = await activeJudge.judgeText(text);
		status.judgedTexts += 1;
		if (verdict.failClosed) {
			status.failClosed += 1;
			if (verdict.error !== undefined && verdict.error !== notifiedError) {
				notifiedError = verdict.error;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`pi-keep-secret: judge 故障已 fail_closed（未验证候选一律掩码）——${verdict.error}`,
						"warning",
					);
					ctx.ui.setStatus(STATUS_KEY, "pi-keep-secret judge fail_closed 已生效");
				}
			}
		}
		status.truncatedCandidates += verdict.truncatedCandidates;
		// 非 clean 结论（命中/gate 命中/fail_closed）记墓碑：永不缓存干净，
		// 且拦截后置 regex 层对同一文本的干净写入——每轮重判
		if (!verdict.clean) {
			pipeline.cleanCache.remember(text, { hasSecret: true });
		}
		// 幂等与签发在共享尾段内完成（redactSpansWithRegistry：已是本注册表
		// 伪值的命中跳过，防嵌套；与 regex 管线同语义）
		return redactSpansWithRegistry(text, verdict.spans, registry, templates).text;
	};

	return { status, onMissing, get modelMissing() { return modelMissing; }, mask };
}

/** 创建 judge 出站扩展（ExtensionFactory）。模型缺失不抛错——按 onMissing 策略
 *  fail_closed（默认）或显式降级 regex_only。 */
export function createJudgeEgressExtension(options: JudgeEgressOptions) {
	const masker = options.masker ?? createJudgeTextMasker(options);
	return (pi: ExtensionAPI): void => {
		pi.on("context_with_system", async (event, ctx) => {
			await maskMessageTreeAsync(event.messages, (text) => masker.mask(text, ctx));
			return { messages: event.messages };
		});
	};
}
