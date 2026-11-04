/**
 * 出站掩码扩展工厂（ADR-0001：单扩展单次遍历）：注册 `context_with_system`，
 * 对请求本地副本的文本叶调用掩码管线的统一出站入口——配置 judge 时按消息
 * 并发异步掩码（judge 层判定原文 → regex 兜底 → Clean Verdict 一次写入），
 * 未配置 judge 时同步快路径（regex 检测，零 Promise 成本）。原 judge/regex
 * 双 hook 串联与「judge 必须先注册」的顺序契约已随管线内聚消失。
 *
 * 掩码管线（createMaskingPipeline）持有检测器、伪值注册表、clean cache 与
 * judge 层（若接线），会话生命周期状态；回程还原（T3）/掩码压缩（T6）共享
 * 同一管线实例（传 `pipeline` 复用）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createMaskingPipeline,
	type AnyMaskingPipeline,
	type MaskingPipelineOptions,
} from "./pipeline.ts";
import { maskMessageTree, maskMessageTreeAsync } from "./walk.ts";

export interface EgressMaskingOptions extends MaskingPipelineOptions {
	/** 复用既有管线（与掩码压缩等扩展共享注册表）；提供时优先于 detectors/judge/registry/cleanCache。 */
	pipeline?: AnyMaskingPipeline;
}

/** 创建出站掩码扩展（ExtensionFactory）。检测器 pattern 非法时抛错（配置加载层上报扩展错误的既定语义）。 */
export function createEgressMaskingExtension(options: EgressMaskingOptions = {}) {
	const { pipeline: shared, ...pipelineOptions } = options;
	const pipeline: AnyMaskingPipeline = shared ?? createMaskingPipeline(pipelineOptions);

	return (pi: ExtensionAPI): void => {
		pi.on("context_with_system", (event, ctx) => {
			if ("mask" in pipeline) {
				// judge 接线：异步完整掩码（入口一次查 clean → judge → regex → 一次写）
				return maskMessageTreeAsync(event.messages, (text) => pipeline.mask(text, ctx)).then(
					() => ({ messages: event.messages }),
				);
			}
			// regex 快路径：同步掩码（clean cache 短路 → 检测 → 写入结论）
			maskMessageTree(event.messages, pipeline.maskText);
			return { messages: event.messages };
		});
	};
}
