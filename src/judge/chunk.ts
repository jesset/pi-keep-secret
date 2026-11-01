/**
 * 超长消息分块（纯函数）：≤maxChars 全覆盖切块，相邻块重叠
 * min(2000, maxChars/4)，与参考实现 _chunk_text 逐字对齐——块间重叠
 * 保证跨块边界的 secret 完整出现在至少一块（不截断，全覆盖）。
 */

/** 分块产物：块文本 + 在原文中的起始偏移。 */
export interface TextChunk {
	text: string;
	offset: number;
}

/**
 * 把 text 切成 ≤maxChars 的块（重叠 min(2000, maxChars/4)）；
 * text ≤maxChars 时原样单块返回。
 */
export function chunkText(text: string, maxChars: number): TextChunk[] {
	if (text.length <= maxChars) {
		return [{ text, offset: 0 }];
	}
	const overlap = Math.min(2000, Math.floor(maxChars / 4));
	const step = maxChars - overlap;
	const out: TextChunk[] = [];
	let start = 0;
	while (true) {
		out.push({ text: text.slice(start, start + maxChars), offset: start });
		if (start + maxChars >= text.length) {
			break;
		}
		start += step;
	}
	return out;
}
