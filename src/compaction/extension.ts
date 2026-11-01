/**
 * 掩码压缩扩展工厂：以 `session_before_compact` 返回完整 `CompactionResult`
 * 整体替换 pi 自带压缩（manual /compact、阈值、overflow 三路径都走此钩子），
 * `session_before_tree` 分支摘要同模式——关闭「压缩链路绕过钩子」的泄漏缺口。
 *
 * 为什么必须自己掩码：pi 的压缩调用自带 options，不经过 Agent 层
 * context/payload 钩子（研究笔记 §1）；因此这里手动把 preparation 的
 * messagesToSummarize + turnPrefixMessages（分支为 entriesToSummarize 投影）
 * 走与出站相同的掩码管线，摘要结果再按注册表还原——落盘 summary 含真值，
 * 保留区本地不动（出站照常由 context 钩子掩码）。
 *
 * 摘要调用 `ctx.modelRegistry.complete`（当前会话模型，扩展侧门面），提示词对齐
 * pi 默认（见 prompts.ts）；previousSummary / customInstructions 掩码后入
 * 摘要上下文。
 *
 * 故障策略（spec 故事 24：零泄漏）：摘要调用带重试（SUMMARY_RETRIES 次、
 * 短退避；用户中止不重试不算失败）；重试仍失败 → 返回 `{ cancel: true }`
 * 取消本次压缩（会话继续不压缩）+ ctx.ui.notify 告警与重试建议 + 状态栏
 * 标记 + 计数（无 UI 模式仅计数）。**不存在「回退 pi 默认压缩」路径**——
 * 默认压缩不掩码，摘要模型会看到真值，回退即泄漏。用户中止（abort）与
 * 失败取消同走 `{ cancel: true }`，但中止不计失败。
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
import type { MaskingPipeline } from "../masking/index.ts";
import { maskMessageTree } from "../masking/index.ts";
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
	/** 会话级掩码管线（与出站钩子共享同一注册表实例，保证伪值一致）。 */
	pipeline: MaskingPipeline;
	/** 故障状态（缺省随工厂新建）；需要观测取消的调用方（测试/状态命令）传入。 */
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

	/** 消息 → LLM 形态（convertToLlm，含 branchSummary/compactionSummary 投影）→ 掩码文本叶 → 序列化文本。 */
	const maskedConversationText = (messages: AgentMessage[]): string => {
		const llmMessages = convertToLlm(structuredClone(messages));
		maskMessageTree(llmMessages, pipeline.maskText);
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
			throw new Error(response.errorMessage ?? "摘要模型返回错误");
		}
		if (response.stopReason === "length") {
			throw new Error("摘要命中 token 上限，内容不完整");
		}
		if (response.content.some((block) => block.type === "toolCall")) {
			throw new Error("摘要尝试调用工具");
		}
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) {
			throw new Error("摘要为空");
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
				`pi-keep-secret: ${scope}失败（已重试 ${SUMMARY_RETRIES} 次仍失败），已取消本次压缩——` +
				`会话保持不压缩、未回退不掩码的默认压缩；稍后可重试 /compact——${messageOf(error)}`;
			ctx.ui.notify(warning, "warning");
			ctx.ui.setStatus(
				STATUS_KEY,
				`pi-keep-secret 掩码压缩已取消 ${status.cancellations} 次（重试后仍失败）`,
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
					conversationText: maskedConversationText(messages),
					previousSummary:
						preparation.previousSummary !== undefined
							? pipeline.maskText(preparation.previousSummary)
							: undefined,
					customInstructions:
						customInstructions !== undefined ? pipeline.maskText(customInstructions) : undefined,
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
				return reportCancellation(ctx, "掩码压缩摘要", error);
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
					conversationText: maskedConversationText(messages),
					customInstructions:
						preparation.customInstructions !== undefined
							? pipeline.maskText(preparation.customInstructions)
							: undefined,
					replaceInstructions: preparation.replaceInstructions,
				});
				const { text, usage } = await requestSummaryWithRetry(ctx, model, promptText, signal);
				return { summary: { summary: BRANCH_SUMMARY_PREAMBLE + pipeline.unmaskText(text), usage } };
			} catch (error) {
				if (error instanceof SummaryAbortError) {
					return { cancel: true };
				}
				return reportCancellation(ctx, "掩码分支摘要", error);
			}
		});
	};
}
