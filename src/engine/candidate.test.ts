import { describe, expect, test } from "bun:test";
import { extractCandidates } from "./candidate";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";

function values(text: string, minLength = 6): string[] {
	return extractCandidates(text, minLength).map((c) => c.value);
}

describe("extractCandidates", () => {
	test("基础抽取:minLength 默认 6,边界 6 留 5 弃", () => {
		const text = "abcde abcdef";
		expect(values(text)).toEqual(["abcdef"]);
		expect(values("订单号 123456", 6)).toEqual(["123456"]);
	});

	test("订单号与密码同等进入候选(甄别归 judge,语料锚点:123456→0.07 / abc123→0.98)", () => {
		// 引擎层不区分订单号与密码——两者都抽为候选,判低归 T5 的 judge
		const cands = values("订单号 123456,密码 abc123", 6);
		expect(cands).toContain("123456");
		expect(cands).toContain("abc123");
	});

	test("去重保首现", () => {
		const text = "first tok_abcdef12 then again tok_abcdef12 end";
		const cands = extractCandidates(text, 6);
		const dup = cands.filter((c) => c.value === "tok_abcdef12");
		expect(dup).toHaveLength(1);
		expect(text.slice(dup[0].start, dup[0].end)).toBe("tok_abcdef12");
		expect(dup[0].start).toBe(text.indexOf("tok_abcdef12"));
	});

	test("超长候选(>512,base64 数据段)丢弃(语料 test_oversized_candidates_not_judged)", () => {
		const text = "payload: " + "Ab12Cd34Ef56".repeat(100) + " end";
		const cands = extractCandidates(text, 6);
		expect(cands.length).toBeGreaterThan(0);
		for (const c of cands) expect(c.value.length).toBeLessThanOrEqual(512);
	});

	test("省略号缩略回显不进候选,完整 key 仍进(语料 test_ellipsis_fragments_not_candidates)", () => {
		const text =
			"Authentication Error, Received API Key = sk-...8989. " +
			`原始 key 是 ${SECRET},配置文件里还有 https://example.com/a/b/c/d/e`;
		const cands = values(text);
		expect(cands).toContain(SECRET);
		for (const c of cands) {
			expect(c.includes("...")).toBe(false);
			expect(c.includes("…")).toBe(false);
		}
		// 省略号串整体或其碎片都不应作为候选出现
		expect(cands).not.toContain("8989");
		expect(cands).not.toContain("sk-");
	});

	test("尾部句读修剪且区间收窄;= 与 ! 保留(语料 test_sentence_final_punctuation_not_in_candidate)", () => {
		const text = "My database password is xk9m2p7q. Repeat it back. Header value: sk-abc123xyz.";
		const cands = values(text);
		expect(cands).toContain("xk9m2p7q");
		expect(cands).toContain("sk-abc123xyz");
		for (const c of cands) {
			expect(c.endsWith(".")).toBe(false);
			expect(c.endsWith(":")).toBe(false);
		}
		// 区间收窄:句号留在原文,mask 不吞句读
		const span = extractCandidates(text, 6).find((c) => c.value === "xk9m2p7q");
		expect(text.slice(span!.start, span!.end)).toBe("xk9m2p7q");
		// 尾部 = (base64 padding)与 !(密码符号)是合法 secret 字符,不修剪
		expect(values("the token is dGVzdA==, ok")).toContain("dGVzdA==");
		expect(values("the token is p@ssw0rd!, ok")).toContain("p@ssw0rd!");
	});

	test("URL 内噪声不产碎片候选;凭据暗示参数值单独成候选(语料 test_url_noise_not_candidates_but_cred_params_are)", () => {
		const noiseUrl =
			"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTunQZm7f4lDfcMhyRLg2KZ" +
			"c4wQfLIDSeVjDIDYypDFrBT1FfdSNG_xpQ3O&s";
		const credUrl = "https://api.internal.example.com/v1/data?api_key=tok_9f8e7d6c5b4a3210fedcba&lang=zh";
		const text = `搜索结果 ${noiseUrl} 另一个 ${credUrl} 完`;
		const cands = values(text);
		for (const c of cands) {
			expect(c.includes("tbn")).toBe(false);
			expect(c.includes("ANd9GcT")).toBe(false);
			expect(c.includes("gstatic")).toBe(false);
		}
		expect(cands).toContain("tok_9f8e7d6c5b4a3210fedcba");
		// 参数坐标正确(值在 cred_url 内的位置)
		const span = extractCandidates(text, 6).find((c) => c.value === "tok_9f8e7d6c5b4a3210fedcba");
		expect(span!.start).toBe(text.indexOf("tok_9f8e7d6c5b4a3210fedcba"));
		expect(text.slice(span!.start, span!.end)).toBe("tok_9f8e7d6c5b4a3210fedcba");
	});

	test("凭据暗示参数名容忍 -/_ 变体与大小写(api_key/token/secret/key/sig/signature/password/auth/access_token/client_secret)", () => {
		const cases = [
			"https://x.io/p?api-key=tok_abcdefghijklmnopq",
			"https://x.io/p?apiKey=tok_abcdefghijklmnopq",
			"https://x.io/p?access_token=tok_abcdefghijklmnopq",
			"https://x.io/p?client-secret=tok_abcdefghijklmnopq",
			"https://x.io/p?password=tok_abcdefghijklmnopq",
			"https://x.io/p?sig=tok_abcdefghijklmnopq",
			"https://x.io/p?signature=tok_abcdefghijklmnopq",
			"https://x.io/p?auth=tok_abcdefghijklmnopq",
			"https://x.io/p?token=tok_abcdefghijklmnopq",
			"https://x.io/p?secret=tok_abcdefghijklmnopq",
			"https://x.io/p?key=tok_abcdefghijklmnopq",
		];
		for (const url of cases) {
			const cands = values(`go ${url} now`);
			expect(cands).toContain("tok_abcdefghijklmnopq");
		}
		// 非凭据参数名的值不单独成候选(整个 URL 无碎片)
		expect(values("go https://x.io/p?q=tok_abcdefghijklmnopq&lang=zh now")).toEqual([]);
	});

	test("纯中文句子只抽出嵌入的 ASCII 串(语料 test_systemone_judge_chinese_text_with_embedded_key)", () => {
		const body = `部署用这个密钥${SECRET}今天上线`;
		expect(values(body)).toEqual([SECRET]);
	});

	test("结果按 (start, end, value) 升序", () => {
		const cands = extractCandidates("zeta-token-99 alpha-token-88", 6);
		const starts = cands.map((c) => c.start);
		expect([...starts].sort((a, b) => a - b)).toEqual(starts);
	});
});
