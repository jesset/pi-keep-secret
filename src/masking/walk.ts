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

/** 单文本叶的掩码函数（由检测管线提供）。 */
export type TextMasker = (text: string) => string;

/**
 * 对消息树的文本叶原位掩码。当前覆盖：UserMessage（string/text 块）与
 * ToolResultMessage 的 text 块（ImageContent.data 豁免）。
 */
export function maskMessageTree(messages: AgentMessage[], maskText: TextMasker): void {
	for (const message of messages) {
		switch (message.role) {
			case "user": {
				if (typeof message.content === "string") {
					message.content = maskText(message.content);
				} else {
					for (const part of message.content) {
						if (part.type === "text") {
							part.text = maskText(part.text);
						}
					}
				}
				break;
			}
			case "toolResult": {
				for (const part of message.content) {
					if (part.type === "text") {
						part.text = maskText(part.text);
					}
				}
				break;
			}
			default:
				break;
		}
	}
}
