import { describe, expect, test } from "bun:test";
import { compileRegexDetector, detectRegexSpans, regexSpans } from "./detect";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";
const AIZA = "AIzaSyB1234567890abcdefghijklmnopqrstuv";

const openai = compileRegexDetector({
	name: "openai",
	pattern: "sk-[A-Za-z0-9_-]{20,}",
	template: "sk-{hash}",
});

describe("compileRegexDetector", () => {
	test("非法 pattern 抛错并带检测器名", () => {
		expect(() => compileRegexDetector({ name: "bad", pattern: "sk-[" })).toThrow(/bad/);
	});

	test("template 缺省为 {hash}", () => {
		expect(compileRegexDetector({ name: "n", pattern: "a+" }).template).toBe("{hash}");
	});
});

describe("regexSpans", () => {
	test("pattern → spans(检测器名随行),未命中为空", () => {
		const text = `please use my key ${SECRET} thanks`;
		const start = text.indexOf(SECRET);
		expect(regexSpans(openai, text)).toEqual([
			{ start, end: start + SECRET.length, detector: "openai" },
		]);
		expect(regexSpans(openai, "clean message")).toEqual([]);
	});

	test("零宽命中跳过", () => {
		const det = compileRegexDetector({ name: "z", pattern: "x*" });
		expect(regexSpans(det, "abc")).toEqual([]);
	});

	test("同一编译检测器重复调用无状态残留", () => {
		const text = `a ${SECRET} b`;
		const first = regexSpans(openai, text);
		const second = regexSpans(openai, text);
		expect(second).toEqual(first);
	});
});

describe("detectRegexSpans(多检测器 + 长段豁免 + 合并)", () => {
	test("重叠检测器命中合并为一个区间(语料 test_overlapping_detectors_mask_once)", () => {
		const broad = compileRegexDetector({ name: "broad", pattern: "sk-[A-Za-z0-9_-]{20,}", template: "sk-{hash}" });
		const narrow = compileRegexDetector({ name: "narrow", pattern: "sk-abc", template: "X{hash}" });
		const text = `key ${SECRET}`;
		expect(detectRegexSpans([broad, narrow], text)).toEqual([
			{ start: 4, end: 4 + SECRET.length, detector: "broad" },
		]);
	});

	test("长连续段内 AIza 命中被豁免,段外 sk- 仍检出(语料 test_inline_base64_run_regex_hits_ignored)", () => {
		const google = compileRegexDetector({ name: "google-api-key", pattern: "AIza[0-9A-Za-z_-]{35}", template: "AIza{hash}" });
		const run = "Ab12" + AIZA + "Cd34Ef56".repeat(400); // >2048 连续
		const text = `header text before payload: ${run} and after it use ${SECRET} thanks`;
		expect(detectRegexSpans([openai, google], text)).toEqual([
			{ start: text.indexOf(SECRET), end: text.indexOf(SECRET) + SECRET.length, detector: "openai" },
		]);
	});

	test("超长正常文本(含空白)全量扫描(语料 test_long_text_with_secret_still_masked)", () => {
		const longText =
			"please deploy the service and check the logs carefully. ".repeat(400) +
			` the api key is ${SECRET} ok`;
		expect(detectRegexSpans([openai], longText)).toHaveLength(1);
	});

	test("超长无空白 tool 载荷内的命中被豁免(语料 test_oversized_tool_arguments_and_output_skipped)", () => {
		const google = compileRegexDetector({ name: "google-api-key", pattern: "AIza[0-9A-Za-z_-]{35}", template: "AIza{hash}" });
		const blob = "x".repeat(5000) + AIZA;
		expect(detectRegexSpans([google], blob)).toEqual([]);
	});
});
