/**
 * 掩码管线：检测器 + 伪值注册表 → `maskText`（幂等过滤 + redactText）
 * 与 `unmaskText`（注册表快照还原）。
 *
 * T2 出站钩子与 T6 掩码压缩必须共享同一管线实例（同一注册表）：
 * 压缩摘要输入的掩码沿用出站已签发的确定性伪值，摘要结果才能按同一
 * 映射还原（伪值一致性 = 还原链成立的前提）。
 */
import {
	compileRegexDetector,
	detectRegexSpans,
	redactText,
	unmaskText,
	type CompiledRegexDetector,
	type RegexDetectorSpec,
} from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
import { createPlaceholderRegistry, type PlaceholderRegistry } from "./registry.ts";
import type { TextMasker } from "./walk.ts";

export interface MaskingPipelineOptions {
	/** regex 检测器配置；缺省内置默认集（T4 起可由 JSON 配置覆盖）。 */
	detectors?: RegexDetectorSpec[];
	/** 复用既有注册表（缺省随管线新建，会话生命周期）。 */
	registry?: PlaceholderRegistry;
	/** 注册表容量上限，默认 5000。 */
	registryLimit?: number;
	/** 伪值哈希段长度，默认 12。 */
	hashLength?: number;
}

/** 会话级掩码管线：同一真值在任何出站路径（请求/压缩摘要）恒得同一伪值。 */
export interface MaskingPipeline {
	/** 检测→幂等过滤→替换（redactText），嵌套调用安全。 */
	readonly maskText: TextMasker;
	/** 伪值→真值还原（注册表快照；截断前缀兜底）。 */
	readonly unmaskText: (text: string) => string;
	/** 共享注册表（T3 回程还原 / T5 judge 共用）。 */
	readonly registry: PlaceholderRegistry;
}

/** 创建会话级掩码管线。检测器 pattern 非法时抛错（配置加载层上报扩展错误的既定语义）。 */
export function createMaskingPipeline(options: MaskingPipelineOptions = {}): MaskingPipeline {
	const detectors: CompiledRegexDetector[] = (options.detectors ?? DEFAULT_DETECTOR_SPECS).map(
		compileRegexDetector,
	);
	const templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
	const registry =
		options.registry ??
		createPlaceholderRegistry({ limit: options.registryLimit, hashLength: options.hashLength });

	const maskText: TextMasker = (text: string): string => {
		const spans = detectRegexSpans(detectors, text).filter(
			(span) => !registry.has(text.slice(span.start, span.end)),
		);
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
	};
}
