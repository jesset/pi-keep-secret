/**
 * System One 判定协议问题构造（纯数据，与 pi-ai ClassifierBoolQuestion 对齐）。
 *
 * 问题文案是校准契约的一部分：措辞变化会改变网关侧判定概率（研究笔记
 * §1 实测锚点），因此从参考实现 secret_mask.py 逐字移植，不做改写。
 * wire 层（typesafe-system-one 传输）把公开的 bool 映射为线缆级 noul。
 */
import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";

/** gate 问题 id（两阶段第一阶段：全文单问）。 */
export const GATE_QUESTION_NAME = "gate";

/** gate 问题：全文是否存在完整凭据（含短/纯数字密码；缩略回显不算）。 */
export const GATE_INSTRUCTIONS =
	"Does the text contain a complete password, API key, access token or " +
	"other credential, including short or purely numeric passwords? " +
	"Abbreviated or masked fragments of a credential (e.g. a partial value " +
	'shown with "...") do not count.';

/** 候选问题（第 i 个）：结合上下文判定 candidates.{i} 是否完整凭据。 */
export function candidateInstructions(index: number): string {
	return (
		"According to the surrounding text, is candidates." +
		index +
		" a complete " +
		"credential (a password, API key, token or secret actually used as " +
		"such)? Answer no if it is only an abbreviated, redacted or truncated " +
		'fragment (e.g. a partial value shown with "..."), a URL or any part ' +
		"of one (paths, query parameters, tracking or thumbnail ids, however " +
		"long or random-looking), or an ordinary string such as an order " +
		"number, date or version."
	);
}

/** gate bool 问题（两阶段第一阶段）。 */
export function gateQuestion(): ClassifierBoolQuestion {
	return {
		type: "bool",
		instructions: GATE_INSTRUCTIONS,
		criteria: {
			true: "The text contains a complete credential as described.",
			false: "The text contains no complete credential; abbreviated or masked fragments do not count.",
		},
	};
}

/** 候选 bool 问题（两阶段第二阶段，逐候选）。 */
export function candidateQuestion(index: number): ClassifierBoolQuestion {
	return {
		type: "bool",
		instructions: candidateInstructions(index),
		criteria: {
			true: `candidates.${index} is a complete credential actually used as such.`,
			false: `candidates.${index} is an abbreviated fragment, part of a URL, or an ordinary string.`,
		},
	};
}
