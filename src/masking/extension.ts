/**
 * 出站掩码扩展工厂：注册 `context_with_system`，在请求本地副本上做
 * 检测→掩码后原样返回（保持 index 0 system 消息；pi 对处理器输出按
 * 返回值原样使用，transcript 不受影响）。
 *
 * 掩码管线：detectRegexSpans（T1）→ 注册表层幂等过滤（命中文本已是
 * 伪值则跳过，防嵌套 mask）→ redactText（注入注册表签发器：确定性
 * 伪值 + 碰撞 x 后缀兜底 + LRU 写入）。
 *
 * 工厂闭包持有编译态检测器与伪值注册表（会话生命周期状态）；
 * T3（message_end 还原）/T5（judge）在各自 ticket 于同一工厂上扩展。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	compileRegexDetector,
	detectRegexSpans,
	redactText,
	type CompiledRegexDetector,
	type RegexDetectorSpec,
} from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
import { createPlaceholderRegistry, type PlaceholderRegistry } from "./registry.ts";
import { maskMessageTree } from "./walk.ts";

export interface EgressMaskingOptions {
	/** regex 检测器配置；缺省内置默认集（T4 起可由 JSON 配置覆盖）。 */
	detectors?: RegexDetectorSpec[];
	/** 复用既有注册表（缺省随工厂新建，会话生命周期）。 */
	registry?: PlaceholderRegistry;
	/** 注册表容量上限，默认 5000。 */
	registryLimit?: number;
	/** 伪值哈希段长度，默认 12。 */
	hashLength?: number;
}

/**
 * 创建出站掩码扩展（ExtensionFactory）。检测器 pattern 非法时抛错
 * （配置加载层上报扩展错误的既定语义）。
 */
export function createEgressMaskingExtension(options: EgressMaskingOptions = {}) {
	const detectors: CompiledRegexDetector[] = (options.detectors ?? DEFAULT_DETECTOR_SPECS).map(
		compileRegexDetector,
	);
	const templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
	const registry =
		options.registry ??
		createPlaceholderRegistry({ limit: options.registryLimit, hashLength: options.hashLength });

	const maskText = (text: string): string => {
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

	return (pi: ExtensionAPI): void => {
		pi.on("context_with_system", (event) => {
			maskMessageTree(event.messages, maskText);
			return { messages: event.messages };
		});
	};
}
