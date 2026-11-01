/**
 * 配置化掩码扩展组合（ticket #6 / T4）：配置 loader × 出站掩码管线。
 *
 * 职责：
 * - 创建时加载配置（路径解析：显式参数 > 环境变量 > 默认路径），把
 *   校验后的 detectors/hashLength/cleanCache 调参喂会话级掩码管线
 *   createMaskingPipeline（非法配置时 loader 已回退默认集）；
 * - 订阅 loader 变更：检测器集热应用（pipeline.applyDetectors：重编译
 *   + 清空 clean cache），供 T7 的 /keep-secret reload 消费
 *   （hashLength/cleanCache 变更仅新会话生效）；
 * - 配置错误可见：首轮请求经 ctx.ui.notify 报出未上报过的错误
 *   （TUI 可见；print/RPC 模式 UI 为 no-op，错误仍可经 loader.get()
 *   读取，T7 status 展示），掩码本身绝不因配置错误中断（回退默认集）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CleanCache } from "../cache/index.ts";
import { createEgressMaskingExtension } from "../masking/extension.ts";
import { createMaskingPipeline, type MaskingPipeline } from "../masking/pipeline.ts";
import type { PlaceholderRegistry } from "../masking/registry.ts";
import { createConfigLoader, type ConfigLoader } from "./loader.ts";

export interface ConfiguredMaskingOptions {
	/** 显式配置路径（缺省走环境变量 PI_KEEP_SECRET_CONFIG → 默认路径）。 */
	configPath?: string;
	/** 复用既有会话级管线（与掩码压缩等扩展共享注册表）；提供时优先于 detectors/cleanCache 调参。 */
	pipeline?: MaskingPipeline;
	/** 复用既有 clean cache（验收检测计数断言注入观察用；提供管线时忽略）。 */
	cleanCache?: CleanCache;
	/** 复用既有伪值注册表（提供管线时忽略）。 */
	registry?: PlaceholderRegistry;
}

/** 配置化掩码扩展：pi 工厂 + 配置 loader + 会话级管线（T7 /keep-secret 与 T3/T6 组合消费）。 */
export interface ConfiguredMasking {
	/** pi 扩展工厂（配置错误 notify + 出站掩码，管线复用）。 */
	factory: (pi: ExtensionAPI) => void;
	/** 配置 loader（reload/status 消费）。 */
	loader: ConfigLoader;
	/** 会话级掩码管线（回程还原/掩码压缩共享同一注册表与 clean cache）。 */
	pipeline: MaskingPipeline;
}

/** 创建配置化掩码扩展组合。 */
export function createConfiguredMaskingExtension(
	options: ConfiguredMaskingOptions = {},
): ConfiguredMasking {
	const loader = createConfigLoader({ path: options.configPath });
	const initial = loader.get();
	const pipeline =
		options.pipeline ??
		createMaskingPipeline({
			detectors: initial.detectors,
			hashLength: initial.hashLength,
			registry: options.registry,
			cleanCache: options.cleanCache,
			cleanCacheLimit: initial.cleanCache?.limit,
			cleanCacheTtlMs: initial.cleanCache?.ttlMs,
		});
	loader.subscribe((config) => pipeline.applyDetectors(config.detectors));

	/** 已上报过的配置错误（每条只 notify 一次，reload 新错误再报）。 */
	const reported = new Set<string>();
	const factory = (pi: ExtensionAPI): void => {
		pi.on("context_with_system", (_event, ctx) => {
			for (const error of loader.get().errors) {
				if (!reported.has(error)) {
					reported.add(error);
					ctx.ui.notify(
						`pi-keep-secret: 配置错误，已回退内置默认检测器集 — ${error}`,
						"error",
					);
				}
			}
			return undefined; // 纯通知，不改写消息
		});
		createEgressMaskingExtension({ pipeline })(pi);
	};
	return { factory, loader, pipeline };
}
