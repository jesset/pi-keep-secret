/**
 * Ticket #12 acceptance cases (seam 1): compaction summary input goes through
 * the judge layer. The summarization request is the last egress surface that
 * only ran the regex pipeline — a judge-only secret (low-entropy password,
 * regex-invisible) left the session with the summary prompt even though the
 * main chain (context_with_system) already had judge coverage.
 *
 * Assertions stay at the public seam: what the summary "model" (faux view)
 * receives, what lands in the session as the stored summary, and which
 * status counters moved. Since ADR-0001 the composition IS the formal one:
 * createConfiguredMaskingExtension builds the judged pipeline (judge layer
 * internal to the pipeline) and the masked compaction extension consumes the
 * pipeline's unified egress entry — the manual judge/regex hook wiring that
 * once drifted from the formal entry no longer exists. The full entry itself
 * is covered by the last two cases via createKeepSecretExtension.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { makePlaceholder } from "../src/engine/index.ts";
import {
	createMaskedCompactionExtension,
	type MaskedCompactionStatus,
} from "../src/compaction/index.ts";
import { createConfiguredMaskingExtension } from "../src/config/index.ts";
import {
	createHarnessSession,
	requestText,
	type HarnessSession,
} from "../src/harness/fake-session.ts";
import { createKeepSecretExtension } from "../extension/index.ts";
import { fakeClassifierModel, scriptClassify } from "./helpers.ts";

/** 正式组合的临时配置目录（afterEach 统一清理）。 */
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Judge-only anchor: low-entropy password, invisible to the regex layer (judge hit 0.96). */
const PASSWORD = "N0Judged-K3y9wq";
/** Regex-layer anchor (built-in default detector). */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";
/** Non-credential anchor (judge drop 0.04; masked only under fail_closed). */
const ORDER = "1029384756";
/** Deterministic judge-template placeholders (same algorithm as the shared registry). */
const PASSWORD_PLACEHOLDER = makePlaceholder(PASSWORD, "key-{hash}", 12);
const ORDER_PLACEHOLDER = makePlaceholder(ORDER, "key-{hash}", 12);
const OPENAI_PLACEHOLDER = makePlaceholder(OPENAI_KEY, "sk-{hash}", 12);
/** Padding so the second user message is large enough to hold the cut point. */
const PAD = "context padding for cut point placement. ".repeat(24);

/** Entry ids of all message entries with the given role, in session order. */
function messageEntryIds(h: HarnessSession, role: string): string[] {
	return h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === role)
		.map((entry) => entry.id);
}

/** The compaction entry stored in the session (result of a manual/auto compaction). */
function compactionEntry(h: HarnessSession) {
	return h.session.sessionManager.getEntries().find((entry) => entry.type === "compaction");
}

/**
 * Full compaction chain with judge coverage via the formal composition: a
 * temp config.json with a judge section drives createConfiguredMaskingExtension
 * (judge layer internal to the pipeline), and the masked compaction extension
 * consumes the same pipeline's unified egress entry — the wiring of
 * extension/index.ts minus commands/ingress, so status objects stay observable.
 */
function createJudgedCompactionSessionFactories(options: {
	gate: (text: string) => number;
	candidate: (value: string) => number;
	error?: boolean;
	onMissing?: "fail_closed" | "regex_only";
	resolveModel?: () => ReturnType<typeof fakeClassifierModel> | undefined;
}) {
	const fake = scriptClassify({
		gate: options.gate,
		candidate: options.candidate,
		error: options.error,
	});
	const judgeSection: Record<string, unknown> = {
		provider: "keep-secret-fake",
		modelId: "jev-fake",
		redactTemplate: "key-{hash}",
	};
	if (options.onMissing !== undefined) {
		judgeSection.onMissing = options.onMissing;
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t12-factory-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ judge: judgeSection }), "utf8");
	const { factory, pipeline } = createConfiguredMaskingExtension({
		configPath: join(dir, "config.json"),
		resolveModel:
			options.resolveModel === undefined
				? () => fakeClassifierModel()
				: (_ctx, _ref) => options.resolveModel!(),
		classify: (_model, context) => fake.classify(context),
	});
	const compactionStatus: MaskedCompactionStatus = {
		cancellations: 0,
		lastCancellationError: undefined,
	};
	const extensionFactories = [
		factory,
		createMaskedCompactionExtension({ pipeline, status: compactionStatus }),
	];
	return { pipeline, judgeStatus: pipeline.judgeInfo()!.status, compactionStatus, fake, extensionFactories };
}

/** Judge gate that hits only leaves containing the judge-only password. */
const gateOnPassword = (text: string) => (text.includes(PASSWORD) ? 0.98 : 0.02);
/** Judge candidate probabilities: password is a secret (0.96), anything else is not (0.04). */
const candidatePasswordOnly = (value: string) => (value === PASSWORD ? 0.96 : 0.04);

describe("ticket #12: compaction summary input covered by the judge layer", () => {
	test("judge-only password in history: summary model sees only the placeholder, stored summary holds the real value, same placeholder form as the main chain", async () => {
		const { pipeline, judgeStatus, compactionStatus, extensionFactories } =
			createJudgedCompactionSessionFactories({
				gate: gateOnPassword,
				candidate: candidatePasswordOnly,
			});
		const h = await createHarnessSession({
			extensionFactories,
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				// The summary "model" can only echo the placeholder it was shown.
				{ text: `## Critical Context\n- 部署密码 ${PASSWORD_PLACEHOLDER}` },
				{ text: "post-compact ack" },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3); // two turns + one summary request
			// Zero plaintext on every outbound request, including the summary call.
			for (const request of requests) {
				expect(requestText(request)).not.toContain(PASSWORD);
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
			// The summary request carries the judge placeholder for the password —
			// the same form the main chain issued (first-issuer-wins, one form per secret).
			const summaryRequest = requestText(requests[2]!);
			expect(summaryRequest).toContain(PASSWORD_PLACEHOLDER);
			expect(summaryRequest).toContain("[User]:"); // serialized conversation in the prompt
			expect(pipeline.registry.get(PASSWORD_PLACEHOLDER)).toBe(PASSWORD);

			// The stored summary is restored to real values; compaction was not cancelled.
			const compaction = compactionEntry(h);
			expect(compaction).toBeDefined();
			expect(compaction?.fromHook).toBe(true);
			expect(compaction?.summary).toContain(PASSWORD);
			expect(compaction?.summary).not.toContain(PASSWORD_PLACEHOLDER);
			expect(judgeStatus.judgedTexts).toBeGreaterThan(0); // judge actually ran on the input
			expect(compactionStatus.cancellations).toBe(0);
		} finally {
			h.dispose();
		}
	});

	test("iterative compaction: previousSummary (real values on disk) is judge-masked before entering the summary context", async () => {
		const { extensionFactories } = createJudgedCompactionSessionFactories({
			gate: gateOnPassword,
			candidate: candidatePasswordOnly,
		});
		const h = await createHarnessSession({
			extensionFactories,
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `## Critical Context\n- 部署密码 ${PASSWORD_PLACEHOLDER}` },
				{ text: "continue ack" },
				{ text: "more work ack" },
				{ text: `## Critical Context\n- 密码仍是 ${PASSWORD_PLACEHOLDER}` },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}`);
			await h.session.prompt(PAD);
			await h.session.compact();
			await h.session.prompt("continue with more work");
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(6);
			// Second summary request: the stored previousSummary (real values) and
			// the newly summarized messages both reach the model masked only.
			const secondSummary = requestText(requests[5]!);
			expect(secondSummary).not.toContain(PASSWORD);
			expect(secondSummary).toContain(PASSWORD_PLACEHOLDER);
			expect(secondSummary).toContain("<previous-summary>");

			const compactions = h.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "compaction");
			expect(compactions).toHaveLength(2);
			for (const entry of compactions) {
				expect(entry.summary).toContain(PASSWORD); // both generations stored as real values
			}
		} finally {
			h.dispose();
		}
	});

	test("judge classify failure: fail_closed masks unverified candidates and compaction still completes (no retry/cancel)", async () => {
		const { judgeStatus, compactionStatus, extensionFactories } =
			createJudgedCompactionSessionFactories({
				gate: () => 0.98,
				candidate: () => 0.96,
				error: true, // every classify call fails
			});
		const h = await createHarnessSession({
			extensionFactories,
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `## Critical Context\n- 密码 ${PASSWORD_PLACEHOLDER}，订单 ${ORDER_PLACEHOLDER}` },
				{ text: "post-compact ack" },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			// Compaction completed: exactly one summary request (no retries), no cancellation.
			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			// fail_closed: unverified candidates (password AND order number) are masked.
			const summaryRequest = requestText(requests[2]!);
			expect(summaryRequest).not.toContain(PASSWORD);
			expect(summaryRequest).not.toContain(ORDER);
			expect(summaryRequest).toContain(PASSWORD_PLACEHOLDER);
			expect(summaryRequest).toContain(ORDER_PLACEHOLDER);
			expect(judgeStatus.failClosed).toBeGreaterThan(0);
			expect(compactionStatus.cancellations).toBe(0);

			// The stored summary restores the real values (registry-backed).
			const compaction = compactionEntry(h);
			expect(compaction?.fromHook).toBe(true);
			expect(compaction?.summary).toContain(PASSWORD);
			expect(compaction?.summary).toContain(ORDER);
		} finally {
			h.dispose();
		}
	});

	test("classifier model missing + onMissing=fail_closed (default): candidates masked, compaction completes", async () => {
		const { judgeStatus, compactionStatus, extensionFactories } =
			createJudgedCompactionSessionFactories({
				gate: () => 0.98,
				candidate: () => 0.96,
				resolveModel: () => undefined, // classifier model never resolves
			});
		const h = await createHarnessSession({
			extensionFactories,
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `## Critical Context\n- 密码 ${PASSWORD_PLACEHOLDER}，订单 ${ORDER_PLACEHOLDER}` },
				{ text: "post-compact ack" },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}，订单 ${ORDER}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			const summaryRequest = requestText(requests[2]!);
			// Same policy as egress fail_closed: unverified candidates masked on the
			// summary input too; compaction itself is not disturbed.
			expect(summaryRequest).not.toContain(PASSWORD);
			expect(summaryRequest).not.toContain(ORDER);
			expect(judgeStatus.failClosed).toBeGreaterThan(0);
			expect(judgeStatus.judgedTexts).toBe(0); // no gate call ever issued
			expect(compactionStatus.cancellations).toBe(0);
			const compaction = compactionEntry(h);
			expect(compaction?.fromHook).toBe(true);
			expect(compaction?.summary).toContain(PASSWORD);
		} finally {
			h.dispose();
		}
	});

	test("classifier model missing + onMissing=regex_only: compaction completes on the regex layer only (visible degradation)", async () => {
		const { judgeStatus, compactionStatus, extensionFactories } =
			createJudgedCompactionSessionFactories({
				gate: () => 0.98,
				candidate: () => 0.96,
				onMissing: "regex_only", // explicit informed choice
				resolveModel: () => undefined,
			});
		const h = await createHarnessSession({
			extensionFactories,
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `## Critical Context\n- 部署密码 ${PASSWORD}` },
				{ text: "post-compact ack" },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			const summaryRequest = requestText(requests[2]!);
			// Degraded summary input: regex-only. The regex anchor is still masked;
			// the judge-only password remains visible — the documented residual gap
			// of onMissing=regex_only (same informed trade-off as the egress chain).
			expect(summaryRequest).toContain(PASSWORD);
			expect(summaryRequest).not.toContain(OPENAI_KEY);
			expect(summaryRequest).toContain(OPENAI_PLACEHOLDER);
			expect(judgeStatus.degradedTexts).toBeGreaterThan(0);
			expect(judgeStatus.failClosed).toBe(0);
			expect(compactionStatus.cancellations).toBe(0);
			expect(compactionEntry(h)?.fromHook).toBe(true);
		} finally {
			h.dispose();
		}
	});

	test("clean-cache coordination: leaves already judged clean by the egress chain are not re-judged for the summary", async () => {
		const { fake, extensionFactories } = createJudgedCompactionSessionFactories({
			gate: () => 0.02, // everything clean
			candidate: () => 0.02,
		});
		const h = await createHarnessSession({
			extensionFactories,
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: "## Critical Context\n- clean conversation" },
			]);
			await h.session.prompt("first clean note about architecture");
			await h.session.prompt(PAD); // padding holds the cut point; user1/assistant1 get summarized
			const callsBeforeCompact = fake.calls.length;
			expect(callsBeforeCompact).toBeGreaterThanOrEqual(4); // egress judged the leaves

			await h.session.compact();
			// The summary conversation reuses the same leaf strings the egress chain
			// already judged clean (regex layer wrote the clean entries) — the shared
			// clean cache short-circuits them; no new gate call is issued.
			expect(fake.calls.length).toBe(callsBeforeCompact);
			expect(compactionEntry(h)?.fromHook).toBe(true);
		} finally {
			h.dispose();
		}
	});

	test("branch summary (session_before_tree): abandoned-branch summary input is judge-masked, stored summary restored", async () => {
		const { extensionFactories } = createJudgedCompactionSessionFactories({
			gate: gateOnPassword,
			candidate: candidatePasswordOnly,
		});
		const h = await createHarnessSession({ extensionFactories });
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `分支里的密码 ${PASSWORD_PLACEHOLDER}` },
			]);
			await h.session.prompt("plain start");
			await h.session.prompt(`rotate to ${PASSWORD}`);

			// Navigate back to the first assistant message: the abandoned branch
			// [user2, assistant2] goes through the branch-summary hook.
			const assistantIds = messageEntryIds(h, "assistant");
			const result = await h.session.navigateTree(assistantIds[0]!, { summarize: true });

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			for (const request of requests) {
				expect(requestText(request)).not.toContain(PASSWORD);
			}
			expect(requestText(requests[2]!)).toContain(PASSWORD_PLACEHOLDER);
			expect(result.cancelled).toBe(false);
			expect(result.summaryEntry?.summary).toContain(PASSWORD);
			expect(result.summaryEntry?.summary).not.toContain(PASSWORD_PLACEHOLDER);
			expect(result.summaryEntry?.fromHook).toBe(true);
		} finally {
			h.dispose();
		}
	});
});

describe("ticket #12: formal composition wiring (extension/index.ts)", () => {
	/** Write a temp config.json and return its path (caller removes the dir). */
	function writeTempConfig(content: string): { path: string; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t12-"));
		const path = join(dir, "config.json");
		writeFileSync(path, content, "utf8");
		return { path, dir };
	}

	test("judge configured: summary input is double-masked through the formal entry", async () => {
		const fake = scriptClassify({ gate: gateOnPassword, candidate: candidatePasswordOnly });
		const { path: configPath, dir } = writeTempConfig(
			JSON.stringify({
				judge: { provider: "keep-secret-fake", modelId: "jev-fake", redactTemplate: "key-{hash}" },
			}),
		);
		const ext = createKeepSecretExtension({
			configPath,
			resolveModel: () => fakeClassifierModel(),
			classify: (_model, context) => fake.classify(context),
		});
		const h = await createHarnessSession({
			extensionFactories: [ext],
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `## Critical Context\n- 部署密码 ${PASSWORD_PLACEHOLDER}` },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			const summaryRequest = requestText(requests[2]!);
			// The composition passes the judge masker into the compaction extension:
			// the judge-only password must not reach the summarization model.
			expect(summaryRequest).not.toContain(PASSWORD);
			expect(summaryRequest).toContain(PASSWORD_PLACEHOLDER);
			const compaction = compactionEntry(h);
			expect(compaction?.fromHook).toBe(true);
			expect(compaction?.summary).toContain(PASSWORD);
		} finally {
			h.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("judge not configured: compaction behavior is unchanged (regex layer only)", async () => {
		const { path: configPath, dir } = writeTempConfig(JSON.stringify({}));
		const ext = createKeepSecretExtension({ configPath });
		const h = await createHarnessSession({
			extensionFactories: [ext],
			settings: { compaction: { keepRecentTokens: 50 } },
		});
		try {
			h.provider.setScript([
				{ text: "first ack" },
				{ text: "second ack" },
				{ text: `## Critical Context\n- 部署密码 ${PASSWORD}` },
			]);
			await h.session.prompt(`部署密码 ${PASSWORD}，密钥 ${OPENAI_KEY}`);
			await h.session.prompt(PAD);
			await h.session.compact();

			const requests = h.provider.requests();
			expect(requests).toHaveLength(3);
			const summaryRequest = requestText(requests[2]!);
			// No judge layer configured: the summary input keeps its regex-only
			// behavior — the regex anchor is masked, the judge-only password is not.
			expect(summaryRequest).not.toContain(OPENAI_KEY);
			expect(summaryRequest).toContain(OPENAI_PLACEHOLDER);
			expect(summaryRequest).toContain(PASSWORD);
			expect(compactionEntry(h)?.fromHook).toBe(true);
		} finally {
			h.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
