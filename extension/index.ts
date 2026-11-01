/**
 * pi-keep-secret 扩展入口（目录扩展 index.ts 工厂）。
 *
 * 组合接线：出站掩码 + 检测器 JSON 配置与 clean cache（T4/ticket #6）、
 * 回程还原（T3/ticket #5）、掩码压缩（T6/ticket #8）共用同一会话级掩码
 * 管线（同一注册表 + 同一 clean cache）：出站按配置检测器集签发确定性
 * 伪值，回程还原与压缩摘要按同一映射还原。judge（T5）见规格 #1。
 *
 * 环境变量在工厂调用时读取（每次扩展装配重新解析，测试可按会话指向
 * 不同配置文件；路径：参数 > PI_KEEP_SECRET_CONFIG >
 * ~/.pi/agent/extensions/pi-keep-secret/config.json；文件缺失用内置默认
 * 集，非法回退默认集并报错可见）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMaskedCompactionExtension } from "../src/compaction/index.ts";
import { CONFIG_PATH_ENV, createConfiguredMaskingExtension } from "../src/config/index.ts";
import { createIngressRestorationExtension } from "../src/ingress/index.ts";

/** pi-keep-secret 组合扩展工厂。 */
export default function keepSecretExtension(pi: ExtensionAPI): void {
	const { factory, pipeline } = createConfiguredMaskingExtension({
		configPath: process.env[CONFIG_PATH_ENV],
	});
	factory(pi); // 出站掩码（JSON 配置检测器集 + clean cache）与配置错误 notify
	createIngressRestorationExtension({ registry: pipeline.registry })(pi);
	createMaskedCompactionExtension({ pipeline })(pi);
}
