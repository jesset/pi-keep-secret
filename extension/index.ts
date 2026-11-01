/**
 * pi-keep-secret 扩展入口（目录扩展 index.ts 工厂）。
 *
 * 组合接线：出站掩码（ticket #4 / T2）与回程还原（ticket #5 / T3）
 * 共用同一伪值注册表实例（会话生命周期闭包状态：出站签发、回程还原）。
 * judge（T5）、掩码压缩（T6）见规格 #1。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createIngressRestorationExtension } from "../src/ingress/index.ts";
import { createEgressMaskingExtension, createPlaceholderRegistry } from "../src/masking/index.ts";

/** 出站签发与回程还原共用的注册表（每次扩展加载一份，随会话存续）。 */
const registry = createPlaceholderRegistry();

/** pi-keep-secret 组合扩展工厂。 */
export default function keepSecretExtension(pi: ExtensionAPI): void {
	createEgressMaskingExtension({ registry })(pi);
	createIngressRestorationExtension({ registry })(pi);
}
