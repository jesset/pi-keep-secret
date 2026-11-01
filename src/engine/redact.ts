import type { Span } from "./span";
import { makePlaceholder } from "./placeholder";

/** 一次替换记录:伪值 → 真值(供 T2 写入注册表)与命中检测器(供计数)。 */
export interface Replacement {
	placeholder: string;
	secret: string;
	detector: string;
}

/**
 * 按 spans(合并后的不重叠升序区间)把命中 secret 替换为确定性伪值。
 * 从区间尾端向前替换以保持前缀偏移有效;伪值由 makePlaceholder 按
 * (secret, detector 模板, hashLength) 生成。返回新文本与替换记录,
 * 注册表写入交由调用方(T2)——本函数无状态。
 * span.detector 无模板配置时抛错。
 */
export function redactText(
	text: string,
	spans: Span[],
	templates: Map<string, string>,
	hashLength = 12,
): { text: string; replacements: Replacement[] } {
	const replacements: Replacement[] = [];
	let out = text;
	for (let i = spans.length - 1; i >= 0; i--) {
		const span = spans[i];
		const template = templates.get(span.detector);
		if (template === undefined) {
			throw new Error(`redactText: no template configured for detector ${JSON.stringify(span.detector)}`);
		}
		const secret = out.slice(span.start, span.end);
		const placeholder = makePlaceholder(secret, template, hashLength);
		replacements.unshift({ placeholder, secret, detector: span.detector });
		out = out.slice(0, span.start) + placeholder + out.slice(span.end);
	}
	return { text: out, replacements };
}
