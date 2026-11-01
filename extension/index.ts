/**
 * pi-keep-secret 扩展入口（目录扩展 index.ts 工厂）。
 *
 * 组合接线：出站掩码（ticket #4 / T2）、回程还原（ticket #5 / T3）与
 * 掩码压缩（ticket #8 / T6）共用同一会话级掩码管线（同一注册表）：
 * 出站签发、回程还原、压缩摘要沿用同一批确定性伪值并按同一映射还原。
 * judge（T5）见规格 #1。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMaskedCompactionExtension } from "../src/compaction/index.ts";
import { createIngressRestorationExtension } from "../src/ingress/index.ts";
import { createEgressMaskingExtension, createMaskingPipeline } from "../src/masking/index.ts";

/** 会话级共享管线（每次扩展加载一份，随会话存续）。 */
const pipeline = createMaskingPipeline();

/** pi-keep-secret 组合扩展工厂。 */
export default function keepSecretExtension(pi: ExtensionAPI): void {
	createEgressMaskingExtension({ pipeline })(pi);
	createIngressRestorationExtension({ registry: pipeline.registry })(pi);
	createMaskedCompactionExtension({ pipeline })(pi);
}
