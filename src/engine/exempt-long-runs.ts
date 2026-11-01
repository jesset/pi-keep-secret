import type { Span } from "./span";

/** 超长连续无空白段阈值:≥2048 视为编码载荷(base64 等)。 */
const LONG_RUN_MIN = 2048;

/**
 * 长连续段豁免:完全落在 ≥2048 无空白连续段内的命中被丢弃——对其内嵌
 * 替换必破坏数据(base64 里出现 AIza/sk- 模式的概率高,语料实测曾致图片
 * 损坏)。豁免的是「连续段」而非长文本:几万字符的正常文本(有空格/换行)
 * 全量扫描;PEM 私钥(多行)与 JWT(通常 <2048)不受影响。
 * 语义对齐参考实现 _filter_spans_in_long_runs。
 */
export function exemptLongRuns(text: string, spans: Span[]): Span[] {
	const longRuns: Array<[number, number]> = [];
	for (const m of text.matchAll(/\S{2048,}/g)) {
		const start = m.index ?? 0;
		longRuns.push([start, start + m[0].length]);
	}
	if (longRuns.length === 0) {
		return spans;
	}
	return spans.filter(
		(span) => !longRuns.some(([rs, re]) => rs <= span.start && span.end <= re),
	);
}
