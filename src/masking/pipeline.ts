/**
 * 掩码管线：检测器 + 伪值注册表 + clean cache → `maskText`（缓存短路 →
 * 幂等过滤 + redactText）与 `unmaskText`（注册表快照还原）。
 *
 * T2 出站钩子与 T6 掩码压缩必须共享同一管线实例（同一注册表）：
 * 压缩摘要输入的掩码沿用出站已签发的确定性伪值，摘要结果才能按同一
 * 映射还原（伪值一致性 = 还原链成立的前提）。
 *
 * T4：检测入口挂 clean cache——干净文本结论缓存短路重扫（每轮成本
 * O(新增消息)），命中 secret 的文本永不缓存、每轮重扫；检测器集热应用
 * 入口 `applyDetectors`（重编译 + 清空缓存）供配置层热重载消费。
 */
import {
	compileRegexDetector,
	detectRegexSpans,
	redactText,
	unmaskText,
	type CompiledRegexDetector,
	type RegexDetectorSpec,
} from "../engine/index.ts";
import { createCleanCache, type CleanCache } from "../cache/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
import { createPlaceholderRegistry, type PlaceholderRegistry } from "./registry.ts";
import type { TextMasker } from "./walk.ts";

export interface MaskingPipelineOptions {
	/** regex 检测器配置；缺省内置默认集（T4 起可由 JSON 配置整体替换）。 */
	detectors?: RegexDetectorSpec[];
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

/** 会话级掩码管线：同一真值在任何出站路径（请求/压缩摘要）恒得同一伪值。 */
export interface MaskingPipeline {
	/** 检测（clean cache 短路）→幂等过滤→替换（redactText），嵌套调用安全。 */
	readonly maskText: TextMasker;
	/** 伪值→真值还原（注册表快照；截断前缀兜底）。 */
	readonly unmaskText: (text: string) => string;
	/** 共享注册表（T3 回程还原 / T5 judge 共用）。 */
	readonly registry: PlaceholderRegistry;
	/**
	 * 热应用新检测器集：重编译检测器并清空 clean cache（检测器集变更后
	 * 旧的干净判定不再可信）。T4 配置层热重载（loader.subscribe）消费。
	 */
	applyDetectors(specs: RegexDetectorSpec[]): void;
}

/** 创建会话级掩码管线。检测器 pattern 非法时抛错（配置加载层上报扩展错误的既定语义）。 */
export function createMaskingPipeline(options: MaskingPipelineOptions = {}): MaskingPipeline {
	let detectors: CompiledRegexDetector[] = (options.detectors ?? DEFAULT_DETECTOR_SPECS).map(
		compileRegexDetector,
	);
	let templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
	const registry =
		options.registry ??
		createPlaceholderRegistry({ limit: options.registryLimit, hashLength: options.hashLength });
	const cleanCache =
		options.cleanCache ??
		createCleanCache({ limit: options.cleanCacheLimit, ttlMs: options.cleanCacheTtlMs });

	const maskText: TextMasker = (text: string): string => {
		if (cleanCache.isClean(text)) {
			return text; // 已判定干净：跳过检测（stats().hits 计短路）
		}
		const spans = detectRegexSpans(detectors, text).filter(
			(span) => !registry.has(text.slice(span.start, span.end)),
		);
		// 命中 secret（或 T5 gate 命中）的文本不缓存，每轮重扫
		cleanCache.remember(text, { hasSecret: spans.length > 0 });
		if (spans.length === 0) {
			return text;
		}
		return redactText(text, spans, templates, {
			issuePlaceholder: (secret, detector) =>
				registry.issue(secret, templates.get(detector)!),
		}).text;
	};

	return {
		maskText,
		unmaskText: (text) => unmaskText(text, registry.snapshot()),
		registry,
		applyDetectors(specs) {
			detectors = specs.map(compileRegexDetector);
			templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
			cleanCache.clear();
		},
	};
}
