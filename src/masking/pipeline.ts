/**
 * 会话级掩码管线（ADR-0001：出站掩码组合与 Clean Verdict 协议的唯一所有者）。
 *
 * 完整出站掩码 = judge 层（若配置）先行（判定需要原文）→ regex 阶段兑底
 * （对已签发伪值幂等跳过）→ 按两层结论一次写入 clean cache。调用方（出站
 * 扩展、掩码压缩、命令自测）只消费统一入口，不再自行串联两层——任何新增
 * 出站路径不可能漏接 judge 层（ticket #12 的结构性预防）。
 *
 * Clean Verdict 协议（clean = 两层都判干净）在完整链入口一次查、一次写：
 * - 入口查询：已判干净的文本直接返回（短路重扫，每轮成本 O(新增文本)）；
 * - 入口写入：regex 命中或 judge 结论非 clean（masked/unverified）即记
 *   墓碑（hasSecret=true，永不缓存、拦截后续干净写入，每轮重判）；两层
 *   都干净才写干净结论。judge 与 regex 阶段内部不触碰 clean cache。
 *
 * 双形状 interface（Q2/Q9，ADR-0001）：未配置 judge——同步 `maskText`
 * 出站入口（regex 快路径，零 Promise 成本）；配置 judge——异步 `mask`
 * 为唯一出站入口，同步 regex 阶段退为内部实现。回程还原（unmaskText/
 * registry）保持共享：伪值一致性来自同一注册表实例（first-issuer-wins）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	compileRegexDetector,
	detectRegexSpans,
	unmaskText,
	type CompiledRegexDetector,
	type RegexDetectorSpec,
} from "../engine/index.ts";
import { createCleanCache, type CleanCache, type CleanCacheStats } from "../cache/index.ts";
import type { JudgeConfig, JudgeOnMissing } from "../config/loader.ts";
import {
	createJudgeTextMaskerFor,
	type ClassifyChannel,
	type JudgeStatus,
	type JudgeTextMasker,
	type JudgeWire,
	type ModelResolver,
} from "../judge/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
import { createPlaceholderRegistry, redactSpansWithRegistry, type PlaceholderRegistry } from "./registry.ts";
import type { TextMasker } from "./walk.ts";

export interface MaskingPipelineOptions {
	/** regex 检测器配置；缺省内置默认集（T4 起可由 JSON 配置整体替换）。 */
	detectors?: RegexDetectorSpec[];
	/** judge 层接线（ADR-0001）：提供 config 段（构造时内聚创建 judge 掩码
	 *  器）或预建掩码器（测试替身）。缺省不接入 judge（仅 regex 层）。 */
	judge?: JudgeLayerOptions;
	/** 复用既有注册表（缺省随管线新建，会话生命周期）。 */
	registry?: PlaceholderRegistry;
	/** 注册表容量上限，默认 5000。 */
	registryLimit?: number;
	/** 伪值哈希段长度，默认 12。 */
	hashLength?: number;
	/** 复用既有 clean cache（缺省随管线新建：LRU 20000 + TTL 24h；验收检测计数断言注入观察用）。 */
	cleanCache?: CleanCache;
	/** clean cache 容量上限，默认 20000。 */
	cleanCacheLimit?: number;
	/** clean cache TTL（毫秒），默认 24 小时。 */
	cleanCacheTtlMs?: number;
}

/** judge 层接线：配置段（构造时创建）或预建掩码器（测试替身）。 */
export type JudgeLayerOptions =
	| {
			/** config.json 校验后的 judge 段（provider/modelId/阈值/onMissing/api）。 */
			config: JudgeConfig;
			/** 模型解析注入点（测试替身；缺省 ctx.modelRegistry.findOfType）。 */
			resolveModel?: ModelResolver;
			/** classify 通道注入点（测试替身；缺省 ctx.modelRegistry.classify）。 */
			classify?: ClassifyChannel;
		}
	| {
			/** 预建 judge 掩码器（测试替身；与管线共享同一注册表）。 */
			masker: JudgeTextMasker;
		};

/** judge 层只读快照（/keep-secret 状态面与自测消费；未接线为 undefined）。 */
export interface JudgeLayerInfo {
	/** 故障与降级计数（live 对象——掩码器持续递增）。 */
	status: JudgeStatus;
	/** 生效的模型缺失策略（构造时定格，reload 不热应用）。 */
	onMissing: JudgeOnMissing;
	/** 最近一次 mask 时 classifier 模型是否缺失。 */
	modelMissing: boolean;
	/** 生效线缆（模型解析后定格；解析前 undefined）。 */
	wire: JudgeWire | undefined;
}

/** 管线公共面（两种形态共有；judge 信息读取见 judgeInfo）。 */
export interface MaskingPipelineBase {
	/** 伪值→真值还原（注册表快照；截断前缀兜底）。 */
	unmaskText(text: string): string;
	/** 共享注册表（T3 回程还原 / T6 掩码压缩共用同一映射）。 */
	readonly registry: PlaceholderRegistry;
	/**
	 * 热应用新检测器集（幂等）：与当前集相同则 no-op（不清空 clean cache
	 * 与检测器命中计数——非检测器段 reload 不得误清运行统计）；实质变更
	 * 时重编译检测器并清空 clean cache（检测器集变更后旧的干净判定不再
	 * 可信）与命中计数（名集合已变）。T4 配置层热重载（loader.subscribe）
	 * 消费。
	 */
	applyDetectors(specs: RegexDetectorSpec[]): void;
	/** 各检测器命中计数（合并后 span 按检测器名累计；T7 /keep-secret 状态面）。 */
	detectorHitCounts(): ReadonlyMap<string, number>;
	/** clean cache 统计（T7 /keep-secret 状态面；misses = 实际检测次数）。 */
	cacheStats(): CleanCacheStats;
	/** judge 层只读快照（未接线为 undefined；状态面与自测消费）。 */
	judgeInfo(): JudgeLayerInfo | undefined;
}

/** 未配置 judge 的会话级掩码管线：同步 maskText 为出站入口（regex 快路径）。 */
export interface MaskingPipeline extends MaskingPipelineBase {
	/** 检测（clean cache 短路）→幂等过滤→替换（redactText），嵌套调用安全。 */
	readonly maskText: TextMasker;
}

/** 配置 judge 的会话级掩码管线：异步 mask 为唯一出站入口，同步 regex
 *  阶段退为内部实现（防止绕过 judge 层的出站通道——ADR-0001 Q9）。 */
export interface JudgedMaskingPipeline extends MaskingPipelineBase {
	/** 完整出站掩码：入口一次查 clean → judge 层（原文判定）→ regex 阶段
	 *  （幂等兑底）→ 一次写入（Clean Verdict / 墓碑）。 */
	mask(text: string, ctx: ExtensionContext): Promise<string>;
}

/** 任一形态的掩码管线（出站扩展/压缩/命令面的参数类型；`"mask" in pipeline` 判别）。 */
export type AnyMaskingPipeline = MaskingPipeline | JudgedMaskingPipeline;

/** 创建会话级掩码管线。检测器 pattern 非法时抛错（配置加载层上报扩展错误的既定语义）。 */
export function createMaskingPipeline(
	options: MaskingPipelineOptions & { judge: JudgeLayerOptions },
): JudgedMaskingPipeline;
export function createMaskingPipeline(options?: MaskingPipelineOptions): MaskingPipeline;
export function createMaskingPipeline(
	options: MaskingPipelineOptions = {},
): MaskingPipeline | JudgedMaskingPipeline {
	let detectorSpecs: RegexDetectorSpec[] = options.detectors ?? DEFAULT_DETECTOR_SPECS;
	let detectors: CompiledRegexDetector[] = detectorSpecs.map(compileRegexDetector);
	let templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
	const registry =
		options.registry ??
		createPlaceholderRegistry({ limit: options.registryLimit, hashLength: options.hashLength });
	const cleanCache =
		options.cleanCache ??
		createCleanCache({ limit: options.cleanCacheLimit, ttlMs: options.cleanCacheTtlMs });
	/** 检测器名 → 合并后命中次数（实际执行检测时才累计，缓存短路不计）。 */
	const detectorHits = new Map<string, number>();

	// judge 层接线（ADR-0001：创建内聚进管线构造；注入点原样平移）
	const judgeLayer: JudgeTextMasker | undefined =
		options.judge === undefined
			? undefined
			: "masker" in options.judge
				? options.judge.masker
				: createJudgeTextMaskerFor(options.judge.config, {
						registry,
						resolveModel: options.judge.resolveModel,
						classify: options.judge.classify,
					});

	/** regex 检测阶段（无 judge 时为公开快路径的检测体，有 judge 时为链尾
	 *  兜底）：检测→命中计数→注册表幂等过滤→redactText。不读写 clean
	 *  cache——写入归完整链入口（Clean Verdict 协议）。 */
	const regexStage = (text: string): { text: string; applied: number } => {
		const detected = detectRegexSpans(detectors, text);
		for (const span of detected) {
			detectorHits.set(span.detector, (detectorHits.get(span.detector) ?? 0) + 1);
		}
		return redactSpansWithRegistry(text, detected, registry, templates);
	};

	const base: MaskingPipelineBase = {
		unmaskText: (text) => unmaskText(text, registry.snapshot()),
		registry,
		applyDetectors(specs) {
			// 幂等：相同检测器集 no-op（loader 键序稳定，序列化可作等值判定），
			// 不清 clean cache 与命中统计
			if (JSON.stringify(specs) === JSON.stringify(detectorSpecs)) {
				return;
			}
			detectorSpecs = specs;
			detectors = specs.map(compileRegexDetector);
			templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
			cleanCache.clear();
			detectorHits.clear();
		},
		detectorHitCounts() {
			return new Map(detectorHits);
		},
		cacheStats() {
			return cleanCache.stats();
		},
		judgeInfo() {
			return judgeLayer === undefined
				? undefined
				: {
						status: judgeLayer.status,
						onMissing: judgeLayer.onMissing,
						modelMissing: judgeLayer.modelMissing,
						wire: judgeLayer.wire,
					};
		},
	};

	if (judgeLayer === undefined) {
		/** 无 judge：同步出站入口（clean cache 短路 → regex 检测 → 写入结论）。 */
		const maskText: TextMasker = (text: string): string => {
			if (cleanCache.isClean(text)) {
				return text; // 已判定干净：跳过检测（stats().hits 计短路）
			}
			const { text: masked, applied } = regexStage(text);
			// 命中 secret 的文本不缓存，每轮重扫
			cleanCache.remember(text, { hasSecret: applied > 0 });
			return masked;
		};
		return { ...base, maskText };
	}

	/** 有 judge：异步完整出站入口（唯一出站通道）——一次查、judge 先行、
	 *  regex 兜底、一次写（Clean Verdict 协议：两层都判干净才记干净）。 */
	const mask = async (text: string, ctx: ExtensionContext): Promise<string> => {
		if (cleanCache.isClean(text)) {
			return text; // 已判定干净（两层都过）：跳过全部检测
		}
		const outcome = await judgeLayer.mask(text, ctx);
		const { text: masked, applied } = regexStage(outcome.text);
		// masked/unverified 记墓碑（永不缓存干净，每轮重判——unverified 防
		// judge 恢复后被缓存短路漏判）；clean 且 regex 零命中才写干净结论
		cleanCache.remember(text, { hasSecret: applied > 0 || outcome.verdict !== "clean" });
		return masked;
	};
	return { ...base, mask };
}
