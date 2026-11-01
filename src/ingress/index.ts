/**
 * 回程还原层公共出口（T3 交付）。
 *
 * - `createIngressRestorationExtension`：扩展工厂（message_end 还原 +
 *   tool_call 兜底），与出站掩码（T2）共用同一注册表实例，在
 *   extension/index.ts 组合层接线。
 * - `restoreAssistantMessageInPlace` / `restoreJsonStringsInPlace`：
 *   纯还原遍历（深遍历字符串值；截断前缀兜底在引擎 unmaskText）。
 */
export {
	createIngressRestorationExtension,
	type IngressRestorationOptions,
} from "./extension.ts";
export {
	restoreAssistantMessageInPlace,
	restoreJsonStringsInPlace,
	type AssistantMessage,
} from "./restore.ts";
