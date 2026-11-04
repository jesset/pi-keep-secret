/**
 * 出站掩码层公共出口（T2 交付；T3 回程还原 / T5 judge / T6 掩码压缩共用）。
 *
 * - `createEgressMaskingExtension`：出站扩展工厂（context_with_system 单扩
 *   展单次遍历，消费管线统一出站入口——ADR-0001）；T4 起由 src/config 的
 *   配置化组合装配为正式目录扩展（检测器集可由 JSON 配置整体替换，热重载
 *   即时生效）。
 * - `createMaskingPipeline`：会话级掩码管线（ADR-0001：出站掩码组合与
 *   Clean Verdict 协议唯一所有者；无 judge 同步 maskText / 有 judge 异步
 *   mask 双形态 + unmaskText + applyDetectors 热应用），出站钩子与掩码
 *   压缩共享同一实例，保证伪值全会话一致。
 * - `createPlaceholderRegistry`：进程内伪值注册表（LRU 5000 + 碰撞 x 后缀
 *   兜底）；T3 的还原 tokens（snapshot）与 T5 的候选签发共用同一实例。
 * - `DEFAULT_DETECTOR_SPECS`：内置默认 regex 检测器集（T4 补 PEM 私钥/JWT；
 *   配置缺失或非法时的回退基准）。
 */
export { createEgressMaskingExtension, type EgressMaskingOptions } from "./extension.ts";
export {
	createMaskingPipeline,
	type AnyMaskingPipeline,
	type JudgedMaskingPipeline,
	type JudgeLayerInfo,
	type JudgeLayerOptions,
	type MaskingPipeline,
	type MaskingPipelineBase,
	type MaskingPipelineOptions,
} from "./pipeline.ts";
export { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
export {
	createPlaceholderRegistry,
	redactSpansWithRegistry,
	type PlaceholderRegistry,
	type PlaceholderRegistryOptions,
} from "./registry.ts";
export { maskMessageTree, maskMessageTreeAsync, type TextMasker, type AsyncTextMasker } from "./walk.ts";
