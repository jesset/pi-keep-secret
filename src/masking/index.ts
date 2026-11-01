/**
 * 出站掩码层公共出口（T2 交付；T3 回程还原 / T5 judge / T6 掩码压缩共用）。
 *
 * - `createEgressMaskingExtension`：扩展工厂（context_with_system 出站掩码），
 *   extension/index.ts 以默认配置装配为正式目录扩展。
 * - `createMaskingPipeline`：会话级掩码管线（maskText/unmaskText + 注册表），
 *   出站钩子与掩码压缩共享同一实例，保证伪值全会话一致。
 * - `createPlaceholderRegistry`：进程内伪值注册表（LRU 5000 + 碰撞 x 后缀
 *   兜底）；T3 的还原 tokens（snapshot）与 T5 的候选签发共用同一实例。
 * - `DEFAULT_DETECTOR_SPECS`：内置默认 regex 检测器集（T4 起可配置覆盖）。
 */
export { createEgressMaskingExtension, type EgressMaskingOptions } from "./extension.ts";
export {
	createMaskingPipeline,
	type MaskingPipeline,
	type MaskingPipelineOptions,
} from "./pipeline.ts";
export { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";
export {
	createPlaceholderRegistry,
	type PlaceholderRegistry,
	type PlaceholderRegistryOptions,
} from "./registry.ts";
export { maskMessageTree, maskMessageTreeAsync, type TextMasker, type AsyncTextMasker } from "./walk.ts";
