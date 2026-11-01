import { describe, expect, test } from "bun:test";
import { exemptLongRuns } from "./exempt-long-runs";
import type { Span } from "./span";

const AIZA = "AIzaSyB1234567890abcdefghijklmnopqrstuv"; // 39 字符,语料同款
const s = (start: number, end: number): Span => ({ start, end, detector: "google-api-key" });

describe("exemptLongRuns", () => {
	test("完全落在 ≥2048 无空白连续段内的命中被丢弃(语料 test_inline_base64_run_regex_hits_ignored)", () => {
		const run = "Ab12" + AIZA + "Cd34Ef56".repeat(400); // >2048 连续无空白
		const prefix = "header text before payload: ";
		const suffix = " and after it";
		const text = prefix + run + suffix;
		// AIZA 命中在 run 内 → 丢弃
		const kept = exemptLongRuns(text, [s(prefix.length + 4, prefix.length + 4 + AIZA.length)]);
		expect(kept).toEqual([]);
	});

	test("段外同文本的命中仍保留", () => {
		const run = "Ab12" + AIZA + "Cd34Ef56".repeat(400);
		const after = " and after it use sk-abcdefghijklmnopqrstuvwx thanks";
		const text = "header: " + run + after;
		const skStart = text.indexOf("sk-abcdefghijklmnopqrstuvwx");
		const kept = exemptLongRuns(text, [
			s(9 + 4, 9 + 4 + AIZA.length), // run 内
			{ start: skStart, end: skStart + 27, detector: "openai" }, // run 外
		]);
		expect(kept).toEqual([{ start: skStart, end: skStart + 27, detector: "openai" }]);
	});

	test("跨出连续段的命中(部分在段内)不被豁免", () => {
		const run = "x".repeat(3000);
		const text = run + " sk-free tail";
		// 命中起点在 run 内、终点在 run 外
		const kept = exemptLongRuns(text, [s(2990, 3010)]);
		expect(kept).toEqual([s(2990, 3010)]);
	});

	test("超长但含空白/换行的正常文本不是豁免条件(语料 test_long_text_with_secret_still_masked)", () => {
		const longText = "please deploy the service and check the logs carefully. ".repeat(400) +
			" the api key is sk-abcdefghijklmnopqrstuvwx ok";
		const hit = longText.indexOf("sk-abcdefghijklmnopqrstuvwx");
		const kept = exemptLongRuns(longText, [s(hit, hit + 27)]);
		expect(kept).toEqual([s(hit, hit + 27)]);
	});

	test("无长段时原样返回", () => {
		const spans = [s(0, 5), s(10, 20)];
		expect(exemptLongRuns("plain text only", spans)).toEqual(spans);
	});
});
