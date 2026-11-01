/**
 * 回程还原扩展工厂：注册 `message_end`（assistant 消息还原，在
 * transcript 落盘与工具执行之前生效）与 `tool_call`（`event.input`
 * 原位还原，防 message_end 之外路径的第二道兜底）。
 *
 * 还原 tokens 来自与出站掩码（T2）共用的注册表实例 `snapshot()`
 * （全部伪值→真值的合并视图）；注册表为空或消息无伪值时零改动
 * （幂等）。返回 `{ message }`（同 role）触发 pi 的消息替换。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlaceholderRegistry } from "../masking/registry.ts";
import { restoreAssistantMessageInPlace, restoreJsonStringsInPlace } from "./restore.ts";

export interface IngressRestorationOptions {
	/** 与出站掩码共用的伪值注册表（还原 tokens 来源，同实例签发/还原）。 */
	registry: PlaceholderRegistry;
}

/** 创建回程还原扩展（ExtensionFactory）。 */
export function createIngressRestorationExtension(options: IngressRestorationOptions) {
	const registry = options.registry;
	return (pi: ExtensionAPI): void => {
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") {
				return undefined;
			}
			const tokens = registry.snapshot();
			if (tokens.size === 0) {
				return undefined;
			}
			return restoreAssistantMessageInPlace(event.message, tokens)
				? { message: event.message }
				: undefined;
		});
		pi.on("tool_call", (event) => {
			const tokens = registry.snapshot();
			if (tokens.size === 0) {
				return undefined;
			}
			// 原位还原：pi 文档语义——mutate event.input 即改写工具执行参数
			restoreJsonStringsInPlace(event.input, tokens);
			return undefined;
		});
	};
}
