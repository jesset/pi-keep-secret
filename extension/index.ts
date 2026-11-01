/**
 * pi-keep-secret 扩展入口（目录扩展 index.ts 工厂）。
 *
 * 当前能力（ticket #4 / T2）：出站掩码——每次模型请求前对完整
 * transcript 的文本叶做检测并替换为确定性伪值（`context_with_system`）。
 * 回程还原（T3）、judge（T5）、掩码压缩（T6）见规格 #1。
 */
import { createEgressMaskingExtension } from "../src/masking/index.ts";

export default createEgressMaskingExtension();
