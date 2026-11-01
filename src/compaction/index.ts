/**
 * 掩码压缩层公共出口（T6 交付）。
 *
 * - `createMaskedCompactionExtension`：注册 `session_before_compact` /
 *   `session_before_tree`，以掩码摘要整体替换 pi 自带压缩/分支摘要
 *   （结果还原真值落盘）；摘要带重试（SUMMARY_RETRIES 次、短退避），
 *   重试仍失败则取消本次压缩并告警计数（会话继续不压缩，零泄漏；
 *   不存在回退默认压缩的路径）。
 * - `MaskedCompactionStatus`：取消计数与最近原因，供状态面/测试观测。
 */
export {
	createMaskedCompactionExtension,
	type MaskedCompactionOptions,
	type MaskedCompactionStatus,
} from "./extension.ts";
