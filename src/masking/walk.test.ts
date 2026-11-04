/**
 * 遍历器 parity 矩阵（架构评审候选 3 的验收锚点）：同一份全角色夹具
 * 分别过同步执行器（maskMessageTree）与异步执行器（maskMessageTreeAsync），
 * 断言两者访问的叶集合逐消息一致、掩码后的树深度相等、豁免字段两边
 * 原样不动。collectTextLeaves 是角色/豁免知识的唯一载体，本矩阵保证
 * 「新增角色/豁免漏改」在测试里直接变红，而不是靠人工比对两份实现。
 *
 * 并发形状锚定：异步执行器按消息并发、消息内叶串行（judge 路径的既有
 * 语义）——用可观察重叠的异步掩码器验证跨消息并发确实发生。
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	collectTextLeaves,
	maskMessageTree,
	maskMessageTreeAsync,
} from "./walk.ts";

/** 掩码标记：叶内容追加此后缀（可从掩码后的树里识别哪些位置被改写）。 */
const MARK = "[M]";

/** 全角色夹具：每个可写文本叶含唯一锚串，豁免字段含哨兵值。 */
function allRolesFixture(): AgentMessage[] {
	return [
		{ role: "user", content: "user-string SECRET-U1", timestamp: 1 },
		{
			role: "user",
			content: [
				{ type: "text", text: "user-text SECRET-U2" },
				{ type: "image", data: "image-data-EXEMPT", mimeType: "image/png" },
			],
			timestamp: 2,
		},
		{
			role: "toolResult",
			content: [
				{ type: "text", text: "tool-result SECRET-T1" },
				{ type: "image", data: "tool-image-EXEMPT", mimeType: "image/png" },
			],
			toolCallId: "call-1",
			toolName: "tool",
			details: { private: "tool-details-EXEMPT" },
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "assistant-text SECRET-A1" },
				{ type: "thinking", thinking: "assistant-thinking SECRET-A2" },
				{
					type: "toolCall",
					id: "call-2",
					name: "shell",
					arguments: {
						command: "run SECRET-A3",
						nested: { token: "deep SECRET-A4", list: ["array SECRET-A5", 42, null] },
						count: 7,
					},
				},
			],
			timestamp: 4,
		} as unknown as AgentMessage,
		{
			role: "system",
			content: "system-string SECRET-S1",
			sections: { guidance: "section SECRET-S2", empty: "" },
			toolsAdded: [{ name: "exempt-tool" }],
			timestamp: 5,
		} as unknown as AgentMessage,
		{
			role: "bashExecution",
			command: "curl SECRET-B1",
			output: "shell-output SECRET-B2",
			id: "bash-1",
			timestamp: 6,
		} as unknown as AgentMessage,
		{
			role: "custom",
			content: "custom-content SECRET-C1",
			details: { custom: "custom-details-EXEMPT" },
			id: "custom-1",
			timestamp: 7,
		} as unknown as AgentMessage,
		{
			role: "compactionSummary",
			summary: "compaction-summary SECRET-M1",
			id: "compaction-1",
			timestamp: 8,
		} as unknown as AgentMessage,
		{
			role: "branchSummary",
			summary: "branch-summary SECRET-M2",
			id: "branch-1",
			timestamp: 9,
		} as unknown as AgentMessage,
	];
}

/** 记录访问次序的掩码器工厂：同步版。 */
function recordingSyncMasker(visits: string[]) {
	return (text: string): string => {
		visits.push(text);
		return `${text}${MARK}`;
	};
}

/** 记录访问次序的掩码器工厂：异步版（可选微延迟制造跨消息并发窗口）。 */
function recordingAsyncMasker(visits: string[], perMessageDelay = 0) {
	return async (text: string): Promise<string> => {
		visits.push(text);
		if (perMessageDelay > 0) {
			// 延迟仅在叶串包含锚时注入：让首条消息持有窗口，验证跨消息并发
			if (text.includes("SECRET-U1")) {
				await new Promise((resolve) => setTimeout(resolve, perMessageDelay));
			}
		}
		return `${text}${MARK}`;
	};
}

describe("遍历器 parity（同步/异步执行器共享 collectTextLeaves）", () => {
	test("同一夹具过两个执行器：逐消息访问叶一致、掩码后的树深度相等", async () => {
		const syncTree = structuredClone(allRolesFixture());
		const asyncTree = structuredClone(allRolesFixture());
		const syncVisits: string[] = [];
		const asyncVisits: string[] = [];

		maskMessageTree(syncTree, recordingSyncMasker(syncVisits));
		await maskMessageTreeAsync(asyncTree, recordingAsyncMasker(asyncVisits));

		// 掩码结果逐角色一致（同一结构知识 + 同一执行序）
		expect(asyncTree).toEqual(syncTree);
		// 全部可写叶都被掩码（无遗漏角色）：逐消息计数 [1,1,1,5,3,2,1,1,1]
		expect(syncVisits).toHaveLength(16);
		// 异步执行器跨消息并发，全局访问序交错；同一结构知识 → 访问叶多重集
		//一致（消息内保序由并发形状测试单独锚定）
		expect([...asyncVisits].sort()).toEqual([...syncVisits].sort());
		// 每个锚串都带上掩码标记（树上核验，不依赖访问记录）
		const serialized = JSON.stringify(syncTree);
		for (const anchor of ["U1", "U2", "T1", "A1", "A2", "A3", "A4", "A5", "S1", "S2", "B1", "B2", "C1", "M1", "M2"]) {
			expect(serialized).toContain(`SECRET-${anchor}${MARK}`);
		}
	});

	test("豁免字段两边原样：image data、toolResult.details、custom.details、toolsAdded 不被枚举", async () => {
		const original = allRolesFixture();
		const syncTree = structuredClone(original);
		const asyncTree = structuredClone(original);
		maskMessageTree(syncTree, recordingSyncMasker([]));
		await maskMessageTreeAsync(asyncTree, recordingAsyncMasker([]));

		for (const tree of [syncTree, asyncTree]) {
			const userImage = (tree[1] as { content: { type: string; data?: string }[] }).content[1];
			expect(userImage.data).toBe("image-data-EXEMPT");
			const toolResult = tree[2] as { details?: unknown };
			expect(toolResult.details).toEqual({ private: "tool-details-EXEMPT" });
			const toolImage = (tree[2] as { content: { type: string; data?: string }[] }).content[1];
			expect(toolImage.data).toBe("tool-image-EXEMPT");
			expect((tree[4] as { toolsAdded?: unknown }).toolsAdded).toEqual([{ name: "exempt-tool" }]);
			expect((tree[6] as { details?: unknown }).details).toEqual({ custom: "custom-details-EXEMPT" });
			// 数值/空值叶与掩码标记互斥（JSON 深遍历只改字符串叶）
			expect(JSON.stringify(tree)).not.toContain(`7${MARK}`);
		}
	});

	test("collectTextLeaves 逐角色枚举（结构知识的直接断言）", () => {
		const fixture = allRolesFixture();
		const counts = fixture.map((message) => collectTextLeaves(message).length);
		// user-string 1；user-parts 1（image 豁免）；toolResult 1；assistant
		// text+thinking+arguments 深处 3 个字符串叶 = 5；system content+2 段
		// = 3；bash command+output = 2；custom 1；两个 summary 各 1
		expect(counts).toEqual([1, 1, 1, 5, 3, 2, 1, 1, 1]);
	});

	test("异步执行器按消息并发、消息内串行（并发形状锚定）", async () => {
		const tree = structuredClone(allRolesFixture());
		const order: string[] = [];
		let firstMessageStillRunning = false;
		const masker = async (text: string): Promise<string> => {
			if (text.includes("SECRET-U1")) {
				firstMessageStillRunning = true;
				await new Promise((resolve) => setTimeout(resolve, 20));
				firstMessageStillRunning = false;
			}
			// 首条消息挂起期间，其他消息的叶若已进入则证明跨消息并发
			if (firstMessageStillRunning) {
				order.push("concurrent");
			}
			return `${text}${MARK}`;
		};
		await maskMessageTreeAsync(tree, masker);
		expect(order.length).toBeGreaterThan(0);
		// 消息内串行：assistant 消息的 5 个叶访问序 = 枚举序（无交错重排）
		const assistantVisits: string[] = [];
		await maskMessageTreeAsync(
			structuredClone(allRolesFixture()),
			async (text) => {
				if (/SECRET-A[0-9]/.test(text)) assistantVisits.push(text);
				return `${text}${MARK}`;
			},
		);
		expect(assistantVisits.map((t) => t.match(/A[0-9]/)![0])).toEqual(["A1", "A2", "A3", "A4", "A5"]);
	});
});
