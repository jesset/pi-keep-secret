/**
 * pi-keep-secret 扩展入口（目录扩展 index.ts 工厂）。
 *
 * 组合接线：出站掩码（judge（若配置）→ regex，同一 clean cache 协同）+
 * 检测器 JSON 配置（T4/ticket #6）、回程还原（T3/ticket #5）、掩码压缩
 * （T6/ticket #8）共用同一会话级掩码管线（同一注册表 + 同一 clean
 * cache）：出站按配置检测器集签发确定性伪值，回程还原与压缩摘要按同一
 * 映射还原。T8（ticket #10）正式接线 judge：config.json 的 judge 段
 * （provider/modelId/阈值）驱动 System One 判定检测器，先于 regex 出站
 * 扩展注册；未配置或模型不可用时降级仅 regex 层并保持可见状态。
 *
 * T7（ticket #9）：input 预检通知 + /keep-secret 命令面（状态/自测/热重
 * 载），状态数据与上述模块共享同一实例（loader/pipeline/judge 掩码器/
 * 压缩状态）。
 *
 * 环境变量在工厂调用时读取（每次扩展装配重新解析，测试可按会话指向
 * 不同配置文件；路径：参数 > PI_KEEP_SECRET_CONFIG >
 * ~/.pi/agent/extensions/pi-keep-secret/config.json；文件缺失用内置默认
 * 集，非法回退默认集并报错可见）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createKeepSecretCommandsExtension } from "../src/commands/index.ts";
import type { MaskedCompactionStatus } from "../src/compaction/index.ts";
import { createMaskedCompactionExtension } from "../src/compaction/index.ts";
import { CONFIG_PATH_ENV, createConfiguredMaskingExtension, type ConfiguredMaskingOptions } from "../src/config/index.ts";
import { createIngressRestorationExtension } from "../src/ingress/index.ts";

/**
 * pi-keep-secret 组合扩展工厂（测试注入点：configPath 指定配置文件、
 * resolveModel/classify 为 judge 替身；正式装配见默认导出）。
 */
export function createKeepSecretExtension(options: ConfiguredMaskingOptions = {}) {
	const { factory, loader, pipeline, judge } = createConfiguredMaskingExtension(options);
	return (pi: ExtensionAPI): void => {
		factory(pi); // 配置错误 notify + 出站掩码（judge（若配置）先于 regex）
		createIngressRestorationExtension({ registry: pipeline.registry })(pi);
		// 压缩回退计数由组合根持有，/keep-secret 状态面与压缩扩展共享同一实例
		const compactionStatus: MaskedCompactionStatus = { fallbacks: 0, lastFallbackError: undefined };
		createMaskedCompactionExtension({ pipeline, status: compactionStatus })(pi);
		createKeepSecretCommandsExtension({ loader, pipeline, compaction: compactionStatus, judge })(pi);
	};
}

/** pi-keep-secret 组合扩展默认入口（目录扩展 index.ts 工厂）。 */
export default function keepSecretExtension(pi: ExtensionAPI): void {
	createKeepSecretExtension({ configPath: process.env[CONFIG_PATH_ENV] })(pi);
}
