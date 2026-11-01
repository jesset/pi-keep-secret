/**
 * 掩码压缩层公共出口（T6 交付）。
 *
 * - `createMaskedCompactionExtension`：注册 `session_before_compact` /
 *   `session_before_tree`，以掩码摘要整体替换 pi 自带压缩/分支摘要
 *   （结果还原真值落盘）；摘要不可恢复失败时显式回退 pi 默认压缩并
 *   告警计数（默认压缩不掩码，回退绝不能静默）。
 * - `MaskedCompactionStatus`：回退计数与最近原因，供状态面/测试观测。
 */
export {
	createMaskedCompactionExtension,
	type MaskedCompactionOptions,
	type MaskedCompactionStatus,
} from "./extension.ts";
