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
	/** 对 true 的候选不返回应答（模拟 stop 结果缺项：未验证）。 */
	dropAnswer?: (value: string) => boolean;
	/** 应答前挂起（并发观测）；缺省即时返回。 */
	stall?: (call: RecordedCall) => Promise<void> | undefined;
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
		await script.stall?.(call);
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
				if (script.dropAnswer?.(value)) {
					continue; // 无应答（未验证）
				}
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

	describe("超长消息分块（24000/块、重叠 min(2000, maxChars/4)）", () => {
		test("跨块边界的 secret 经重叠完整判定，span 坐标为全文绝对坐标", async () => {
			// 构造（先拼前缀到精确长度再插入 SECRET 再补尾，杜绝填充循环把
			// 位置推离预期）：前缀词长 2 < 6 不产候选；SECRET 跨 24000 块界
			const SECRET = "XboundPass99-Kq7zt4wYhx"; // 23 字符
			const SECRET_START = 23989; // SECRET 前有 23989 字符，跨入第二块
			const TOTAL = 50000;
			const prefix = "ab cd ".repeat(3000).padEnd(SECRET_START, " ");
			const tail = " xy".padEnd(TOTAL - SECRET_START - SECRET.length, " ");
			const text = prefix + SECRET + tail;
			// 构造自检：断言锚点与构造一致
			expect(prefix.length).toBe(SECRET_START);
			expect(text.length).toBe(TOTAL);
			expect(text.slice(SECRET_START, SECRET_START + SECRET.length)).toBe(SECRET);
			const fake = fakeClassify({
				gate: () => 0.98,
				candidate: (value) => (value === SECRET ? 0.96 : 0.02),
			});
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(text);

			// 块界 24000 处 secret 被切成 11+12 字符两段，仅重叠块内完整出现
			expect(verdict.spans).toEqual([
				{
					start: SECRET_START,
					end: SECRET_START + SECRET.length,
					detector: "systemone-judge",
				},
			]);
			// 50000 字符 → 3 块（步长 24000-2000=22000）：[0,24000) [22000,46000) [44000,50000)
			const gates = fake.calls.filter((call) => call.questions[0]?.[0] === "gate");
			expect(gates.map((call) => (call.state.text as string).length)).toEqual([24000, 24000, 6000]);
			// 每块各 1 次 gate；块 1 的边界残段与块 2 的完整 secret 各 1 个候选批
			expect(verdict.calls).toBe(5);
			// 块 1 内 secret 残段（11 字符）被判非凭据丢弃：参判但不产 span
			const askedValues = fake.calls
				.filter((call) => call.state.candidates !== undefined)
				.flatMap((call) => Object.values(call.state.candidates as Record<string, string>));
			expect(askedValues).toContain("XboundPass9");
			expect(askedValues).toContain(SECRET);
			expect(verdict.clean).toBe(false);
		});
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

		test("候选超 8 批（1024）截断保最长：丢弃的短候选按未验证一并掩码并计数", async () => {
			const LONG = `LONG${"y".repeat(44)}`; // 48 字符长候选
			const text = candidateText(1300, [LONG]); // 1301 候选 > 8×128
			const fake = fakeClassify({ gate: () => 0.98, candidate: () => 0.9 });
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(text);

			// 8 批 × 128 问，共 1024 候选参判，277 个短候选被截断丢弃
			const batchCalls = fake.calls.slice(1);
			expect(batchCalls).toHaveLength(8);
			expect(batchCalls.every((call) => call.questions.length === 128)).toBe(true);
			expect(verdict.truncatedCandidates).toBe(277);
			// 保最长参判命中（48 字符候选）；末尾短候选（最短群体）被截断丢弃——
			// 未验证定义上不该出站：丢弃者与命中者一并掩码（故事 19）
			const masked = verdict.spans.map((span) => text.slice(span.start, span.end));
			expect(masked).toContain(LONG);
			expect(masked).toContain("t01300");
			expect(verdict.spans).toHaveLength(1301); // 1024 参判命中 + 277 丢弃兑底
			expect(verdict.clean).toBe(false); // 非零 span：永不缓存干净
		});

		test("截断场景的短低熵密码也被掩（未验证候选不放行）", async () => {
			const SHORT_PASSWORD = "letmein99"; // 9 字符短低熵密码（regex 不可见形状）
			const LONG_TOKEN = "AAAABBBBCCCCDDDD1"; // 17 字符长候选
			const text = `密码 ${SHORT_PASSWORD} 与令牌 ${LONG_TOKEN}`;
			// batchSize=1、maxBatches=1 → 仅保 1 个最长候选，短密码被截断丢弃
			const fake = fakeClassify({ gate: () => 0.98, candidate: () => 0.9 });
			const judge = createSystemOneJudge({
				classify: fake.classify,
				batchSize: 1,
				maxBatches: 1,
			});

			const verdict = await judge.judgeText(text);

			expect(verdict.truncatedCandidates).toBe(1);
			const masked = verdict.spans.map((span) => text.slice(span.start, span.end));
			// 长候选参判命中；短密码虽被丢弃但未验证——一律掩码，零未验证出站
			expect(masked).toEqual(expect.arrayContaining([SHORT_PASSWORD, LONG_TOKEN]));
			expect(verdict.spans).toHaveLength(2);
		});
	});

	describe("fail_closed：classify 故障时未验证候选一律掩码", () => {
		test("gate 调用错误 → 该块候选全部掩码，不再追加候选调用", async () => {
			const PASSWORD = "N0tw0rkDown-K3y";
			const ORDER = "1029384756";
			const text = `密码 ${PASSWORD} 与订单 ${ORDER} 一起出站`;
			const fake = fakeClassify({
				gate: () => 0.98,
				candidate: () => 0.96,
				error: (call) => (call.state.candidates === undefined ? "judge unreachable" : undefined),
			});
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(text);

			// 故障时零未验证出站：两个候选全部掩码（真值由注册表本地可恢复）
			expect(verdict.spans.map((span) => text.slice(span.start, span.end))).toEqual(
				expect.arrayContaining([PASSWORD, ORDER]),
			);
			expect(verdict.spans).toHaveLength(2);
			expect(verdict.failClosed).toBe(true);
			expect(verdict.error).toBe("judge unreachable");
			expect(verdict.clean).toBe(false); // 故障文本不可缓存 clean（T4 接口预留）
			expect(verdict.calls).toBe(1); // judge 已死：不追加注定失败的候选批
		});

		test("候选批错误 → 该批候选全掩码，其余批判定结论不受影响", async () => {
			// 200 候选 → 128 + 72 两批；第二批（72 问）故障：其候选全掩，
			// 第一批正常判 0.02 丢弃（判定非凭据 ≠ 未验证，不掩）
			const tokens = Array.from({ length: 200 }, (_, i) => `t${String(i + 1).padStart(5, "0")}`);
			const text = tokens.join(" ");
			const fake = fakeClassify({
				gate: () => 0.98,
				candidate: () => 0.02,
				error: (call) =>
					call.state.candidates !== undefined && call.questions.length < 100
						? "batch 2 exploded"
						: undefined,
			});
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(text);

			expect(verdict.failClosed).toBe(true);
			expect(verdict.error).toBe("batch 2 exploded");
			// token k（0 基）起点 = 7k（等长 6 字符、单空格分隔）——故障批 = t00129..t00200
			const expected = tokens.slice(128).map((token, i) => ({
				start: 7 * (128 + i),
				end: 7 * (128 + i) + 6,
				detector: "systemone-judge",
			}));
			expect(verdict.spans).toEqual(expected);
			expect(verdict.spans).toHaveLength(72);
		});

		test("stop 结果中缺失应答的候选视为未验证一并掩码", async () => {
			const PASSWORD = "An5wered-K3y";
			const ORDER = "1029384756";
			const text = `密码 ${PASSWORD}，订单 ${ORDER}`;
			const fake = fakeClassify({
				gate: () => 0.98,
				candidate: () => 0.02,
				dropAnswer: (value) => value === ORDER, // ORDER 无应答：未验证 → 掩
			});
			const judge = createSystemOneJudge({ classify: fake.classify });

			const verdict = await judge.judgeText(text);

			// PASSWORD 判非凭据（0.02）不掩；ORDER 未获判定结论 → fail_closed 掩码
			expect(verdict.spans.map((span) => text.slice(span.start, span.end))).toEqual([ORDER]);
			expect(verdict.failClosed).toBe(true);
			expect(verdict.clean).toBe(false);
		});
	});

	describe("classify 调用并发信号量（默认 8 路，跨 judgeText 共享）", () => {
		/** 统计在途回调峰值与总调用的假 classify（stall 挂起制造并发窗口）。 */
		function concurrencyTrackingClassify(script: FakeScript) {
			const fake = fakeClassify({
				...script,
				stall: async () => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await new Promise((resolve) => setTimeout(resolve, 5));
					inFlight--;
				},
			});
			return fake;
		}
		let inFlight = 0;
		let peak = 0;

		test("单消息多批并发受限：concurrency 2 时 4 批峰值不超 2", async () => {
			inFlight = 0;
			peak = 0;
			// 500 候选 → 128+128+128+116 四批（无信号量时四批同时发起）
			const tokens = Array.from({ length: 500 }, (_, i) => `t${String(i + 1).padStart(5, "0")}`);
			const fake = concurrencyTrackingClassify({ gate: () => 0.98, candidate: () => 0.02 });
			const judge = createSystemOneJudge({ classify: fake.classify, concurrency: 2 });

			const verdict = await judge.judgeText(tokens.join(" "));

			expect(verdict.calls).toBe(5); // gate + 4 批全部发出
			expect(peak).toBeLessThanOrEqual(2);
			expect(peak).toBeGreaterThan(1); // 确有并发（串行执行峰值恒为 1）
		});

		test("消息级并发共享同一信号量：两消息并发且 concurrency 1 时全程串行", async () => {
			inFlight = 0;
			peak = 0;
			const fake = concurrencyTrackingClassify({ gate: () => 0.02 }); // 干净文本：各 1 次 gate
			const judge = createSystemOneJudge({ classify: fake.classify, concurrency: 1 });

			await Promise.all([judge.judgeText("clean alpha"), judge.judgeText("clean beta")]);

			expect(fake.calls).toHaveLength(2);
			expect(peak).toBe(1); // 跨消息也互斥
		});
	});
});
