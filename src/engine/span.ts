/** 检测命中区间 [start, end),detector 为命中检测器名(供命中计数/伪值模板)。 */
export interface Span {
	start: number;
	end: number;
	detector: string;
}

/**
 * 合并重叠区间:按 (start 升序, 长度降序) 排序,后续区间与已合区间重叠时被
 * 吸收(长者优先,同起点保留更长者;若尾部超出则延伸末端)。语义对齐参考
 * 实现 _merge_spans(deny 优先级部分不移植——本扩展 redact-only)。
 */
export function mergeSpans(spans: Span[]): Span[] {
	const sorted = [...spans].sort(
		(a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
	);
	const merged: Span[] = [];
	for (const span of sorted) {
		const prev = merged[merged.length - 1];
		if (prev && span.start < prev.end) {
			if (span.end > prev.end) {
				prev.end = span.end;
			}
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}
