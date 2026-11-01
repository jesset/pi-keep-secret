/**
 * ticket #7 验收（接缝 2）：SystemOneJudge 两阶段判定纯逻辑——gate 短路、
 * 候选阈值、分批/截断、超长分块、fail_closed。classify 以进程内假函数
 * 替身注入；概率脚本锚定真实网关实测校准数字（研究笔记 §1：中文句中
 * 密码 0.96 命中、同句订单号 0.04 丢弃、gate 0.98）。
 *
 * 问题文案是校准契约的一部分（措辞即概率），用例锚定关键词防漂移。
 */
import { describe, expect, test } from "bun:test";
import type { ClassifierBoolQuestion, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { createSystemOneJudge } from "./system-one.ts";

/** 假 classify 的一次调用记录：state 快照 + 问题（id → 问题对象）。 */
interface RecordedCall {
	state: ClassifierContext["state"];
	questions: Array<[id: string, question: ClassifierBoolQuestion]>;
}

/** 概率脚本：gate / 候选概率与故障注入（返回错误消息则该次调用失败）。 */
interface FakeScript {
	gate?: (text: string) => number;
	candidate?: (value: string, text: string) => number;
	error?: (call: RecordedCall) => string | undefined;
}

/** 进程内假 classify：按问题 id 应答（gate / cand_i），记录全部调用。 */
function fakeClassify(script: FakeScript) {
	const calls: RecordedCall[] = [];
	const classify = async (context: ClassifierContext): Promise<ClassifierResult> => {
		const call: RecordedCall = {
			state: structuredClone(context.state),
			questions: Object.entries(context.questions) as RecordedCall["questions"],
		};
		calls.push(call);
		const error = script.error?.(call);
		if (error !== undefined) {
			return errorResult(error);
		}
		const answers: Record<string, { type: "bool"; probability: number }> = {};
		const text = typeof call.state.text === "string" ? call.state.text : "";
		for (const [id, question] of call.questions) {
			if (id === "gate") {
				answers[id] = bool(script.gate?.(text) ?? 0.02);
			} else if (question.type === "bool") {
				const index = id.slice("cand_".length);
				const candidates = call.state.candidates as Record<string, unknown> | undefined;
				const value = typeof candidates?.[index] === "string" ? candidates[index] : "";
				answers[id] = bool(script.candidate?.(value, text) ?? 0.02);
			}
		}
		return {
			api: "typesafe-system-one",
			provider: "fake",
			model: "fake-jev",
			answers,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	};
	return { classify, calls };
}

function bool(probability: number): { type: "bool"; probability: number } {
	return { type: "bool", probability };
}

function errorResult(errorMessage: string): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "fake",
		model: "fake-jev",
		answers: {},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("SystemOneJudge 两阶段判定", () => {
	test("gate 低短路：干净文本单次调用、零候选问题", async () => {
		const fake = fakeClassify({ gate: () => 0.02 });
		const judge = createSystemOneJudge({ classify: fake.classify });

		const verdict = await judge.judgeText("const x = require('node:fs');");

		expect(fake.calls).toHaveLength(1);
		const [gateId, gateQuestion] = fake.calls[0].questions[0];
		expect(gateId).toBe("gate");
		expect(gateQuestion.type).toBe("bool");
		// 校准契约锚点：gate 问「是否存在完整凭据（含短/纯数字密码）」
		expect(gateQuestion.instructions).toContain("complete password");
		expect(gateQuestion.instructions).toContain("including short or purely numeric passwords");
		expect(gateQuestion.criteria.true).toBeTruthy();
		expect(gateQuestion.criteria.false).toBeTruthy();
		expect(verdict.spans).toEqual([]);
		expect(verdict.gateHit).toBe(false);
		expect(verdict.clean).toBe(true);
		expect(verdict.failClosed).toBe(false);
		expect(verdict.calls).toBe(1);
	});

	test("候选概率达阈值掩码、低于阈值丢弃（真实校准数字锚定）", async () => {
		// 研究笔记 §1 网关实测：中文句中密码 0.96 掩码 / 同句订单号 0.04 丢弃 / gate 0.98
		const PASSWORD = "Sup3rS3cretPass";
		const ORDER = "1029384756";
		const text = `部署密码是 ${PASSWORD}，订单号 ${ORDER}，请记录。`;
		const fake = fakeClassify({
			gate: () => 0.98,
			candidate: (value) => (value === PASSWORD ? 0.96 : 0.04),
		});
		const judge = createSystemOneJudge({ classify: fake.classify });

		const verdict = await judge.judgeText(text);

		expect(verdict.gateHit).toBe(true);
		expect(verdict.spans).toEqual([
			{
				start: text.indexOf(PASSWORD),
				end: text.indexOf(PASSWORD) + PASSWORD.length,
				detector: "systemone-judge",
			},
		]);
		expect(verdict.clean).toBe(false);
		expect(verdict.calls).toBe(2); // gate + 1 个候选批
		// 候选问题形态：单次调用、逐候选 bool 问（instructions 引用 candidates.{i}）
		const candidateCall = fake.calls[1];
		expect(candidateCall).toBeDefined();
		const values = Object.values(candidateCall.state.candidates as Record<string, string>);
		expect(values).toContain(PASSWORD);
		expect(values).toContain(ORDER);
		for (const [id, question] of candidateCall.questions) {
			expect(id).toMatch(/^cand_\d+$/);
			expect(question.type).toBe("bool");
			expect(question.instructions).toContain(
				`candidates.${id.slice("cand_".length)} a complete`,
			);
		}
	});

	describe("分批与批数闸门", () => {
		/** 生成 count 个互异 6 字符候选（空格分隔）的文本。 */
		function candidateText(count: number, extra: string[] = []): string {
			const tokens = Array.from(
				{ length: count },
				(_, i) => `t${String(i + 1).padStart(5, "0")}`, // t00001..t01300，各 6 字符
			);
			return [...tokens, ...extra].join(" ");
		}

		test("候选超过 128 拆批全覆盖：200 候选 → 128 + 72 两批", async () => {
			const fake = fakeClassify({ gate: () => 0.98, candidate: () => 0.9 });
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(candidateText(200));

			expect(verdict.calls).toBe(3); // gate + 2 批
			expect(fake.calls[1].questions).toHaveLength(128);
			expect(fake.calls[2].questions).toHaveLength(72);
			expect(verdict.truncatedCandidates).toBe(0);
			expect(verdict.spans).toHaveLength(200);
		});

		test("候选超 8 批（1024）截断保最长并计数丢弃数", async () => {
			const LONG = `LONG${"y".repeat(44)}`; // 48 字符长候选
			const text = candidateText(1300, [LONG]); // 1301 候选 > 8×128
			const fake = fakeClassify({ gate: () => 0.98, candidate: () => 0.9 });
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(text);

			// 8 批 × 128 问，共 1024 候选参判，277 个短候选被丢弃
			const batchCalls = fake.calls.slice(1);
			expect(batchCalls).toHaveLength(8);
			expect(batchCalls.every((call) => call.questions.length === 128)).toBe(true);
			expect(verdict.truncatedCandidates).toBe(277);
			// 保最长：48 字符候选参判并命中；末尾短候选（最短群体）被截断丢弃
			const masked = verdict.spans.map((span) => text.slice(span.start, span.end));
			expect(masked).toContain(LONG);
			expect(masked).not.toContain("t01300");
			expect(verdict.spans).toHaveLength(1024);
		});
	});
});
