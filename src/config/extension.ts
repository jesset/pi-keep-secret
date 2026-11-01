/**
 * 配置化掩码扩展组合（ticket #6 / T4；T8 起含 judge 正式接线）：
 * 配置 loader × judge 检测层 × regex 出站掩码管线。
 *
 * 职责：
 * - 创建时加载配置（路径解析：显式参数 > 环境变量 > 默认路径），把
 *   校验后的 detectors/hashLength/cleanCache 调参喂会话级掩码管线
 *   createMaskingPipeline（非法配置时 loader 已回退默认集）；
 * - 配置 judge 段时创建 judge 文本掩码器（classifier 模型引用与阈值
 *   全部来自配置；模型不可用由掩码器按 onMissing 策略处理——默认
 *   fail_closed 掩码，regex_only 降级仅 regex 层，均状态可见），
 *   出站工厂按「judge 先于 regex」顺序注册（judge 判定需要原文；regex
 *   层对已签发伪值幂等跳过），掩码器同一实例返回给组合根接命令面；
 * - 订阅 loader 变更：检测器集热应用（pipeline.applyDetectors：重编译
 *   + 清空 clean cache），供 /keep-secret reload 消费（hashLength/
 *   cleanCache/judge 段变更仅新会话生效）；
 * - 配置错误可见：首轮请求经 ctx.ui.notify 报出未上报过的错误
 *   （TUI 可见；print/RPC 模式 UI 为 no-op，错误仍可经 loader.get()
 *   读取，T7 status 展示），掩码本身绝不因配置错误中断（回退默认集）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CleanCache } from "../cache/index.ts";
import { createJudgeEgressExtension, createJudgeTextMasker, type ClassifyChannel, type JudgeTextMasker, type ModelResolver } from "../judge/index.ts";
import { createEgressMaskingExtension } from "../masking/extension.ts";
import { createMaskingPipeline, type MaskingPipeline } from "../masking/pipeline.ts";
import type { PlaceholderRegistry } from "../masking/registry.ts";
import { createConfigLoader, type ConfigLoader, type JudgeConfig } from "./loader.ts";

export interface ConfiguredMaskingOptions {
	/** 显式配置路径（缺省走环境变量 PI_KEEP_SECRET_CONFIG → 默认路径）。 */
	configPath?: string;
	/** 复用既有会话级管线（与掩码压缩等扩展共享注册表）；提供时优先于 detectors/cleanCache 调参。 */
	pipeline?: MaskingPipeline;
	/** 复用既有 clean cache（验收检测计数断言注入观察用；提供管线时忽略）。 */
	cleanCache?: CleanCache;
	/** 复用既有伪值注册表（提供管线时忽略）。 */
	registry?: PlaceholderRegistry;
	/** judge 模型解析注入点（测试替身；缺省 ctx.modelRegistry.findOfType）。 */
	resolveModel?: ModelResolver;
	/** judge classify 通道注入点（测试替身；缺省 ctx.modelRegistry.classify）。 */
	classify?: ClassifyChannel;
}

/** 配置化掩码扩展：pi 工厂 + 配置 loader + 会话级管线（T7 /keep-secret 与 T3/T6 组合消费）。 */
export interface ConfiguredMasking {
	/** pi 扩展工厂（配置错误 notify + judge（若配置）+ 出站掩码，管线复用）。 */
	factory: (pi: ExtensionAPI) => void;
	/** 配置 loader（reload/status 消费）。 */
	loader: ConfigLoader;
	/** 会话级掩码管线（回程还原/掩码压缩/judge 共享同一注册表与 clean cache）。 */
	pipeline: MaskingPipeline;
	/** judge 文本掩码器（配置 judge 段时存在；组合根接命令面，未配置 undefined）。 */
	judge?: JudgeTextMasker;
}

/** judge 配置段 → 掩码器选项映射（阈值/批参/并发/模板全部来自配置；注入点透传）。
 *  api 为线缆偏好（T16）：loader 校验合法值，此处透传给掩码器在模型
 *  解析后按三分支应用（见 src/judge/extension.ts）。 */
function createJudgeTextMaskerFor(
	judgeConfig: JudgeConfig,
	pipeline: MaskingPipeline,
	options: ConfiguredMaskingOptions,
): JudgeTextMasker {
	return createJudgeTextMasker({
		modelRef: { provider: judgeConfig.provider, modelId: judgeConfig.modelId },
		pipeline,
		gateThreshold: judgeConfig.gateThreshold,
		candidateThreshold: judgeConfig.candidateThreshold,
		batchSize: judgeConfig.batchSize,
		maxBatches: judgeConfig.maxBatches,
		maxChars: judgeConfig.maxChars,
		minCandidateLength: judgeConfig.minCandidateLength,
		concurrency: judgeConfig.concurrency,
		template: judgeConfig.redactTemplate,
		onMissing: judgeConfig.onMissing,
		api: judgeConfig.api,
		resolveModel: options.resolveModel,
		classify: options.classify,
	});
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
	// judge 正式接线（T8）：配置段存在即创建掩码器（模型不可用时按 onMissing
	// 策略处理：默认 fail_closed 掩码未验证候选；regex_only 降级仅 regex 层；
	// 均计数 + 墓碑 + 状态可见）
	const judgeConfig = initial.judge;
	const judge =
		judgeConfig === undefined
			? undefined
			: createJudgeTextMaskerFor(judgeConfig, pipeline, options);
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
		// 注册顺序契约：judge 先于 regex 出站扩展（判定需要原文；regex 层幂等
		// 跳过已签发伪值，两层串联安全）
		if (judge !== undefined) {
			createJudgeEgressExtension({
				modelRef: { provider: judgeConfig!.provider, modelId: judgeConfig!.modelId },
				pipeline,
				masker: judge,
			})(pi);
		}
		createEgressMaskingExtension({ pipeline })(pi);
	};
	return { factory, loader, pipeline, judge };
}
