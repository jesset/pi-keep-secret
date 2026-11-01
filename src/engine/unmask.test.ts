import { describe, expect, test } from "bun:test";
import { unmaskText } from "./unmask";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";
const OTHER_SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const PH_OPENAI = "sk-GYY3L4LYIDPR"; // 15 字符,min(20, 15/2)=7
const PH_GITHUB = "ghp_AOVPWAUNKOFQ";

describe("unmaskText", () => {
	test("完整伪值全串替换(语料 test_unmask_non_streaming)", () => {
		const tokens = new Map([[PH_OPENAI, SECRET]]);
		expect(unmaskText(`echo ${PH_OPENAI}`, tokens)).toBe(`echo ${SECRET}`);
	});

	test("同一伪值多次出现全部还原", () => {
		const tokens = new Map([[PH_OPENAI, SECRET]]);
		expect(unmaskText(`${PH_OPENAI} and ${PH_OPENAI}`, tokens)).toBe(`${SECRET} and ${SECRET}`);
	});

	test("多个伪值各自还原", () => {
		const tokens = new Map([
			[PH_OPENAI, SECRET],
			[PH_GITHUB, OTHER_SECRET],
		]);
		expect(unmaskText(`${PH_OPENAI} / ${PH_GITHUB}`, tokens)).toBe(`${SECRET} / ${OTHER_SECRET}`);
	});

	test("截断伪值前缀兜底(语料 test_unmask_truncated_placeholder)", () => {
		const tokens = new Map([[PH_OPENAI, SECRET]]);
		// max_tokens 截断:只剩伪值前 len-3 位,仍还原为完整真值
		const truncated = PH_OPENAI.slice(0, PH_OPENAI.length - 3);
		expect(unmaskText(`half ${truncated}`, tokens)).toBe(`half ${SECRET}`);
	});

	test("兜底阈值:尾部重叠 ≥ min(20, len/2) 才还原,差一位不还原", () => {
		const tokens = new Map([[PH_OPENAI, SECRET]]); // min overlap = min(20, 7) = 7
		expect(unmaskText(`x ${PH_OPENAI.slice(0, 7)}`, tokens)).toBe(`x ${SECRET}`);
		expect(unmaskText(`x ${PH_OPENAI.slice(0, 6)}`, tokens)).toBe(`x ${PH_OPENAI.slice(0, 6)}`);
	});

	test("无伪值文本零改动(幂等)", () => {
		const tokens = new Map([[PH_OPENAI, SECRET]]);
		expect(unmaskText("plain text", tokens)).toBe("plain text");
		expect(unmaskText("", tokens)).toBe("");
	});

	test("伪值出现在文本中间但被截断(非尾部)不触发兜底", () => {
		const tokens = new Map([[PH_OPENAI, SECRET]]);
		const truncated = PH_OPENAI.slice(0, 8);
		const text = `${truncated} tail`;
		expect(unmaskText(text, tokens)).toBe(text);
	});

	test("空 tokens 原样返回", () => {
		expect(unmaskText(`echo ${PH_OPENAI}`, new Map())).toBe(`echo ${PH_OPENAI}`);
	});
});
