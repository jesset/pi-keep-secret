/**
 * `/keep-secret` 报告排版器（纯函数、无 IO、无 ANSI）。
 *
 * 为什么需要预排版：pi 的 TUI 把 `ctx.ui.notify` 的文本交给 Text 组件渲染
 * （按终端宽度自动折行，续行无悬挂缩进）；`info` 走 dim 弱化色，`warning`
 * / `error` 仅在首行加 `Warning: ` / `Error: ` 前缀。因此本模块负责：
 * - 在固定宽度预算内**预先折行**（键值列 / 表格列 / 悬挂缩进），保证任何
 *   终端宽度下都不错位；
 * - 输出**纯文本 + Unicode 结构字符**（`─` `·` `✓` `✗`），不注入 ANSI——
 *   主题色由 pi 统一施加；内嵌转义会把后半段消息的颜色打回默认，且 RPC
 *   客户端渲染不一致；
 * - 首行固定为**单行标题**（被 `Warning: ` / `Error: ` 前缀推开时仍合理），
 *   正文缩进 2 列。
 *
 * 宽度按 East Asian Width 计算（用户可把检测器名/配置路径写成 CJK，按
 * `String.length` 对齐会错位；宽字符记 2 列）。
 */

/** 报告宽度预算（可见列）。实测 TUI 正文区普遍 ≥ 80 列，72 留出内边距余量。 */
export const REPORT_WIDTH = 72;

/** 分隔线字符（单列宽）。 */
const RULE_CHAR = "─";

/** 报告键值字段。 */
export interface ReportField {
	label: string;
	value: string;
}

/** 报告分区：可带标题、键值字段、说明条目或自由行。 */
export interface ReportSection {
	heading?: string;
	fields?: ReportField[];
	/** 说明/告警条目（`·` 前缀，悬挂缩进到标记之后）。 */
	bullets?: string[];
	/** 自由行（缩进 2 列，续行同样缩进 2 列）。 */
	lines?: string[];
	/** 条目标记（缺省 `·`；错误分区可用 `✗`）。 */
	bulletMarker?: string;
}

/** 报告结构：标题 + 分区 + 可选收尾（存在收尾时正文与收尾之间补一条分隔线）。 */
export interface ReportSpec {
	title: string;
	sections: ReportSection[];
	footer?: string[];
	width?: number;
}

/** 报告表格行：单元格 + 可选行内说明（渲染到第 2 列起始处）。 */
export interface ReportTableRow {
	cells: string[];
	note?: string;
}

/** 报告表格。 */
export interface ReportTableSpec {
	rows: ReportTableRow[];
	/** 行首缩进（可见列，缺省 2）。 */
	indent?: number;
	/** 列间距（缺省 2）。 */
	gap?: number;
	width?: number;
}

/** 单码点显示宽度：East Asian Wide/Fullwidth 与常见 emoji 记 2 列，其余 1 列。 */
function codePointWidth(codePoint: number): number {
	if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2;
	if (codePoint >= 0x2e80 && codePoint <= 0x303e) return 2;
	if (codePoint >= 0x3041 && codePoint <= 0x33ff) return 2;
	if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 2;
	if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 2;
	if (codePoint >= 0xa000 && codePoint <= 0xa4cf) return 2;
	if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
	if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
	if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return 2;
	if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
	if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
	if (codePoint >= 0x1f300 && codePoint <= 0x1f64f) return 2;
	if (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) return 2;
	if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return 2;
	// 组合附加符号不占列宽
	if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
	if (codePoint === 0x200b || codePoint === 0xfe0f) return 0;
	return 1;
}

/** 可见宽度（East Asian Width 感知；无 ANSI 输入的前提）。 */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += codePointWidth(char.codePointAt(0) ?? 0);
	}
	return width;
}

/** 右填充到指定可见宽度（已超宽则原样返回）。 */
export function padEndVisible(text: string, width: number): string {
	const padding = width - visibleWidth(text);
	return padding > 0 ? text + " ".repeat(padding) : text;
}

/** 按可见宽度折行：先按空白切词，超宽单词硬切；显式换行保留为独立行。 */
export function wrapVisible(text: string, width: number): string[] {
	const limit = Math.max(1, width);
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (visibleWidth(paragraph) <= limit) {
			out.push(paragraph);
			continue;
		}
		let current = "";
		for (const word of paragraph.split(/(\s+)/)) {
			if (word === "") continue;
			if (visibleWidth(current) + visibleWidth(word) <= limit) {
				current += word;
				continue;
			}
			if (current.trim() !== "") {
				out.push(current.trimEnd());
				current = "";
			}
			if (/^\s+$/.test(word)) continue;
			// 单词本身超宽：优先在路径分隔符/连字符处断行，否则按列硬切
			// （分隔符留在行尾——长配置路径折行后可读性更好）
			let rest = word;
			while (visibleWidth(rest) > limit) {
				let cut = 0;
				let used = 0;
				for (const char of rest) {
					const w = codePointWidth(char.codePointAt(0) ?? 0);
					if (used + w > limit) break;
					used += w;
					cut += char.length;
				}
				const head = rest.slice(0, cut);
				const breakAt = Math.max(head.lastIndexOf("/"), head.lastIndexOf("-"));
				if (breakAt > 0) {
					out.push(rest.slice(0, breakAt + 1));
					rest = rest.slice(breakAt + 1);
					continue;
				}
				out.push(head);
				rest = rest.slice(cut);
			}
			current = rest;
		}
		if (current.trim() !== "") out.push(current.trimEnd());
	}
	return out.length > 0 ? out : [""];
}

/** 键值字段行（全局统一标签列宽，续行悬挂到值列）。 */
function fieldLines(fields: ReportField[], labelWidth: number, width: number): string[] {
	const prefixWidth = 2 + labelWidth + 2;
	const lines: string[] = [];
	for (const field of fields) {
		const head = `  ${padEndVisible(field.label, labelWidth)}  `;
		const wrapped = wrapVisible(field.value, Math.max(8, width - prefixWidth));
		lines.push(head + wrapped[0]);
		for (const extra of wrapped.slice(1)) {
			lines.push(" ".repeat(prefixWidth) + extra);
		}
	}
	return lines;
}

/** 条目行（标记 + 悬挂缩进）。 */
function bulletLines(bullets: string[], marker: string, width: number, indent = 2): string[] {
	const prefix = `${" ".repeat(indent)}${marker} `;
	const contIndent = " ".repeat(visibleWidth(prefix));
	const lines: string[] = [];
	for (const bullet of bullets) {
		const wrapped = wrapVisible(bullet, Math.max(8, width - visibleWidth(prefix)));
		lines.push(prefix + wrapped[0]);
		for (const extra of wrapped.slice(1)) {
			lines.push(contIndent + extra);
		}
	}
	return lines;
}

/** 独立条目块（预排版正文中插入 bullet 行时用）。 */
export interface BulletSpec {
	bullets: string[];
	marker?: string;
	indent?: number;
	width?: number;
}

/** 组装条目块（`·` 前缀 + 悬挂缩进）。 */
export function formatBullets(spec: BulletSpec): string[] {
	return bulletLines(spec.bullets, spec.marker ?? "·", spec.width ?? REPORT_WIDTH, spec.indent ?? 2);
}

/** 自由行（缩进 2 列）。 */
function plainLines(texts: string[], width: number): string[] {
	const lines: string[] = [];
	for (const text of texts) {
		for (const line of wrapVisible(text, Math.max(8, width - 2))) {
			lines.push(`  ${line}`);
		}
	}
	return lines;
}

/** 组装报告：标题 / 分隔线 / 分区 / 可选分隔线 + 收尾。 */
export function formatReport(spec: ReportSpec): string {
	const width = spec.width ?? REPORT_WIDTH;
	const sections = spec.sections.filter(
		(section) =>
			section.heading !== undefined ||
			(section.fields?.length ?? 0) > 0 ||
			(section.bullets?.length ?? 0) > 0 ||
			(section.lines?.length ?? 0) > 0,
	);
	const labelWidth = Math.max(
		0,
		...sections.flatMap((section) => (section.fields ?? []).map((field) => visibleWidth(field.label))),
	);
	const lines: string[] = [spec.title, RULE_CHAR.repeat(width)];
	for (const section of sections) {
		if (section.heading !== undefined) lines.push(section.heading);
		if (section.fields !== undefined && section.fields.length > 0) {
			lines.push(...fieldLines(section.fields, labelWidth, width));
		}
		if (section.bullets !== undefined && section.bullets.length > 0) {
			lines.push(...bulletLines(section.bullets, section.bulletMarker ?? "·", width));
		}
		if (section.lines !== undefined && section.lines.length > 0) {
			lines.push(...plainLines(section.lines, width));
		}
	}
	if (spec.footer !== undefined && spec.footer.length > 0) {
		lines.push(RULE_CHAR.repeat(width));
		lines.push(...plainLines(spec.footer, width));
	}
	return lines.join("\n");
}

/**
 * 自由体报告：标题 / 分隔线 / 预排版正文行（原样输出，不再折行）/ 可选
 * 分隔线 + 收尾。用于已有自排版内容（如 `formatTable` 的结果）。
 */
export interface BlockReportSpec {
	title: string;
	body: string[];
	footer?: string[];
	width?: number;
}

/** 组装自由体报告（正文行不做二次排版，避免表格缩进叠加）。 */
export function formatBlockReport(spec: BlockReportSpec): string {
	const width = spec.width ?? REPORT_WIDTH;
	const lines: string[] = [spec.title, RULE_CHAR.repeat(width), ...spec.body];
	if (spec.footer !== undefined && spec.footer.length > 0) {
		lines.push(RULE_CHAR.repeat(width), ...plainLines(spec.footer, width));
	}
	return lines.join("\n");
}

/**
 * 组装表格：除末列外的列按最大可见宽度定宽对齐；末列吸收剩余预算，
 * 超宽时在列内折行（悬挂到该列起点）。行内说明渲染到第 2 列起点。
 */
export function formatTable(spec: ReportTableSpec): string[] {
	const width = spec.width ?? REPORT_WIDTH;
	const indent = spec.indent ?? 2;
	const gap = spec.gap ?? 2;
	if (spec.rows.length === 0) return [];
	const columnCount = Math.max(...spec.rows.map((row) => row.cells.length));
	if (columnCount === 0) return [];

	const cellWidth = (column: number): number =>
		Math.max(0, ...spec.rows.map((row) => visibleWidth(row.cells[column] ?? "")));
	const widths: number[] = [];
	for (let column = 0; column < columnCount - 1; column++) {
		widths.push(cellWidth(column));
	}
	const headWidth = indent + widths.reduce((sum, w) => sum + w + gap, 0);
	const lastBudget = Math.max(8, width - headWidth);
	widths.push(columnCount === 1 ? lastBudget : cellWidth(columnCount - 1));

	const offsets: number[] = [];
	let offset = indent;
	for (const w of widths) {
		offsets.push(offset);
		offset += w + gap;
	}

	const lines: string[] = [];
	for (const row of spec.rows) {
		let line = " ".repeat(indent);
		for (let column = 0; column < columnCount - 1; column++) {
			line += padEndVisible(row.cells[column] ?? "", widths[column]) + " ".repeat(gap);
		}
		const lastCell = row.cells[columnCount - 1] ?? "";
		const wrapped = wrapVisible(lastCell, Math.max(8, width - offsets[columnCount - 1]));
		lines.push((line + wrapped[0]).trimEnd());
		for (const extra of wrapped.slice(1)) {
			lines.push(" ".repeat(offsets[columnCount - 1]) + extra);
		}
		if (row.note !== undefined && row.note !== "") {
			const noteOffset = offsets[1] ?? indent + 2;
			for (const noteLine of wrapVisible(row.note, Math.max(8, width - noteOffset))) {
				lines.push(" ".repeat(noteOffset) + noteLine);
			}
		}
	}
	return lines;
}
