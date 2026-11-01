/**
 * System One judge 层公共出口（T5 交付）。
 *
 * - `createSystemOneJudge`：两阶段判定适配器（gate 单问短路 → 候选批量
 *   bool 判定；fail_closed 兜底；classify 并发信号量）——classify 通道
 *   由调用方注入（扩展层绑定 ctx.modelRegistry.classify，纯逻辑测试注入
 *   进程内假函数）。
 * - `createJudgeEgressExtension`：出站扩展工厂（context_with_system 上
 *   的 judge 检测器；模型缺失显式降级仅 regex 层 + 状态计数）。须先于
 *   regex 出站扩展注册。T4 配置层合入前由装配方显式传 modelRef。
 * - `JudgeVerdict.clean`：T4 clean cache 的协同接口（命中/gate 命中/故障
 *   文本不可缓存 clean）；T4 合入后在扩展层接缓存查询。
 */
export {
	createJudgeEgressExtension,
	DEFAULT_JUDGE_TEMPLATE,
	type ClassifyChannel,
	type ClassifierModelRef,
	type JudgeEgressOptions,
	type JudgeStatus,
	type ModelResolver,
} from "./extension.ts";
export {
	DEFAULT_BATCH_SIZE,
	DEFAULT_CANDIDATE_THRESHOLD,
	DEFAULT_CONCURRENCY,
	DEFAULT_DETECTOR_NAME,
	DEFAULT_GATE_THRESHOLD,
	DEFAULT_MAX_BATCHES,
	DEFAULT_MAX_CHARS,
	createSystemOneJudge,
	type ClassifyFn,
	type JudgeVerdict,
	type SystemOneJudge,
	type SystemOneJudgeOptions,
} from "./system-one.ts";
export { chunkText, type TextChunk } from "./chunk.ts";
export { GATE_INSTRUCTIONS, GATE_QUESTION_NAME, candidateQuestion, gateQuestion } from "./questions.ts";
