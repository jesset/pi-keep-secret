import type { Span } from "./span";
import { makePlaceholder } from "./placeholder";

/** 一次替换记录:伪值 → 真值(供 T2 写入注册表)与命中检测器(供计数)。 */
export interface Replacement {
	placeholder: string;
	secret: string;
	detector: string;
}

/** 伪值签发器:(真值, 检测器名) → 伪值。注册表层注入用——碰撞后缀
 *  兜底与 LRU 写入在注入方(如 PlaceholderRegistry.issue)里做,引擎保持无状态。 */
export type PlaceholderIssuer = (secret: string, detector: string) => string;

export interface RedactOptions {
	/** 伪值哈希段长度,默认 12(缺省签发路径使用)。 */
	hashLength?: number;
	/** 注入伪值签发器;提供时覆盖默认的 makePlaceholder 确定性哈希。 */
	issuePlaceholder?: PlaceholderIssuer;
}

/**
 * 按 spans(合并后的不重叠升序区间)把命中 secret 替换为确定性伪值。
 * 从区间尾端向前替换以保持前缀偏移有效;伪值由 makePlaceholder 按
 * (secret, detector 模板, hashLength) 生成,或由注入的 issuePlaceholder
 * 签发(注册表层碰撞兜底的注入点)。返回新文本与替换记录,注册表写入
 * 交由调用方(T2)——本函数无状态。
 * span.detector 无模板配置时抛错。
 */
export function redactText(
	text: string,
	spans: Span[],
	templates: Map<string, string>,
	options: RedactOptions = {},
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
		const placeholder = options.issuePlaceholder
			? options.issuePlaceholder(secret, span.detector)
			: makePlaceholder(secret, template, options.hashLength ?? 12);
		replacements.unshift({ placeholder, secret, detector: span.detector });
		out = out.slice(0, span.start) + placeholder + out.slice(span.end);
	}
	return { text: out, replacements };
}
