import type { Span } from "./span";
import { mergeSpans } from "./span";
import { exemptLongRuns } from "./exempt-long-runs";

/** 配置态 regex 检测器(T4 配置加载产物;pattern 为字符串)。 */
export interface RegexDetectorSpec {
	name: string;
	pattern: string;
	/** 伪值模板,如 "sk-{hash}";缺省 "{hash}"。 */
	template?: string;
}

/** 编译态 regex 检测器:pattern 已编译并带全局标志,可在多消息间复用。 */
export interface CompiledRegexDetector {
	name: string;
	regex: RegExp;
	template: string;
}

/**
 * 编译 regex 检测器。pattern 非法时抛错(消息含检测器名,供配置加载层
 * 上报扩展错误并回退内置默认集)。
 */
export function compileRegexDetector(spec: RegexDetectorSpec): CompiledRegexDetector {
	let regex: RegExp;
	try {
		regex = new RegExp(spec.pattern, "g");
	} catch (e) {
		throw new Error(`detector ${JSON.stringify(spec.name)}: invalid regex: ${String(e)}`);
	}
	return { name: spec.name, regex, template: spec.template ?? "{hash}" };
}

/** 单检测器执行:pattern → spans([start, end) 区间,零宽命中跳过)。 */
export function regexSpans(detector: CompiledRegexDetector, text: string): Span[] {
	const out: Span[] = [];
	for (const m of text.matchAll(detector.regex)) {
		const start = m.index ?? 0;
		if (m[0].length > 0) {
			out.push({ start, end: start + m[0].length, detector: detector.name });
		}
	}
	return out;
}

/**
 * 全部 regex 检测器执行:各检测器原始命中 → 长连续段豁免 → 重叠合并。
 * 豁免在合并前逐检测器应用(对齐参考实现 _detect_uncached 的顺序:
 * regex 命中先过滤长段,再与 judge 命中一并合并)。
 */
export function detectRegexSpans(detectors: CompiledRegexDetector[], text: string): Span[] {
	const raw = detectors.flatMap((d) => regexSpans(d, text));
	return mergeSpans(exemptLongRuns(text, raw));
}
