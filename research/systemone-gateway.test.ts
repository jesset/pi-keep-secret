/**
 * 真实网关验证（ticket #7 / T5）：System One 线缆格式与校准数字实测，
 * 默认跳过——三个环境变量齐备才启用（凭据只经环境变量注入，严禁入库：
 * 研究笔记 /tmp/pi-keep-secret-research/notes.md §1）：
 *
 *   PI_KEEP_SECRET_JUDGE_BASE_URL  如 https://example.cc/v1（transport 拼 /systemone）
 *   PI_KEEP_SECRET_JUDGE_MODEL     如 typesafe/jev-latest
 *   PI_KEEP_SECRET_JUDGE_API_KEY   网关 Bearer 凭据
 *
 * 运行：bun test research/systemone-gateway.test.ts
 * 问题文案直接复用 src/judge/questions.ts（措辞即概率，校准契约），
 * 线缆级问题类型为 noul（pi-ai typesafe-system-one 传输把公开 bool 映
 * 射为 noul），应答形如 {"answers":{id:{"type":"noul","noul":<0-1>}}}。
 * 断言锚点为研究笔记 §1 网关实测（密码 0.96 掩 / 订单号 0.04 弃 / gate 0.98），
 * 放宽为区间断言防网关概率轻微漂移。
 */
import { describe, expect, test } from "bun:test";
import { GATE_INSTRUCTIONS, candidateInstructions } from "../src/judge/questions.ts";

const baseUrl = process.env.PI_KEEP_SECRET_JUDGE_BASE_URL;
const model = process.env.PI_KEEP_SECRET_JUDGE_MODEL;
const apiKey = process.env.PI_KEEP_SECRET_JUDGE_API_KEY;
const configured = Boolean(baseUrl && model && apiKey);

/** 假 classifier 无法覆盖的部分：真实线缆 POST（Bearer + noul 问题）。 */
async function systemone(
	state: Record<string, unknown>,
	questions: Record<string, { type: "noul"; instructions: string }>,
): Promise<Record<string, number>> {
	const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/systemone`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, state, questions }),
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { answers?: Record<string, { noul?: number }> };
	const answers: Record<string, number> = {};
	for (const [id, answer] of Object.entries(body.answers ?? {})) {
		answers[id] = answer.noul ?? 0;
	}
	return answers;
}

describe("System One 真实网关验证（默认跳过，环境变量启用）", () => {
	test.skipIf(!configured)("线缆格式匹配 + 校准锚点：中文句中密码命中、订单号丢弃、gate 高", async () => {
		// gate + 候选同请求混发（研究笔记实测可行），state 带候选表
		const answers = await systemone(
			{
				text: "部署密码是 888888，订单号 123456，请记录。",
				candidates: { "0": "888888", "1": "123456" },
			},
			{
				gate: { type: "noul", instructions: GATE_INSTRUCTIONS },
				cand_0: { type: "noul", instructions: candidateInstructions(0) },
				cand_1: { type: "noul", instructions: candidateInstructions(1) },
			},
		);
		// 实测锚点 0.98 / 0.96 / 0.04，放宽边界防漂移
		expect(answers.gate).toBeGreaterThanOrEqual(0.5);
		expect(answers.cand_0).toBeGreaterThanOrEqual(0.7); // 密码 → 掩码阈值
		expect(answers.cand_1).toBeLessThan(0.7); // 订单号 → 丢弃
	}, 60_000);
});
