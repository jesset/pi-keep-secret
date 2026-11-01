import { describe, expect, test } from "bun:test";
import {
	compileRegexDetector,
	detectRegexSpans,
	extractCandidates,
	makePlaceholder,
	redactText,
	unmaskText,
} from "./index";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";

const openai = compileRegexDetector({
	name: "openai",
	pattern: "sk-[A-Za-z0-9_-]{20,}",
	template: "sk-{hash}",
});
const templates = new Map([["openai", openai.template]]);

describe("engine 导出组合(接缝 2 公共接口)", () => {
	test("掩码 → 还原字符串闭环:原文完整回来", () => {
		const original = `部署用这个密钥 ${SECRET},日志里还有 ${SECRET},句号保留。`;
		const spans = detectRegexSpans([openai], original);
		const { text: masked, replacements } = redactText(original, spans, templates);
		expect(masked).not.toContain(SECRET);
		expect(replacements).toHaveLength(2);

		const tokens = new Map(replacements.map((r) => [r.placeholder, r.secret]));
		const restored = unmaskText(masked, tokens);
		expect(restored).toBe(original);
	});

	test("regex 检测器全文扫描,不受 URL 区间影响(URL 内藏 key 仍掩码)", () => {
		// URL 感知只作用于候选抽取;已知格式 regex 命中全文生效(参考实现语义)
		const urlKey = "tok_9f8e7d6c5b4a3210fedcba";
		const text = `go https://api.internal.example.com/v1/data?api_key=${urlKey}&lang=zh now`;
		const token = compileRegexDetector({ name: "tok", pattern: "tok_[a-z0-9]{20,}", template: "tok_{hash}" });
		const spans = detectRegexSpans([token], text);
		expect(spans).toHaveLength(1);
		const { text: masked } = redactText(text, spans, new Map([["tok", "tok_{hash}"]]));
		expect(masked).not.toContain(urlKey);
		expect(masked).toContain("https://api.internal.example.com/v1/data?api_key=tok_");
		// 同一 URL 对候选抽取而言:值是凭据暗示参数 → 候选;其余 URL 无碎片
		const cands = extractCandidates(text, 6).map((c) => c.value);
		expect(cands).toContain(urlKey);
	});

	test("导出的 makePlaceholder 与 redactText 生成的伪值一致", () => {
		const text = `key ${SECRET}`;
		const { replacements } = redactText(text, detectRegexSpans([openai], text), templates);
		expect(replacements[0].placeholder).toBe(makePlaceholder(SECRET, "sk-{hash}", 12));
	});
});
