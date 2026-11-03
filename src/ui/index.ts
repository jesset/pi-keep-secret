/**
 * 用户可见报告排版层（`/keep-secret` 命令面与扩展 notify 共用）。
 *
 * 只做呈现：宽度感知折行、键值/表格对齐、结构字符；不含任何业务判断，
 * 也不注入 ANSI（主题色由 pi 统一施加）。
 */
export {
	REPORT_WIDTH,
	formatBlockReport,
	formatBullets,
	formatReport,
	formatTable,
	padEndVisible,
	visibleWidth,
	wrapVisible,
	type BlockReportSpec,
	type BulletSpec,
	type ReportField,
	type ReportSection,
	type ReportSpec,
	type ReportTableRow,
	type ReportTableSpec,
} from "./report.ts";
