/**
 * 消息树遍历器：对请求本地副本（pi 已 structuredClone）的文本叶做掩码，
 * 研究笔记 §2 规则（规格 #1 Implementation Decisions「Message walk」）。
 * 按消息种类逐步覆盖（user → toolResult → assistant → system）。
 *
 * 豁免（结构字段，永不改写）：ImageContent.data、*Signature、id/name/
 * role/type/mimeType 类键、toolsAdded/toolsRemoved（工具 schema）、
 * nestedCalls（不发模型）、argumentsError、toolResult.details（工具私有）。
 *
 * 原位修改（事件 messages 即请求本地副本，链式转换的既定模式），
 * 会话 transcript 不受影响。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, SystemMessage, TextContent } from "@earendil-works/pi-ai";
/** 单文本叶的掩码函数（由检测管线提供）。 */
export type TextMasker = (text: string) => string;

/** SystemMessage 的 prose：content（string/text 块）与 sections 字符串值；toolsAdded/toolsRemoved 豁免。 */
function maskSystemProse(message: SystemMessage, maskText: TextMasker): void {
	if (typeof message.content === "string") {
		message.content = maskText(message.content);
	} else {
		maskTextParts(message.content, maskText);
	}
	if (message.sections !== undefined) {
		for (const key of Object.keys(message.sections)) {
			const section = message.sections[key];
			if (typeof section === "string") {
				message.sections[key] = maskText(section);
			}
		}
	}
}

/** 内容数组的 text 块（ImageContent 等非文本叶不动）。 */
function maskTextParts(parts: (TextContent | ImageContent)[], maskText: TextMasker): void {
	for (const part of parts) {
		if (part.type === "text") {
			part.text = maskText(part.text);
		}
	}
}

/** 深遍历 JSON 值的字符串叶并原位回写（toolCall.arguments 用；数组/嵌套对象全下钻）。 */
function maskJsonStrings(value: unknown, maskText: TextMasker): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (typeof item === "string") {
				value[i] = maskText(item);
			} else {
				maskJsonStrings(item, maskText);
			}
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) {
			const item = (value as Record<string, unknown>)[key];
			if (typeof item === "string") {
				(value as Record<string, unknown>)[key] = maskText(item);
			} else {
				maskJsonStrings(item, maskText);
			}
		}
	}
}

/**
 * 对消息树的文本叶原位掩码。覆盖：UserMessage（string/text 块）、
 * ToolResultMessage 的 text 块（ImageContent.data 豁免）、AssistantMessage
 * 的 text/thinking 块与 toolCall.arguments 深遍历字符串值、SystemMessage
 * 的 prose 与 sections 字符串值（toolsAdded/toolsRemoved 豁免）。
 */
export function maskMessageTree(messages: AgentMessage[], maskText: TextMasker): void {
	for (const message of messages) {
		switch (message.role) {
			case "user": {
				if (typeof message.content === "string") {
					message.content = maskText(message.content);
				} else {
					maskTextParts(message.content, maskText);
				}
				break;
			}
			case "system": {
				maskSystemProse(message, maskText);
				break;
			}
			case "toolResult": {
				maskTextParts(message.content, maskText);
				break;
			}
			case "assistant": {
				for (const block of message.content) {
					if (block.type === "text") {
						block.text = maskText(block.text);
					} else if (block.type === "thinking") {
						block.thinking = maskText(block.thinking);
					} else if (block.type === "toolCall") {
						maskJsonStrings(block.arguments, maskText);
					}
				}
				break;
			}
			default:
				break;
		}
	}
}
