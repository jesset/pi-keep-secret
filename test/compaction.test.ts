/**
 * ticket #8 验收用例（接缝 1）：掩码压缩。正式扩展（extension/index.ts）
 * 装配出站掩码 + 回程还原 + 掩码压缩；断言只看外部行为——摘要「模型」
 * （假供应商）收到什么、session 落盘什么、故障回退是否可见。参考
 * GitHub issue jesset/pi-keep-secret#8 的 Acceptance criteria 逐条落成用例。
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makePlaceholder } from "../src/engine/index.ts";
import { createMaskedCompactionExtension, type MaskedCompactionStatus } from "../src/compaction/index.ts";
import {
	createHarnessSession,
	requestText,
	type HarnessSession,
} from "../src/harness/fake-session.ts";
import { createEgressMaskingExtension, createMaskingPipeline } from "../src/masking/index.ts";

/** 正式扩展入口（目录扩展 index.ts 工厂：出站掩码 + 掩码压缩共享注册表）。 */
const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

/** 默认检测器格式的真值样本（形状对齐内置默认检测器集）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";
/** 默认 hashLength=12 下该真值的确定性伪值（与扩展注册表同一算法）。 */
const PLACEHOLDER = makePlaceholder(OPENAI_KEY, "sk-{hash}", 12);
/** 填充文本：让第二条 user 消息足够大，压缩 cut point 落在它身上（保留区从它起）。 */
const PAD = "context padding for cut point placement. ".repeat(24);

/** 会话条目里指定角色的全部 message entry id（按时间顺序）。 */
function messageEntryIds(h: HarnessSession, role: string): string[] {
	return h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === role)
		.map((entry) => entry.id);
}

/** 会话条目里的 compaction 条目（手动/自动压缩落盘结果）。 */
function compactionEntry(h: HarnessSession) {
	return h.session.sessionManager.getEntries().find((entry) => entry.type === "compaction");
}

describe("T6 掩码压缩：session_before_compact / session_before_tree", () => {
	test("手动压缩：摘要模型只见伪值，落盘 summary 还原真值，firstKeptEntryId 指向保留区", async () => {
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				// 摘要「模型」回显伪值（它只见伪值，只能回显伪值）
				{ text: `## Critical Context\n- 部署密钥 ${PLACEHOLDER}` },
				{ text: "post-compact ack" },
			]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			// 前三笔请求（两轮对话 + 掩码摘要）里摘要模型只见伪值
			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			for (const request of requests) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
			const summaryRequest = requestText(requests[2]!);
			expect(summaryRequest).toContain(PLACEHOLDER);
			expect(summaryRequest).toContain("[User]:"); // 序列化对话进摘要提示词

			// pi 完全采用扩展结果：summary 还原真值、fromHook、firstKeptEntryId 正确
			const compaction = compactionEntry(h);
			expect(compaction).toBeDefined();
			expect(compaction?.summary).toContain(OPENAI_KEY);
			expect(compaction?.summary).not.toContain(PLACEHOLDER);
			expect(compaction?.fromHook).toBe(true);
			expect(compaction?.firstKeptEntryId).toBe(messageEntryIds(h, "user")[1]);

			// 保留区本地真值不动：压缩后下一轮出站照常由 context 钩子掩码
			await h.session.prompt("continue");
			const after = h.provider.requests()[3]!;
			expect(requestText(after)).not.toContain(OPENAI_KEY);
			expect(requestText(after)).toContain(PLACEHOLDER);
			expect(JSON.stringify(h.session.messages)).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("自动阈值压缩路径同样掩码", async () => {
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			// reserveTokens 贴近 contextWindow：一轮对话后即越过阈值触发自动压缩
			settings: { compaction: { keepRecentTokens: 50, reserveTokens: 127990 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `密钥记录 ${PLACEHOLDER}` },
			]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			// 第二轮结束后的阈值检查触发自动压缩（第三笔请求 = 掩码摘要）

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			for (const request of requests) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
			expect(requestText(requests[2]!)).toContain(PLACEHOLDER);

			const compaction = compactionEntry(h);
			expect(compaction).toBeDefined();
			expect(compaction?.fromHook).toBe(true);
			expect(compaction?.summary).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("迭代压缩：上一份 summary（本地真值）入摘要上下文前掩码，结果还原", async () => {
		const h = await createHarnessSession({
			extensionPaths: [EXTENSION_ENTRY],
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				// 第一次压缩摘要
				{ text: `## Critical Context\n- 部署密钥 ${PLACEHOLDER}` },
				{ text: "continue ack" },
				{ text: "more work ack" },
				// 第二次压缩摘要（含 previousSummary）
				{ text: `密钥仍是 ${PLACEHOLDER}` },
			]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			await h.session.compact();
			await h.session.prompt("continue with more work");
			await h.session.prompt(PAD); // 保留区再积累一轮，第二次压缩有可摘要内容
			await h.session.compact();

			// 第二次摘要请求（第 6 笔）：previousSummary（落盘真值）与新增消息均只见伪值
			const requests = h.provider.requests();
			expect(requests).toHaveLength(6);
			const secondSummary = requestText(requests[5]!);
			expect(secondSummary).not.toContain(OPENAI_KEY);
			expect(secondSummary).toContain(PLACEHOLDER);
			expect(secondSummary).toContain("<previous-summary>");

			const compactions = h.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "compaction");
			expect(compactions).toHaveLength(2);
			for (const entry of compactions) {
				expect(entry.summary).toContain(OPENAI_KEY); // 两代 summary 落盘均为真值
				expect(entry.summary).not.toContain(PLACEHOLDER);
			}
		} finally {
			h.dispose();
		}
	});

	test("摘要模型故障：显式回退 pi 默认压缩 + 告警计数可见（非静默）", async () => {
		const pipeline = createMaskingPipeline();
		const status: MaskedCompactionStatus = { fallbacks: 0, lastFallbackError: undefined };
		const h = await createHarnessSession({
			extensionFactories: [
				createEgressMaskingExtension({ pipeline }),
				createMaskedCompactionExtension({ pipeline, status }),
			],
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ error: "summarizer unavailable" }, // 掩码摘要调用失败
				{ text: "default fallback summary" }, // pi 默认压缩自带的摘要调用
			]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(4);
			// 我们的掩码摘要尝试只见伪值；失败后 pi 默认压缩接管（默认路径不掩码，
			// 摘要请求带真值——回退的已知权衡，正是回退必须可见的原因）
			expect(requestText(requests[2]!)).not.toContain(OPENAI_KEY);
			expect(requestText(requests[2]!)).toContain(PLACEHOLDER);
			expect(requestText(requests[3]!)).toContain(OPENAI_KEY);

			// 告警可见：状态计数与最近错误被记录（无 UI 的 harness 模式下即计数）
			expect(status.fallbacks).toBe(1);
			expect(status.lastFallbackError).toContain("summarizer unavailable");

			// compaction 条目由默认路径生成（非扩展来源）
			const compaction = compactionEntry(h);
			expect(compaction).toBeDefined();
			expect(compaction?.fromHook).toBeFalsy();
			expect(compaction?.summary).toContain("default fallback summary");
		} finally {
			h.dispose();
		}
	});

	test("分支摘要（session_before_tree）：摘要模型只见伪值，分支摘要条目还原真值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `分支里的密钥 ${PLACEHOLDER}` },
			]);
			await h.session.prompt("plain start");
			await h.session.prompt(`rotate to ${OPENAI_KEY}`);

			// 回退到第一条助手消息：被放弃分支 [u2, a2] 走分支摘要
			const assistantIds = messageEntryIds(h, "assistant");
			const result = await h.session.navigateTree(assistantIds[0]!, { summarize: true });

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			for (const request of requests) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
			expect(requestText(requests[2]!)).toContain(PLACEHOLDER);
			expect(result.cancelled).toBe(false);
			expect(result.summaryEntry?.summary).toContain(OPENAI_KEY);
			expect(result.summaryEntry?.summary).not.toContain(PLACEHOLDER);
			expect(result.summaryEntry?.fromHook).toBe(true);
		} finally {
			h.dispose();
		}
	});
});
