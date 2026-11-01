/**
 * 伪值 → 真值还原:
 *
 * - 完整伪值:全串替换(所有出现);
 * - 截断前缀兜底:伪值被 max_tokens 截断在文本尾部时,尾部与伪值前缀
 *   重叠 ≥ min(20, len/2) 即按伪值还原为完整真值(参考实现 _unmask_text)。
 *   只看文本尾部——流式截断只发生在末尾,中部相似串不误还原。
 */
export function unmaskText(text: string, tokens: Map<string, string>): string {
	let out = text;
	for (const [placeholder, secret] of tokens) {
		if (out.includes(placeholder)) {
			out = out.split(placeholder).join(secret);
			continue;
		}
		const minOverlap = Math.min(20, Math.floor(placeholder.length / 2));
		for (let i = Math.max(0, out.length - placeholder.length); i < out.length; i++) {
			const sub = out.slice(i);
			if (placeholder.startsWith(sub) && sub.length >= minOverlap) {
				out = out.slice(0, i) + secret;
				break;
			}
		}
	}
	return out;
}
