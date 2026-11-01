/**
 * 真实网关验证（ticket #7 / T5；T14 起双协议）：线缆格式与校准数字实测，
 * 默认跳过——三个环境变量齐备才启用（凭据只经环境变量注入，严禁入库：
 * 研究笔记 /tmp/pi-keep-secret-research/notes.md §1）：
 *
 *   PI_KEEP_SECRET_JUDGE_BASE_URL  如 https://example.cc/v1（线缆拼 /systemone 或 /decisions）
 *   PI_KEEP_SECRET_JUDGE_MODEL     如 typesafe/jev-latest
 *   PI_KEEP_SECRET_JUDGE_API_KEY   网关 Bearer 凭据
 *   PI_KEEP_SECRET_JUDGE_API       可选线缆协议：decisions（OpenAI Decisions，
 *                                  POST <base>/decisions）| systemone（缺省，
 *                                  POST <base>/systemone）——同一 LiteLLM 网关
 *                                  后端路由的两种线缆（T14，ticket #14）
 *
 * 运行：PI_KEEP_SECRET_JUDGE_API=decisions bun test research/systemone-gateway.test.ts
 * 问题文案直接复用 src/judge/questions.ts（措辞即概率，校准契约）。两种
 * 线缆的公共形态都是 ClassifierBoolQuestion：systemone 传输把 bool 映射为
 * 线缆级 noul（应答 {"answers":{id:{"type":"noul","noul":<0-1>}}}）；decisions
 * 传输把 bool 映射为 predicate、criteria 折进 instructions、state 作 JSON
 * 文本放 input（应答 {"answers":[{name,type:"predicate",probability:<0-1>}]}，
 * pi-ai openai-decisions 线缆形态）。云端校准：decisions 协议概率可能与
 * systemone 略有差异，断言锚点放宽为区间。
 */
import { describe, expect, test } from "bun:test";
import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";
import { candidateQuestion, gateQuestion } from "../src/judge/questions.ts";

const baseUrl = process.env.PI_KEEP_SECRET_JUDGE_BASE_URL;
const model = process.env.PI_KEEP_SECRET_JUDGE_MODEL;
const apiKey = process.env.PI_KEEP_SECRET_JUDGE_API_KEY;
const configured = Boolean(baseUrl && model && apiKey);
const apiEnv = process.env.PI_KEEP_SECRET_JUDGE_API;
if (apiEnv !== undefined && apiEnv !== "systemone" && apiEnv !== "decisions") {
	throw new Error(`PI_KEEP_SECRET_JUDGE_API 只允许 systemone|decisions，收到 ${JSON.stringify(apiEnv)}`);
}
const api = apiEnv ?? "systemone";

/** 假 classifier 无法覆盖的部分：systemone 线缆 POST（Bearer + noul 问题对象）。 */
async function systemone(
	state: Record<string, unknown>,
	questions: Record<string, ClassifierBoolQuestion>,
): Promise<Record<string, number>> {
	const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/systemone`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			state,
			questions: Object.fromEntries(
				Object.entries(questions).map(([id, question]) => [
					id,
					{ type: "noul", instructions: question.instructions },
				]),
			),
		}),
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { answers?: Record<string, { noul?: number }> };
	const answers: Record<string, number> = {};
	for (const [id, answer] of Object.entries(body.answers ?? {})) {
		answers[id] = answer.noul ?? 0;
	}
	return answers;
}

/** decisions 线缆（pi-ai openai-decisions 形态）：bool→predicate、criteria
 *  折进 instructions（与 pi-ai 传输层同构）、state 作 JSON 文本放 input、
 *  questions 为数组按 name 取应答。 */
function predicateInstructions(question: ClassifierBoolQuestion): string {
	const meanings = [
		question.criteria.true ? `True means: ${question.criteria.true}` : "",
		question.criteria.false ? `False means: ${question.criteria.false}` : "",
	].filter(Boolean);
	return meanings.length > 0 ? `${question.instructions}\n\n${meanings.join("\n")}` : question.instructions;
}

async function decisions(
	state: Record<string, unknown>,
	questions: Record<string, ClassifierBoolQuestion>,
): Promise<Record<string, number>> {
	const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/decisions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			input: JSON.stringify(state),
			questions: Object.entries(questions).map(([name, question]) => ({
				type: "predicate",
				name,
				instructions: predicateInstructions(question),
			})),
		}),
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as { answers?: { name?: string; probability?: number }[] };
	const answers: Record<string, number> = {};
	for (const answer of body.answers ?? []) {
		if (typeof answer.name === "string") {
			answers[answer.name] = answer.probability ?? 0;
		}
	}
	return answers;
}

describe("LiteLLM 网关真实验证（systemone / decisions 线缆，默认跳过，环境变量启用）", () => {
	test.skipIf(!configured)(`线缆格式匹配 + 校准锚点（${api} 线缆）：中文句中密码命中、订单号丢弃、gate 高`, async () => {
		// gate + 候选同请求混发（研究笔记实测可行），state 带候选表；
		// 问题构造协议无关（bool 公共形态），两种线缆各自映射
		const state = {
			text: "部署密码是 888888，订单号 123456，请记录。",
			candidates: { "0": "888888", "1": "123456" },
		};
		const questions: Record<string, ClassifierBoolQuestion> = {
			gate: gateQuestion(),
			cand_0: candidateQuestion(0),
			cand_1: candidateQuestion(1),
		};
		const answers = api === "decisions" ? await decisions(state, questions) : await systemone(state, questions);
		// 实测锚点 0.98 / 0.96 / 0.04，放宽边界防漂移（decisions 概率可能略有差异）
		expect(answers.gate).toBeGreaterThanOrEqual(0.5);
		expect(answers.cand_0).toBeGreaterThanOrEqual(0.7); // 密码 → 掩码阈值
		expect(answers.cand_1).toBeLessThan(0.7); // 订单号 → 丢弃
	}, 60_000);
});
