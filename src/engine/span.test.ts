import { describe, expect, test } from "bun:test";
import { type Span, mergeSpans } from "./span";

const s = (start: number, end: number, detector = "d"): Span => ({ start, end, detector });

describe("mergeSpans", () => {
	test("不重叠区间全保留,按 start 升序输出(乱序输入)", () => {
		const merged = mergeSpans([s(10, 20), s(0, 5), s(30, 40)]);
		expect(merged).toEqual([s(0, 5), s(10, 20), s(30, 40)]);
	});

	test("重叠时吸收:起点相同/更晚的短区间被长者吸收(语料 test_overlapping_detectors_mask_once)", () => {
		// broad: sk-[A-Za-z0-9_-]{20,} 命中 [4,32);narrow: sk-abc 命中 [4,10)
		const merged = mergeSpans([s(4, 32, "broad"), s(4, 10, "narrow")]);
		expect(merged).toEqual([s(4, 32, "broad")]);
	});

	test("晚起点更长的区间延伸前区间末端", () => {
		const merged = mergeSpans([s(0, 10, "a"), s(5, 25, "b")]);
		expect(merged).toEqual([{ start: 0, end: 25, detector: "a" }]);
	});

	test("相邻(端点相接)不算重叠", () => {
		expect(mergeSpans([s(0, 5), s(5, 9)])).toEqual([s(0, 5), s(5, 9)]);
	});

	test("空输入返回空", () => {
		expect(mergeSpans([])).toEqual([]);
	});
});
