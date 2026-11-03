/**
 * 报告排版器单元测试（`src/ui/report.ts`）。
 *
 * 锚定属性（而非逐字快照）：
 * - 可见宽度：CJK 记 2 列、ASCII 记 1 列；
 * - 折行：空白处折、超宽词硬切、路径优先在 `/` 处断行、每行不超预算；
 * - 键值表：标签列全局对齐、续行悬挂到值列；
 * - 条目/收尾：标记前缀 + 悬挂缩进、收尾前有分隔线；
 * - 表格：除末列外定宽对齐、末列折行悬挂到列起点、行内注记对齐第 2 列；
 * - 输出卫生：无行尾空格、无 ANSI 转义、无非 ASCII 输入时不产生 CJK。
 */
import { describe, expect, test } from "bun:test";
import {
	REPORT_WIDTH,
	formatBlockReport,
	formatBullets,
	formatReport,
	formatTable,
	padEndVisible,
	visibleWidth,
	wrapVisible,
} from "./report.ts";

const ANSI_PATTERN = /\x1b\[/;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 行内不得超预算且不得有行尾空格（可见宽度口径）。 */
function expectCleanLines(lines: string[], width = REPORT_WIDTH): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).toBe(line.trimEnd());
		expect(line).not.toMatch(ANSI_PATTERN);
	}
}

describe("可见宽度与右填充", () => {
	test("ASCII 记 1 列，CJK 全宽字符记 2 列", () => {
		expect(visibleWidth("abc")).toBe(3);
		expect(visibleWidth("检测器")).toBe(6);
		expect(visibleWidth("abc检测")).toBe(7);
		expect(visibleWidth("")).toBe(0);
	});

	test("padEndVisible 按可见宽度对齐（中英混排不跑偏）", () => {
		expect(padEndVisible("ab", 4)).toBe("ab  ");
		expect(padEndVisible("检测", 6)).toBe("检测  ");
		expect(visibleWidth(padEndVisible("检测", 7))).toBe(7);
		// 已超宽：原样返回，不截断
		expect(padEndVisible("abcdef", 3)).toBe("abcdef");
	});
});

describe("折行（wrapVisible）", () => {
	test("在空白处折行，续行不带前导空格", () => {
		const lines = wrapVisible("alpha beta gamma delta", 12);
		expect(lines).toEqual(["alpha beta", "gamma delta"]);
	});

	test("显式换行保留为独立行", () => {
		expect(wrapVisible("one\ntwo", 40)).toEqual(["one", "two"]);
	});

	test("超宽单词按列硬切，每行不超预算", () => {
		const lines = wrapVisible("x".repeat(25), 10);
		expect(lines).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	});

	test("超宽路径优先在 / 处断行（分隔符留在行尾）", () => {
		const lines = wrapVisible("/var/folders/aa/bb/cc/config.json", 16);
		expect(lines[0].endsWith("/")).toBe(true);
		expect(lines.join("")).toBe("/var/folders/aa/bb/cc/config.json");
		expectCleanLines(lines, 16);
	});

	test("CJK 文本按显示宽度折行", () => {
		const lines = wrapVisible("检测器命中统计", 5);
		expect(lines.every((line) => visibleWidth(line) <= 5)).toBe(true);
		expect(lines.join("")).toBe("检测器命中统计");
	});

	test("空串返回一个空行（调用方无需特判）", () => {
		expect(wrapVisible("", 10)).toEqual([""]);
	});
});

describe("formatReport：标题 + 分隔线 + 分组键值表", () => {
	test("标题与分隔线；标签列跨分区全局对齐，值列起点一致", () => {
		const text = formatReport({
			title: "pi-keep-secret · status",
			sections: [
				{ heading: "Config", fields: [{ label: "detectors", value: "7 · mode replace" }] },
				{ heading: "Session", fields: [{ label: "placeholders", value: "1 placeholder issued" }] },
			],
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe("pi-keep-secret · status");
		expect(lines[1]).toBe("─".repeat(REPORT_WIDTH));
		expect(lines[2]).toBe("Config");
		expect(lines[3]).toBe("  detectors     7 · mode replace");
		expect(lines[4]).toBe("Session");
		expect(lines[5]).toBe("  placeholders  1 placeholder issued");
		expectCleanLines(lines);
	});

	test("长值预折行，续行悬挂到值列起点", () => {
		const value = "openai-key, github-pat, aws-access-key-id, google-api-key, slack-bot-token";
		const lines = formatReport({
			title: "t",
			sections: [{ heading: "Config", fields: [{ label: "names", value }] }],
		}).split("\n");
		const valueLines = lines.filter((line) => line.includes(",") || line.includes("slack"));
		expect(valueLines.length).toBeGreaterThan(1);
		for (const line of valueLines) {
			expect(line.startsWith("  names  ") || line.startsWith(" ".repeat(9))).toBe(true);
		}
		// 折行不丢内容（空格归一）
		expect(valueLines.join(" ").replace(/\s+/g, " ")).toContain("slack-bot-token");
		expectCleanLines(lines);
	});

	test("条目带标记与悬挂缩进；错误分区可用 ✗ 标记", () => {
		const lines = formatReport({
			title: "t",
			sections: [
				{ heading: "Config errors", bulletMarker: "✗", bullets: ["unknown top-level key \"detector\""] },
			],
		}).split("\n");
		expect(lines[3]).toBe("  ✗ unknown top-level key \"detector\"");
		const wrapped = formatReport({
			title: "t",
			sections: [{ bullets: ["a".repeat(80)] }],
		}).split("\n");
		expect(wrapped[2].startsWith("  · ")).toBe(true);
		expect(wrapped[3].startsWith("    ")).toBe(true);
		expectCleanLines(wrapped);
	});

	test("收尾：补一条分隔线后缩进 2 列输出", () => {
		const lines = formatReport({
			title: "t",
			sections: [{ fields: [{ label: "config", value: "unchanged" }] }],
			footer: ["✓ 4/4 passed"],
		}).split("\n");
		expect(lines[lines.length - 1]).toBe("  ✓ 4/4 passed");
		expect(lines[lines.length - 2]).toBe("─".repeat(REPORT_WIDTH));
		expectCleanLines(lines);
	});

	test("空分区被过滤；无分区时只输出标题与分隔线", () => {
		expect(formatReport({ title: "t", sections: [] }).split("\n")).toEqual([
			"t",
			"─".repeat(REPORT_WIDTH),
		]);
		expect(
			formatReport({ title: "t", sections: [{ fields: [] }, { bullets: [] }] }).split("\n"),
		).toHaveLength(2);
	});

	test("输出卫生：ASCII 输入不产生 CJK、无 ANSI、无行尾空格", () => {
		const text = formatReport({
			title: "pi-keep-secret · status",
			sections: [
				{ heading: "Config", fields: [{ label: "source", value: "/a/very/long/path/".repeat(6) }] },
				{ heading: "Notes", bullets: ["x".repeat(200)] },
			],
			footer: ["done"],
		});
		expect(text).not.toMatch(CJK_PATTERN);
		expectCleanLines(text.split("\n"));
	});
});

describe("formatBullets / formatBlockReport", () => {
	test("条目块可指定缩进，续行悬挂到标记之后", () => {
		const lines = formatBullets({ bullets: ["short", "y".repeat(80)], width: 20 });
		expect(lines[0]).toBe("  · short");
		expect(lines[2].startsWith("    ")).toBe(true);
		expectCleanLines(lines, 20);
	});

	test("自由体报告：正文原样（不二次缩进），收尾带分隔线", () => {
		const text = formatBlockReport({
			title: "pi-keep-secret · self-test",
			body: ["  ✓  a            masked", "", "  · note"],
			footer: ["✓ 4/4 passed"],
		});
		const lines = text.split("\n");
		expect(lines[2]).toBe("  ✓  a            masked");
		expect(lines[3]).toBe("");
		expect(lines[4]).toBe("  · note");
		expect(lines[lines.length - 1]).toBe("  ✓ 4/4 passed");
		expectCleanLines(lines);
	});
});

describe("formatTable：列对齐与列内折行", () => {
	test("除末列外定宽对齐；行内注记对齐第 2 列", () => {
		const lines = formatTable({
			rows: [
				{ cells: ["✓", "sk- fake key", "masked", "expected masked"] },
				{ cells: ["✓", "key in URL", "unmasked", "expected unmasked"], note: "invisible to regex" },
				{ cells: ["✓", "clean order number", "unmasked", "expected unmasked"] },
			],
		});
		expect(lines[0]).toBe("  ✓  sk- fake key        masked    expected masked");
		expect(lines[1]).toBe("  ✓  key in URL          unmasked  expected unmasked");
		// 注记对齐第 2 列起点（2 + 1 + 2 = 5 列）
		expect(lines[2]).toBe("     invisible to regex");
		expect(lines[3]).toBe("  ✓  clean order number  unmasked  expected unmasked");
		expectCleanLines(lines);
	});

	test("空行集返回空数组", () => {
		expect(formatTable({ rows: [] })).toEqual([]);
	});

	test("末列超预算时在列内折行，悬挂到该列起点", () => {
		const lines = formatTable({
			rows: [{ cells: ["✓", "label", "w".repeat(90)] }],
		});
		expect(lines.length).toBeGreaterThan(1);
		const offset = lines[0].indexOf("w");
		expect(lines[1].startsWith(" ".repeat(offset))).toBe(true);
		expectCleanLines(lines);
	});
});
