/**
 * System One judge 层公共出口（T5 交付；ADR-0001 起出站组合归掩码管线，
 * 原 judge 出站扩展已并入 createEgressMaskingExtension）。
 *
 * - `createSystemOneJudge`：两阶段判定适配器（gate 单问短路 → 候选批量
 *   bool 判定；fail_closed 兜底；classify 并发信号量）——classify 通道
 *   由调用方注入（掩码器绑定 ctx.modelRegistry.classify，纯逻辑测试注入
 *   进程内假函数）。
 * - `createJudgeTextMasker` / `createJudgeTextMaskerFor`：judge 文本掩码器
 *   （单文本叶判定+掩码，返回本层结论；不读写 clean cache——Clean
 *   Verdict 协议归掩码管线的完整出站入口）。模型缺失按 onMissing 策略
 *   处理——默认 fail_closed 掩码未验证候选，regex_only 显式降级仅 regex
 *   层 + 状态计数。
 * - `JudgeLayerOutcome.verdict`：管线维护 Clean Verdict 的依据——clean
 *   可与 regex 层零命中合成干净结论；masked/unverified 记墓碑（后者为
 *   降级放行，防 judge 恢复后被缓存短路）。
 */
export {
	createJudgeTextMasker,
	createJudgeTextMaskerFor,
	DEFAULT_JUDGE_TEMPLATE,
	MODEL_API_BY_JUDGE_API,
	type ClassifyChannel,
	type ClassifierModelRef,
	type JudgeLayerOutcome,
	type JudgeStatus,
	type JudgeTextMasker,
	type JudgeTextMaskerOptions,
	type JudgeWire,
	type ModelResolver,
} from "./masker.ts";
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
