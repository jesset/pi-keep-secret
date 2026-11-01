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
import { createCleanCache, type CleanCache } from "../cache/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
import { createPlaceholderRegistry, type PlaceholderRegistry } from "./registry.ts";
import { maskMessageTree } from "./walk.ts";

export interface EgressMaskingOptions {
	/** regex 检测器配置；缺省内置默认集（T4 起可由 JSON 配置整体替换）。 */
	detectors?: RegexDetectorSpec[];
	/** 复用既有注册表（缺省随工厂新建，会话生命周期）。 */
	registry?: PlaceholderRegistry;
	/** 注册表容量上限，默认 5000。 */
	registryLimit?: number;
	/** 伪值哈希段长度，默认 12。 */
	hashLength?: number;
	/** 复用既有 clean cache（缺省随工厂新建：LRU 20000 + TTL 24h）。 */
	cleanCache?: CleanCache;
	/** clean cache 容量上限，默认 20000。 */
	cleanCacheLimit?: number;
	/** clean cache TTL（毫秒），默认 24 小时。 */
	cleanCacheTtlMs?: number;
	/**
	 * 检测器热应用注册（T4 配置层热重载接线）：扩展把「应用新检测器集」
	 * 的入口交给注册方；调用 apply(specs) 即重编译检测器并清空 clean
	 * cache（检测器集变更后旧的干净判定不再可信）。
	 */
	registerApplyDetectors?: (apply: (specs: RegexDetectorSpec[]) => void) => void;
}

/**
 * 创建出站掩码扩展（ExtensionFactory）。检测器 pattern 非法时抛错
 * （配置加载层上报扩展错误的既定语义）。掩码管线检测入口挂 clean
 * cache：干净文本结论缓存短路重扫（每轮成本 O(新增消息)），命中
 * secret 的文本永不缓存、每轮重扫。
 */
export function createEgressMaskingExtension(options: EgressMaskingOptions = {}) {
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

	const applyDetectors = (specs: RegexDetectorSpec[]): void => {
		detectors = specs.map(compileRegexDetector);
		templates = new Map(detectors.map((detector) => [detector.name, detector.template]));
		cleanCache.clear();
	};
	options.registerApplyDetectors?.(applyDetectors);

	const maskText = (text: string): string => {
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

	return (pi: ExtensionAPI): void => {
		pi.on("context_with_system", (event) => {
			maskMessageTree(event.messages, maskText);
			return { messages: event.messages };
		});
	};
}
