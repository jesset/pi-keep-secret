/**
 * 消息树遍历器（架构评审候选 3 收敛后的形态）：角色与豁免知识的唯一
 * 载体是 `collectTextLeaves`——把一条消息的可写文本叶枚举为
 * `{ get, set }` 单元（TextLeaf）；`maskMessageTree`（同步执行器）与
 * `maskMessageTreeAsync`（异步执行器）只决定执行策略，不再各自理解
 * 消息结构。新增消息角色只改 collectTextLeaves 一处；两个执行器的
 * parity（访问叶集合与豁免语义逐角色一致）由 src/masking/walk.test.ts
 * 以同一份全角色夹具锚定。
 *
 * 历史注记：本文件曾逐角色维护同步/异步两份 switch（「有意保留的重复」，
 * 压制理由是 `string | Promise<string>` 式合并会破坏同步路径零开销）。
 * TextLeaf 枚举不经过该权衡：同步执行器完全无 await/微任务（regex 出站
 * 热路径），仅有的代价是每叶两个闭包——相对每叶的检测成本（哈希 +
 * 正则）可忽略。
 *
 * 豁免（结构字段，永不枚举）：ImageContent.data、*Signature、id/name/
 * role/type/mimeType 类键、toolsAdded/toolsRemoved（工具 schema）、
 * nestedCalls（不发模型）、argumentsError、toolResult.details（工具私有）、
 * custom 消息的 details（不进模型上下文）。
 *
 * 原位修改（事件 messages 即请求本地副本，链式转换的既定模式），
 * 会话 transcript 不受影响。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, SystemMessage, TextContent } from "@earendil-works/pi-ai";
/** 单文本叶的掩码函数（由检测管线提供）。 */
export type TextMasker = (text: string) => string;

/** 异步单文本叶掩码函数（judge 等 LLM 判定检测器）。 */
export type AsyncTextMasker = (text: string) => Promise<string>;

/** 可写文本叶：读原文、写掩码结果（结构知识的原子单元）。 */
export interface TextLeaf {
	get(): string;
	set(value: string): void;
}

/** 叶单元构造（get/set 闭包捕获所属容器对象）。 */
function leaf(get: () => string, set: (value: string) => void): TextLeaf {
	return { get, set };
}

/** 对象上字符串槽位的叶（非字符串值不枚举——豁免规则的实现点之一）。 */
function stringSlotLeaves(holder: object, key: string | number, current: unknown): TextLeaf[] {
	if (typeof current === "string") {
		const record = holder as Record<string | number, string>;
		return [leaf(() => record[key], (value) => { record[key] = value; })];
	}
	if (current !== null && typeof current === "object") {
		return jsonStringLeaves(current);
	}
	return [];
}

/**
 * 深遍历 JSON 值的字符串叶（toolCall.arguments 用；数组/嵌套对象全下钻）。
 */
function jsonStringLeaves(value: unknown): TextLeaf[] {
	const leaves: TextLeaf[] = [];
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			leaves.push(...stringSlotLeaves(value, i, value[i]));
		}
		return leaves;
	}
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) {
			leaves.push(...stringSlotLeaves(value, key, (value as Record<string, unknown>)[key]));
		}
	}
	return leaves;
}

/** 内容数组的 text 块（ImageContent.data 等非文本叶不枚举）。 */
function textPartLeaves(parts: (TextContent | ImageContent)[]): TextLeaf[] {
	const leaves: TextLeaf[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			leaves.push(leaf(() => part.text, (value) => { part.text = value; }));
		}
	}
	return leaves;
}

/** string 或 text 块数组的 content 叶（user/custom 消息共用形态）。 */
function stringOrPartsLeaves(message: { content: string | (TextContent | ImageContent)[] }): TextLeaf[] {
	if (typeof message.content === "string") {
		return [leaf(() => message.content as string, (value) => { message.content = value; })];
	}
	return textPartLeaves(message.content);
}

/** SystemMessage 的 prose：content（string/text 块）与 sections 字符串值；toolsAdded/toolsRemoved 豁免。 */
function systemProseLeaves(message: SystemMessage): TextLeaf[] {
	const leaves = stringOrPartsLeaves(message);
	const sections = message.sections;
	if (sections !== undefined) {
		for (const key of Object.keys(sections)) {
			if (typeof sections[key] === "string") {
				leaves.push(...stringSlotLeaves(sections, key, sections[key]));
			}
		}
	}
	return leaves;
}

/**
 * 枚举一条消息的全部可写文本叶（角色/豁免知识的唯一载体）。
 * 覆盖：UserMessage（string/text 块）、ToolResultMessage 的 text 块
 * （ImageContent.data 豁免）、AssistantMessage 的 text/thinking 块与
 * toolCall.arguments 深遍历字符串值、SystemMessage 的 prose 与 sections
 * 字符串值（toolsAdded/toolsRemoved 豁免）、pi 压缩/分支摘要消息的
 * summary 字段（掩码压缩后携带还原真值进上下文，出站必须重掩码；T6
 * 引入）、bashExecution 的 command/output 与 custom 消息的 content——
 * 两者经 pi convertToLlm 投影为 user 文本进 LLM 上下文
 * （bashExecutionToText / content 直投影；!! 前缀的 excludeFromContext
 * 消息不投影，掩码对其无副作用）。
 */
export function collectTextLeaves(message: AgentMessage): TextLeaf[] {
	switch (message.role) {
		case "user": {
			return stringOrPartsLeaves(message);
		}
		case "system": {
			return systemProseLeaves(message);
		}
		case "toolResult": {
			return textPartLeaves(message.content);
		}
		case "assistant": {
			const leaves: TextLeaf[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					leaves.push(leaf(() => block.text, (value) => { block.text = value; }));
				} else if (block.type === "thinking") {
					leaves.push(leaf(() => block.thinking, (value) => { block.thinking = value; }));
				} else if (block.type === "toolCall") {
					leaves.push(...jsonStringLeaves(block.arguments));
				}
			}
			return leaves;
		}
		case "bashExecution": {
			// pi 经 bashExecutionToText 把 command+output 投影为 user 文本进
			// LLM 上下文（!! 前缀的 excludeFromContext 消息不投影，掩码无副作用）
			return [
				leaf(() => message.command, (value) => { message.command = value; }),
				leaf(() => message.output, (value) => { message.output = value; }),
			];
		}
		case "custom": {
			// CustomMessage.content（string 或 text 块）投影为 user 消息（details
			// 不进模型上下文，不枚举）
			return stringOrPartsLeaves(message);
		}
		case "compactionSummary":
		case "branchSummary": {
			// 结构式访问：pi 经 CustomAgentMessages 注入的压缩/分支摘要消息，
			// summary 是进 LLM 上下文的 prose（convertToLlm 展开为 user 文本）
			const holder = message as { summary?: unknown };
			return typeof holder.summary === "string"
				? [leaf(() => holder.summary as string, (value) => { holder.summary = value; })]
				: [];
		}
		default:
			return [];
	}
}

/**
 * 对消息树的文本叶原位掩码（同步执行器）：逐消息、消息内按枚举序执行，
 * 零 await/微任务（regex 出站与掩码压缩的热路径）。
 */
export function maskMessageTree(messages: AgentMessage[], maskText: TextMasker): void {
	for (const message of messages) {
		for (const textLeaf of collectTextLeaves(message)) {
			textLeaf.set(maskText(textLeaf.get()));
		}
	}
}

/**
 * maskMessageTree 的异步执行器（judge 等 LLM 判定检测器的出站遍历）：
 * 按消息并发（消息级并发，对齐参考实现：LLM 调用另有会话级信号量限流）、
 * 消息内叶按枚举序串行。覆盖范围与同步执行器由同一 collectTextLeaves
 * 保证逐角色一致（src/masking/walk.test.ts 锚定 parity）。
 */
export async function maskMessageTreeAsync(
	messages: AgentMessage[],
	maskText: AsyncTextMasker,
): Promise<void> {
	await Promise.all(
		messages.map(async (message) => {
			for (const textLeaf of collectTextLeaves(message)) {
				textLeaf.set(await maskText(textLeaf.get()));
			}
		}),
	);
}
