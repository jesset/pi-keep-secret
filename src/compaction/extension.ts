/**
 * Masked compaction extension factory: returns a full `CompactionResult` from
 * `session_before_compact` to replace pi's built-in compaction entirely
 * (manual /compact, threshold and overflow all go through this hook);
 * `session_before_tree` handles branch summaries the same way — closing the
 * "compaction path bypasses hooks" leak surface.
 *
 * Why we must mask here ourselves: pi's compaction call carries its own
 * options and never passes through the Agent-level context/payload hooks
 * (research notes §1); so the preparation's messagesToSummarize +
 * turnPrefixMessages (branch hook: entriesToSummarize projection) are run
 * through the same masking chain as egress, and the summary text is restored
 * via the registry — the stored summary holds real values, the retained
 * region stays local (egress masking keeps covering it on later requests).
 *
 * Masking chain (ticket #12; ADR-0001): summary input leaves (conversation
 * messages, previousSummary, customInstructions) go through the pipeline's
 * unified egress entry — judge layer first when wired in (it needs the
 * original text), then the regex stage (idempotent over already-issued
 * placeholders; placeholder forms stay unified via first-issuer-wins). The
 * composition is owned by the pipeline, so the summary path cannot compose
 * the layers wrong. Without a judge layer the chain degrades to regex only,
 * i.e. the pre-#12 behavior for sessions without a judge config. Judge
 * failures never disturb compaction: classify errors fail closed inside the
 * masker (unverified candidates masked) and compaction continues; a missing
 * classifier model follows the egress onMissing policy (default fail_closed,
 * regex_only = explicit informed degradation to the regex layer for the
 * summary input as well). The retry/cancel path below is reserved for the
 * summarization call itself.
 *
 * The summary call goes through `ctx.modelRegistry.complete` (the session's
 * current model, the extension-side facade); the prompt mirrors pi's default
 * (see prompts.ts); previousSummary / customInstructions are masked before
 * entering the summary context.
 *
 * Failure policy (spec story 24: zero leaks): the summary call retries
 * (SUMMARY_RETRIES times with short backoff; user aborts are not failures);
 * if retries are exhausted the compaction is cancelled via `{ cancel: true }`
 * (the session continues un-compacted) + ctx.ui.notify warning with a retry
 * hint + status bar marker + counters (headless mode counts only). There is
 * **no fallback to pi's default compaction** — the default path does not
 * mask, so the summarization model would see real values; falling back would
 * leak. User aborts take the same `{ cancel: true }` path but are not counted
 * as failures.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, prepareBranchEntries, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { AnyMaskingPipeline } from "../masking/index.ts";
import { maskMessageTreeAsync } from "../masking/index.ts";
import {
	BRANCH_SUMMARY_PREAMBLE,
	buildBranchPrompt,
	buildCompactionPrompt,
	SUMMARIZATION_SYSTEM_PROMPT,
} from "./prompts.ts";

/** 分支摘要 token 预算的保留额（对齐 pi 默认 branchSummary.reserveTokens）。 */
const BRANCH_RESERVE_TOKENS = 16384;

/** 告警状态栏键（取消发生后置为持续可见的标记，由用户清除前一直显示）。 */
const STATUS_KEY = "keep-secret-compaction";

/** 摘要调用重试次数（首次失败后再试 2 次；spec 故事 24）。 */
export const SUMMARY_RETRIES = 2;
/** 重试退避步长（毫秒）：第 n 次重试前等待 n × 步长（短退避，仅吸收瞬时故障）。 */
const RETRY_BACKOFF_MS = 200;

/** 掩码压缩故障状态：重试后取消的计数与最近原因（/keep-secret 状态面与测试断言用）。 */
export interface MaskedCompactionStatus {
	/** 摘要重试耗尽而取消本次压缩的次数（会话继续不压缩，零泄漏）。 */
	cancellations: number;
	/** 最近一次取消的原因说明。 */
	lastCancellationError: string | undefined;
}

export interface MaskedCompactionOptions {
	/** Session-level masking pipeline (shares the registry with the egress
	 *  hook, keeping placeholder forms consistent). Summary-input leaves go
	 *  through the pipeline's unified egress entry (ADR-0001: judge first
	 *  when wired in, then the regex stage — callers cannot compose the
	 *  layers wrong). Without a judge layer the chain degrades to regex
	 *  only, i.e. the pre-#12 behavior for sessions without a judge config.
	 *  Judge failures never disturb compaction (fail_closed masking inside
	 *  the masker) and retry/cancel semantics stay with the summary call. */
	pipeline: AnyMaskingPipeline;
	/** Failure status (created by this factory when omitted); callers that
	 *  need to observe cancellations (tests, status command) pass one in. */
	status?: MaskedCompactionStatus;
}

/** 用户中止（与「摘要失败取消」区分：中止不算失败，直接取消）。 */
class SummaryAbortError extends Error {
	constructor() {
		super("掩码摘要被中止");
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 一次成功的摘要调用：掩码提示词进、还原前的原文出。 */
interface SummaryCall {
	text: string;
	usage: Usage;
}

/** 创建掩码压缩扩展（注册 session_before_compact / session_before_tree）。 */
export function createMaskedCompactionExtension(options: MaskedCompactionOptions) {
	const { pipeline } = options;
	const status: MaskedCompactionStatus =
		options.status ?? { cancellations: 0, lastCancellationError: undefined };

	/** Mask one summary-input text leaf with the pipeline's unified egress
	 *  entry (ADR-0001): judge layer first (when wired in — it needs the
	 *  original text), then the regex stage, with the Clean Verdict protocol
	 *  maintained at the entry. Judge classify failures fail closed inside
	 *  the masker, so masking never interrupts compaction; retry/cancel
	 *  semantics are owned by the summary call. */
	const maskSummaryInput = async (text: string, ctx: ExtensionContext): Promise<string> =>
		"mask" in pipeline ? await pipeline.mask(text, ctx) : pipeline.maskText(text);

	/** Messages → LLM shape (convertToLlm, incl. branchSummary/compactionSummary
	 *  projections) → mask text leaves → serialized conversation text. */
	const maskedConversationText = async (
		messages: AgentMessage[],
		ctx: ExtensionContext,
	): Promise<string> => {
		const llmMessages = convertToLlm(structuredClone(messages));
		await maskMessageTreeAsync(llmMessages, (text) => maskSummaryInput(text, ctx));
		return serializeConversation(llmMessages);
	};

	/**
	 * 摘要调用：当前会话模型经 ctx.modelRegistry.complete（扩展侧同步兼容门面，
	 * 请求时认证；嵌套调用不经过 Agent 层钩子，掩码必须在此前完成）。失败判定
	 * 对齐 pi 默认（error/length/工具调用/空文本均不可持久化为压缩检查点）。
	 */
	const requestSummary = async (
		ctx: ExtensionContext,
		model: NonNullable<ExtensionContext["model"]>,
		promptText: string,
		signal: AbortSignal,
	): Promise<SummaryCall> => {
		const context = normalizeContext({
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: promptText }],
					timestamp: Date.now(),
				},
			],
		});
		let response;
		try {
			// cacheRetention none：一次性摘要不写提示缓存（对齐 pi completeSummarization）
			response = await ctx.modelRegistry.complete(model, context, {
				signal,
				cacheRetention: "none",
			});
		} catch (error) {
			if (signal.aborted) throw new SummaryAbortError();
			throw error;
		}
		if (signal.aborted || response.stopReason === "aborted") {
			throw new SummaryAbortError();
		}
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "summarization model returned an error");
		}
		if (response.stopReason === "length") {
			throw new Error("summary hit the token limit and is incomplete");
		}
		if (response.content.some((block) => block.type === "toolCall")) {
			throw new Error("summary response attempted a tool call");
		}
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) {
			throw new Error("empty summary");
		}
		return { text, usage: response.usage };
	};

	/** 中止感知的短退避：等待 ms 毫秒，期间被中止则按用户中止处理。 */
	const backoff = (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new SummaryAbortError());
				return;
			}
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(new SummaryAbortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});

	/**
	 * 摘要调用（带重试）：首次失败后短退避重试 SUMMARY_RETRIES 次（仅吸收
	 * 瞬时故障；对齐 pi 默认压缩自带的重试语义）；用户中止不重试直接抛出。
	 */
	const requestSummaryWithRetry = async (
		ctx: ExtensionContext,
		model: NonNullable<ExtensionContext["model"]>,
		promptText: string,
		signal: AbortSignal,
	): Promise<SummaryCall> => {
		let lastError: unknown;
		for (let attempt = 0; attempt <= SUMMARY_RETRIES; attempt++) {
			if (attempt > 0) {
				await backoff(attempt * RETRY_BACKOFF_MS, signal);
			}
			try {
				return await requestSummary(ctx, model, promptText, signal);
			} catch (error) {
				if (error instanceof SummaryAbortError) throw error; // 用户中止不重试
				lastError = error;
			}
		}
		throw lastError;
	};

	/** 取消本次压缩：计数 + （有 UI 时）notify 告警与重试建议、状态栏标记。
	 *  返回 { cancel: true }——绝不回退 pi 默认压缩（默认路径不掩码，回退
	 *  即泄漏，spec 故事 24）。 */
	const reportCancellation = (
		ctx: ExtensionContext,
		scope: string,
		error: unknown,
	): { cancel: true } => {
		status.cancellations += 1;
		status.lastCancellationError = `${scope}: ${messageOf(error)}`;
		if (ctx.hasUI) {
			const warning =
				`pi-keep-secret: ${scope} failed after ${SUMMARY_RETRIES} retries — compaction cancelled. ` +
				`The session stays uncompacted; there is no fallback to the unmasked default compaction. ` +
				`Retry /compact later — ${messageOf(error)}`;
			ctx.ui.notify(warning, "warning");
			ctx.ui.setStatus(
				STATUS_KEY,
				`pi-keep-secret masked compaction cancelled ${status.cancellations}× (retries exhausted)`,
			);
		}
		return { cancel: true };
	};

	return (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", async (event, ctx) => {
			const { preparation, customInstructions, signal } = event;
			const model = ctx.model;
			if (!model) return; // pi 在发钩子前已校验模型；防御性放行默认路径
			const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
			try {
				const promptText = buildCompactionPrompt({
					conversationText: await maskedConversationText(messages, ctx),
					previousSummary:
						preparation.previousSummary !== undefined
							? await maskSummaryInput(preparation.previousSummary, ctx)
							: undefined,
					customInstructions:
						customInstructions !== undefined
							? await maskSummaryInput(customInstructions, ctx)
							: undefined,
				});
				const { text, usage } = await requestSummaryWithRetry(ctx, model, promptText, signal);
				const compaction: CompactionResult = {
					summary: pipeline.unmaskText(text),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage,
				};
				return { compaction };
			} catch (error) {
				if (error instanceof SummaryAbortError) {
					return { cancel: true };
				}
				return reportCancellation(ctx, "masked compaction summary", error);
			}
		});

		pi.on("session_before_tree", async (event, ctx) => {
			const { preparation, signal } = event;
			if (!preparation.userWantsSummary) return; // 不要求摘要：正常树导航
			const model = ctx.model;
			if (!model) return;
			try {
				const tokenBudget = (model.contextWindow || 128000) - BRANCH_RESERVE_TOKENS;
				const { messages } = prepareBranchEntries(preparation.entriesToSummarize, tokenBudget);
				if (messages.length === 0) return; // pi 默认路径自行产出「No content to summarize」
				const promptText = buildBranchPrompt({
					conversationText: await maskedConversationText(messages, ctx),
					customInstructions:
						preparation.customInstructions !== undefined
							? await maskSummaryInput(preparation.customInstructions, ctx)
							: undefined,
					replaceInstructions: preparation.replaceInstructions,
				});
				const { text, usage } = await requestSummaryWithRetry(ctx, model, promptText, signal);
				return { summary: { summary: BRANCH_SUMMARY_PREAMBLE + pipeline.unmaskText(text), usage } };
			} catch (error) {
				if (error instanceof SummaryAbortError) {
					return { cancel: true };
				}
				return reportCancellation(ctx, "masked branch summary", error);
			}
		});
	};
}
