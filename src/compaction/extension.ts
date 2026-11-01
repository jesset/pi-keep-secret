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
 * 故障策略（ticket #8 锁定）：摘要调用不可恢复错误（模型 error/length/
 * 工具调用/空文本/抛错）→ 显式回退 pi 默认压缩——返回 undefined 让 pi 默认
 * 接管，同时 ctx.ui.notify 告警 + 状态栏标记 + 计数（绝不能静默回退：默认
 * 压缩不掩码，摘要模型会看到真值）；无 UI 模式仅计数。用户中止（abort）
 * 不算回退，返回 { cancel: true } 与 pi 的取消语义对齐。
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

/** 告警状态栏键（回退发生后置为持续可见的标记，由用户清除前一直显示）。 */
const STATUS_KEY = "keep-secret-compaction";

/** 掩码压缩故障状态：回退默认压缩的计数与最近原因（/keep-secret 状态面与测试断言用）。 */
export interface MaskedCompactionStatus {
	/** 掩码摘要失败、显式回退 pi 默认压缩的次数。 */
	fallbacks: number;
	/** 最近一次回退的原因说明。 */
	lastFallbackError: string | undefined;
}

export interface MaskedCompactionOptions {
	/** 会话级掩码管线（与出站钩子共享同一注册表实例，保证伪值一致）。 */
	pipeline: MaskingPipeline;
	/** 故障状态（缺省随工厂新建）；需要观测回退的调用方（测试/状态命令）传入。 */
	status?: MaskedCompactionStatus;
}

/** 用户中止（与「摘要失败回退」区分：中止不算回退，直接取消）。 */
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
	const status: MaskedCompactionStatus = options.status ?? { fallbacks: 0, lastFallbackError: undefined };

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

	/** 显式回退：计数 + （有 UI 时）notify 告警与状态栏标记，随后返回 undefined 交给 pi 默认压缩。 */
	const reportFallback = (ctx: ExtensionContext, scope: string, error: unknown): undefined => {
		status.fallbacks += 1;
		status.lastFallbackError = `${scope}: ${messageOf(error)}`;
		if (ctx.hasUI) {
			const warning =
				`pi-keep-secret: ${scope}失败，已回退 pi 默认压缩（默认压缩不掩码，` +
				`摘要模型可能看到真值）——${messageOf(error)}`;
			ctx.ui.notify(warning, "warning");
			ctx.ui.setStatus(STATUS_KEY, `pi-keep-secret 掩码压缩已回退默认 ${status.fallbacks} 次`);
		}
		return undefined;
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
				const { text, usage } = await requestSummary(ctx, model, promptText, signal);
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
				return reportFallback(ctx, "掩码压缩摘要", error);
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
				const { text, usage } = await requestSummary(ctx, model, promptText, signal);
				return { summary: { summary: BRANCH_SUMMARY_PREAMBLE + pipeline.unmaskText(text), usage } };
			} catch (error) {
				if (error instanceof SummaryAbortError) {
					return { cancel: true };
				}
				return reportFallback(ctx, "掩码分支摘要", error);
			}
		});
	};
}
