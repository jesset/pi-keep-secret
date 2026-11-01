/**
 * System One judge 适配器：pi-ai 原生 Classifier 协议上的两阶段判定
 * （ticket #7 / T5）。语义基准：参考实现 secret_mask.py 的
 * _detect_llm_systemone/_systemone_chunk（只读移植，行为对齐）。
 *
 * 两阶段：
 * 1. gate 单 bool 问（全文是否存在完整凭据，含短/纯数字密码）——
 *    低于阈值（默认 0.5）即短路，不再发起候选问题；
 * 2. gate 命中后抽取 ASCII 高熵候选（engine extractCandidates），逐候选
 *    bool 问（默认阈值 0.7），按批（默认 128 问/次）发起 classify。
 *
 * classify never-rejects（pi-ai 契约）：错误在 result.stopReason==="error"，
 * 映射为 fail_closed——未获得判定结论的候选一律掩码（真值由注册表本地
 * 保留，可恢复）。judge 与外界的唯一通道是注入的 ClassifyFn（规格 #1
 * 故事 34：判定模型/端点是配置，不是代码）。
 */
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { extractCandidates, mergeSpans, type Candidate, type Span } from "../engine/index.ts";
import { chunkText } from "./chunk.ts";
import { GATE_QUESTION_NAME, candidateQuestion, gateQuestion } from "./questions.ts";

/** classify 通道：(state, questions) → 结果。扩展层以 ctx.modelRegistry.classify 注入。 */
export type ClassifyFn = (context: ClassifierContext) => Promise<ClassifierResult>;

/** 候选批量判定单次调用的问题数上限：对齐 litellm/OpenAI decisions 协议硬上限。 */
export const DEFAULT_BATCH_SIZE = 128;
/** 批数闸门：超过则截断保最长（成本护栏，防病态大块失控）。 */
export const DEFAULT_MAX_BATCHES = 8;
/** gate 阈值默认（低于即短路）。 */
export const DEFAULT_GATE_THRESHOLD = 0.5;
/** 候选阈值默认（达到才掩码）。 */
export const DEFAULT_CANDIDATE_THRESHOLD = 0.7;
/** 超长消息分块上限（judge_max_chars）。 */
export const DEFAULT_MAX_CHARS = 24000;
/** classify 调用并发信号量默认路数。 */
export const DEFAULT_CONCURRENCY = 8;
/** judge 命中 span 的检测器名（掩码层据此取伪值模板）。 */
export const DEFAULT_DETECTOR_NAME = "systemone-judge";

export interface SystemOneJudgeOptions {
	/** classify 通道（modelRegistry.classify 绑定判定模型）。 */
	classify: ClassifyFn;
	/** 命中 span 的检测器名，默认 "systemone-judge"。 */
	detectorName?: string;
	/** gate 阈值，默认 0.5。 */
	gateThreshold?: number;
	/** 候选阈值，默认 0.7。 */
	candidateThreshold?: number;
	/** 每次批量判定的问题数上限，默认 128。 */
	batchSize?: number;
	/** 批数上限（超过截断保最长），默认 8。 */
	maxBatches?: number;
	/** 超长消息分块上限，默认 24000。 */
	maxChars?: number;
	/** 候选最小长度（engine extractCandidates 入参），默认 6。 */
	minCandidateLength?: number;
	/** classify 调用并发上限，默认 8。 */
	concurrency?: number;
}

/** 一次 judgeText 的判定结论（span 区间相对完整原文）。 */
export interface JudgeVerdict {
	/** 应掩码区间（命中候选 + fail_closed 未验证候选，已合并去重叠）。 */
	spans: Span[];
	/** 任一块 gate 达到阈值。 */
	gateHit: boolean;
	/** 干净结论：零命中、零 gate 命中、零 fail_closed（T4 clean cache 的缓存
	 *  依据：命中、gate 命中或故障的文本均不可缓存 clean）。 */
	clean: boolean;
	/** fail_closed 已生效：存在未验证候选被一律掩码（classify 错误，或
	 *  stop 结果应答缺失——未获判定结论 ≠ 判定非凭据）。 */
	failClosed: boolean;
	/** 首个 classify 错误信息（stopReason!=="stop"；扩展层上报扩展错误）。 */
	error?: string;
	/** 被 maxBatches 截断丢弃的候选数（状态显示）。 */
	truncatedCandidates: number;
	/** classify 调用次数（gate + 候选批；测试锚定与观测）。 */
	calls: number;
}

/** SystemOneJudge：会话生命周期内复用（共享调用信号量），线程安全。 */
export interface SystemOneJudge {
	/** 检测器名（span.detector / 伪值模板键）。 */
	readonly detectorName: string;
	/** 对一段完整文本做两阶段判定。 */
	judgeText(text: string): Promise<JudgeVerdict>;
}

/** 创建 System One judge 适配器。 */
export function createSystemOneJudge(options: SystemOneJudgeOptions): SystemOneJudge {
	const detectorName = options.detectorName ?? DEFAULT_DETECTOR_NAME;
	const gateThreshold = options.gateThreshold ?? DEFAULT_GATE_THRESHOLD;
	const candidateThreshold = options.candidateThreshold ?? DEFAULT_CANDIDATE_THRESHOLD;
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const minCandidateLength = options.minCandidateLength ?? 6;
	const classify = options.classify;

	return {
		detectorName,
		async judgeText(text) {
			let calls = 0;
			const spans: Span[] = [];
			let gateHit = false;
			let failClosed = false;
			let error: string | undefined;
			const noteJudgeError = (result: ClassifierResult): void => {
				if (error === undefined) {
					error = result.errorMessage ?? `judge stopReason=${result.stopReason}`;
				}
				failClosed = true;
			};
			/** fail_closed 兑底：候选未获判定结论 → 一律掩码（真值由注册表本地可恢复）。 */
			const maskUnverified = (candidates: readonly Candidate[], offset: number): void => {
				for (const candidate of candidates) {
					spans.push({
						start: offset + candidate.start,
						end: offset + candidate.end,
						detector: detectorName,
					});
				}
			};
			let truncatedCandidates = 0;
			for (const chunk of chunkText(text, maxChars)) {
				calls++;
				const gateResult = await classify({
					state: { text: chunk.text },
					questions: { [GATE_QUESTION_NAME]: gateQuestion() },
				});
				// classify never-rejects：错误在 stopReason。gate 即失败则该块候选
				// 全部未验证 → 全掩，且不追加注定失败的候选批（不锤已死的 judge）
				if (gateResult.stopReason !== "stop") {
					noteJudgeError(gateResult);
					maskUnverified(extractCandidates(chunk.text, minCandidateLength), chunk.offset);
					continue;
				}
				const gateAnswer = gateResult.answers[GATE_QUESTION_NAME];
				const probability =
					gateAnswer !== undefined && gateAnswer.type === "bool" ? gateAnswer.probability : 0;
				if (probability < gateThreshold) {
					continue; // gate 低短路：不发起候选问题
				}
				gateHit = true;
				let candidates = extractCandidates(chunk.text, minCandidateLength);
				if (candidates.length === 0) {
					continue;
				}
				// 批数闸门：仅当超过 maxBatches 才截断保最长（成本护栏；短候选恰是
				// minCandidateLen 要兜的低熵密码，因此拆批全覆盖优先，不直接截断）
				const keep = batchSize * maxBatches;
				if (candidates.length > keep) {
					truncatedCandidates += candidates.length - keep;
					candidates = [
						...[...candidates]
							.sort((a, b) => b.end - b.start - (a.end - a.start))
							.slice(0, keep)
							.sort((a, b) => a.start - b.start),
					];
				}
				const batches: Candidate[][] = [];
				for (let i = 0; i < candidates.length; i += batchSize) {
					batches.push(candidates.slice(i, i + batchSize));
				}
				const responses = await Promise.all(
					batches.map(async (batch) => {
						calls++;
						return await classify({
							state: {
								text: chunk.text,
								candidates: Object.fromEntries(batch.map((c, i) => [String(i), c.value])),
							},
							questions: Object.fromEntries(
								batch.map((_, i) => [`cand_${i}`, candidateQuestion(i)]),
							),
						});
					}),
				);
				for (const [b, batch] of batches.entries()) {
					const result = responses[b];
					// 整批故障：该批候选全部未验证 → 全掩；其余批的判定结论照常采纳
					if (result.stopReason !== "stop") {
						noteJudgeError(result);
						maskUnverified(batch, chunk.offset);
						continue;
					}
					for (const [i, candidate] of batch.entries()) {
						const answer = result.answers[`cand_${i}`];
						if (answer === undefined || answer.type !== "bool") {
							// stop 结果缺应答：该候选未验证 → 掩码（非「判定非凭据」的丢弃）
							failClosed = true;
							maskUnverified([candidate], chunk.offset);
							continue;
						}
						if (answer.probability < candidateThreshold) {
							continue; // 判定非凭据：丢弃
						}
						spans.push({
							start: chunk.offset + candidate.start,
							end: chunk.offset + candidate.end,
							detector: detectorName,
						});
					}
				}
			}
			return {
				spans: mergeSpans(spans),
				gateHit,
				clean: spans.length === 0 && !gateHit && !failClosed,
				failClosed,
				error,
				truncatedCandidates,
				calls,
			};
		},
	};
}
