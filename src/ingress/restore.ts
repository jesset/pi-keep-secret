/**
 * 回程还原遍历器：assistant 消息的 text/thinking/toolCall.arguments
 * （深遍历字符串值）伪值→真值（研究笔记 §2 还原规则；规格 #1
 * Implementation Decisions「Ingress point」）。
 *
 * 还原用引擎 unmaskText：完整伪值全串替换 + 尾部截断前缀兜底
 * （max_tokens 截断的半个伪值按前缀还原为完整真值，引擎已测）。
 *
 * 原位改写：message_end 处最终消息时 agent 状态尚未落盘，pi 的
 * message_end 替换语义对原位改写与返回副本等价（_replaceMessageInPlace
 * 注释明确 bless 原位改写以保持各视图同步）。无伪值命中时零写入
 * （幂等：unmaskText 对不含伪值的文本原样返回，此处逐叶比对跳过）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { unmaskText } from "../engine/index.ts";

/** AgentMessage 的 assistant 成员（message_end 还原目标）。 */
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** 深遍历 JSON 值的字符串叶并原位还原（数组/嵌套对象全下钻）；返回是否有改动。 */
export function restoreJsonStringsInPlace(value: unknown, tokens: Map<string, string>): boolean {
	let changed = false;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (typeof item === "string") {
				const text = unmaskText(item, tokens);
				if (text !== item) {
					value[i] = text;
					changed = true;
				}
			} else if (restoreJsonStringsInPlace(item, tokens)) {
				changed = true;
			}
		}
		return changed;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const item = record[key];
			if (typeof item === "string") {
				const text = unmaskText(item, tokens);
				if (text !== item) {
					record[key] = text;
					changed = true;
				}
			} else if (restoreJsonStringsInPlace(item, tokens)) {
				changed = true;
			}
		}
	}
	return changed;
}

/**
 * 原位还原 assistant 消息的 text/thinking/toolCall.arguments（深遍历）。
 * tokens 为空时直接零改动；返回是否有改动（调用方据此决定是否返回
 * 替换消息）。
 */
export function restoreAssistantMessageInPlace(
	message: AssistantMessage,
	tokens: Map<string, string>,
): boolean {
	if (tokens.size === 0) {
		return false;
	}
	let changed = false;
	for (const block of message.content) {
		if (block.type === "text") {
			const text = unmaskText(block.text, tokens);
			if (text !== block.text) {
				block.text = text;
				changed = true;
			}
		} else if (block.type === "thinking") {
			const thinking = unmaskText(block.thinking, tokens);
			if (thinking !== block.thinking) {
				block.thinking = thinking;
				changed = true;
			}
		} else if (block.type === "toolCall") {
			if (restoreJsonStringsInPlace(block.arguments, tokens)) {
				changed = true;
			}
		}
	}
	return changed;
}
