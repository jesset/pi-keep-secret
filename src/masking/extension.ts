/**
 * 出站掩码扩展工厂：注册 `context_with_system`，在请求本地副本上做
 * 检测→掩码后原样返回（保持 index 0 system 消息；pi 对处理器输出按
 * 返回值原样使用，transcript 不受影响）。
 *
 * 掩码管线（createMaskingPipeline）：detectRegexSpans（T1）→ 注册表层
 * 幂等过滤（命中文本已是伪值则跳过，防嵌套 mask）→ redactText（注入
 * 注册表签发器：确定性伪值 + 碰撞 x 后缀兜底 + LRU 写入）；管线检测
 * 入口挂 clean cache（T4）——干净文本结论缓存短路重扫（每轮成本
 * O(新增消息)），命中 secret 的文本永不缓存、每轮重扫。
 *
 * 工厂闭包持有管线（编译态检测器 + 伪值注册表 + clean cache，会话生命
 * 周期状态）；T3（message_end 还原）/T5（judge）/T6（掩码压缩）共享
 * 同一管线实例（传 `pipeline` 复用）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMaskingPipeline, type MaskingPipeline, type MaskingPipelineOptions } from "./pipeline.ts";
import { maskMessageTree } from "./walk.ts";

export interface EgressMaskingOptions extends MaskingPipelineOptions {
	/** 复用既有管线（与掩码压缩等扩展共享注册表）；提供时优先于 detectors/registry/cleanCache。 */
	pipeline?: MaskingPipeline;
}

/** 创建出站掩码扩展（ExtensionFactory）。检测器 pattern 非法时抛错（配置加载层上报扩展错误的既定语义）。 */
export function createEgressMaskingExtension(options: EgressMaskingOptions = {}) {
	const { pipeline: shared, ...pipelineOptions } = options;
	const pipeline = shared ?? createMaskingPipeline(pipelineOptions);

	return (pi: ExtensionAPI): void => {
		pi.on("context_with_system", (event) => {
			maskMessageTree(event.messages, pipeline.maskText);
			return { messages: event.messages };
		});
	};
}
