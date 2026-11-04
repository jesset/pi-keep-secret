/**
 * 入站预检通知 + /keep-secret 命令面（ticket #9 / T7）。
 *
 * - `input` 预检：提交的 prompt 按内置默认 regex 集快扫（已知格式
 *   sk-/ghp_/AKIA/…/PEM/JWT；与配置无关的固定提示层——掩码执法始终
 *   以当前配置检测器集为准），命中即非阻塞 notify（不改写、不阻断；
 *   无 UI 模式 notify 为 no-op，静默）。
 * - `/keep-secret`：状态面板（检测器配置摘要/注册表/clean cache/各检测
 *   器命中/judge 计数（T8 接入：配置 judge 段后展示已判定/截断/fail-
 *   closed/降级计数）/压缩取消计数）。
 * - `/keep-secret test`：合成样本内联自测（judge 启用时经 judge→regex
 *   全链评估，假密码项期望掩码；降级时如实报未通过）。
 * - `/keep-secret reload`：配置热重载（loader.reload → applyDetectors）。
 *
 * 三模式安全降级：输出一律经 ctx.ui.notify（TUI 直接可见、RPC 经
 * extension_ui_request 转发、print/json no-op 静默），无任何交互原语
 * （select/confirm/custom），无 UI 也不影响命令动作本身执行。
 *
 * 文案与排版：用户可见字符串一律英文（源码注释与 docs 保持中文），版面
 * 由 `../ui/index.ts` 统一合成——标题 + 分隔线 + 分组键值表，长值在 72
 * 列预算内预折行（悬挂缩进）。pi 对 warning/error 只给首行加前缀，因此
 * 首行固定为单行标题，正文缩进 2 列。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { compileRegexDetector, detectRegexSpans, type CompiledRegexDetector } from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "../masking/detectors.ts";
import type { AnyMaskingPipeline } from "../masking/index.ts";
import type { ConfigLoader } from "../config/index.ts";
import { configFingerprint } from "../config/index.ts";
import type { MaskedCompactionStatus } from "../compaction/index.ts";
import type { JudgeWire } from "../judge/index.ts";
import {
	formatBlockReport,
	formatBullets,
	formatReport,
	formatTable,
	type ReportField,
	type ReportSection,
	type ReportTableRow,
} from "../ui/index.ts";

export interface KeepSecretCommandsOptions {
	/** 配置 loader（状态面的配置摘要来源；reload 动作消费）。 */
	loader: ConfigLoader;
	/** 会话级掩码管线（状态面与自测的统一数据源：注册表/缓存/检测器命中/
	 *  judge 快照均经管线读取——ADR-0001；自测样本经管线统一出站入口掩码）。 */
	pipeline: AnyMaskingPipeline;
	/** 掩码压缩故障状态（状态面的取消计数来源）。 */
	compaction: MaskedCompactionStatus;
}

/** 预检快扫检测器集（内置默认集编译态；与配置无关的固定提示层）。 */
const precheckDetectors: CompiledRegexDetector[] = DEFAULT_DETECTOR_SPECS.map(compileRegexDetector);

/** 提交内容疑似凭据快扫：命中的检测器名集合（空 = 未命中）。 */
function precheckSuspects(text: string): string[] {
	const names = new Set(detectRegexSpans(precheckDetectors, text).map((span) => span.detector));
	return [...names];
}

/** 配置来源描述：默认集 / 配置文件 / 非法回退（状态面板 Config 分区用）。 */
function describeConfigSource(loader: ConfigLoader): string {
	const config = loader.get();
	if (!config.exists) {
		return `built-in defaults (no config file at ${config.path})`;
	}
	if (config.errors.length > 0) {
		return `${config.path} (invalid — fell back to built-in defaults)`;
	}
	return config.path;
}

/** 命中率百分比文本（零样本显示 n/a）。 */
function hitRate(hits: number, total: number): string {
	if (total === 0) {
		return "n/a";
	}
	return `${Math.round((hits / total) * 100)}%`;
}

/** 数量 + 名词（单复数；不规整复数用 irregular 传出）。 */
function plural(count: number, singular: string, irregular?: string): string {
	return `${count} ${count === 1 ? singular : (irregular ?? `${singular}s`)}`;
}

/** 生效线缆描述（T16：状态面板 judge 分区；解析前不展示）。 */
function describeJudgeWire(wire: JudgeWire): string {
	switch (wire.source) {
		case "registered":
			return `follows registration (${wire.api})`;
		case "override":
			return `override ${wire.preference} (${wire.api})`;
		case "plugin":
			return `plugin custom ${wire.api} (judge.api preference ${wire.ineffectivePreference} ignored)`;
	}
}

/** 生效检测器名摘要（并列成一行，超宽由排版器折行）。 */
function describeDetectors(options: KeepSecretCommandsOptions): string {
	const detectors = options.loader.get().detectors;
	return detectors.map((detector) => detector.name).join(", ");
}

/** /keep-secret 状态面板文本（数据源：loader/pipeline/compaction/judge）。 */
function buildStatusReport(options: KeepSecretCommandsOptions): string {
	const config = options.loader.get();
	const sections: ReportSection[] = [
		{
			heading: "Config",
			fields: [
				{ label: "detectors", value: `${config.detectors.length} · mode ${config.detectorsMode}` },
				{ label: "source", value: describeConfigSource(options.loader) },
				{ label: "names", value: describeDetectors(options) },
			],
		},
	];
	if (config.errors.length > 0) {
		sections.push({ heading: "Config errors", bulletMarker: "✗", bullets: config.errors });
	}

	const cache = options.pipeline.cacheStats();
	const hits = options.pipeline.detectorHitCounts();
	sections.push({
		heading: "Session",
		fields: [
			{ label: "placeholders", value: `${plural(options.pipeline.registry.size, "placeholder")} issued` },
			{
				label: "clean cache",
				value:
					`${plural(cache.size, "entry", "entries")} · ` +
					`hit rate ${hitRate(cache.hits, cache.hits + cache.misses)} ` +
					`(${plural(cache.hits, "hit")} / ${plural(cache.misses, "scan")})`,
			},
			{
				label: "hits",
				value:
					hits.size === 0
						? "(none)"
						: [...hits.entries()].map(([name, count]) => `${name}=${count}`).join(", "),
			},
		],
	});

	const judge = options.pipeline.judgeInfo();
	const judgeFields: ReportField[] = [];
	if (judge === undefined) {
		judgeFields.push({ label: "layer", value: "regex only (no judge config)" });
	} else {
		judgeFields.push({ label: "judged", value: plural(judge.status.judgedTexts, "text") });
		judgeFields.push({ label: "truncated", value: plural(judge.status.truncatedCandidates, "candidate") });
		judgeFields.push({ label: "fail-closed", value: plural(judge.status.failClosed, "text") });
		judgeFields.push({ label: "degraded", value: plural(judge.status.degradedTexts, "text") });
		// 生效策略口径（ADR-0001 Q6）：读会话实际生效的 judge 层，而非磁盘新配置
		judgeFields.push({ label: "on missing", value: judge.onMissing });
		if (judge.wire !== undefined) {
			judgeFields.push({ label: "wire", value: describeJudgeWire(judge.wire) });
		}
	}
	sections.push({ heading: "Judge", fields: judgeFields });

	const compactionFields: ReportField[] = [
		{ label: "cancelled", value: `${options.compaction.cancellations}` },
	];
	if (options.compaction.cancellations > 0 && options.compaction.lastCancellationError !== undefined) {
		compactionFields.push({ label: "last error", value: options.compaction.lastCancellationError });
	}
	sections.push({ heading: "Compaction", fields: compactionFields });

	return formatReport({ title: "pi-keep-secret · status", sections });
}

/** 自测合成样本（固定常量；假密码项的期望随 judge 是否启用动态化）。 */
interface SelfTestSample {
	label: string;
	text: string;
	/** judge 未启用时的期望（regex 层口径）。 */
	expectMasked: boolean;
	/** judge 启用时的期望（覆盖 expectMasked：低熵密码归 judge 层）。 */
	expectMaskedWithJudge?: boolean;
	/** 期望说明（表格行内注记；judge 未启用口径）。 */
	note?: string;
	/** judge 启用时的行内注记（覆盖 note）。 */
	noteWithJudge?: string;
}

const SELF_TEST_SAMPLES: SelfTestSample[] = [
	{
		label: "sk- fake key",
		text: "临时密钥：sk-live-abcdefghijklmnopqrstuvwxyz012345 请尽快轮换",
		expectMasked: true,
	},
	{
		label: "key in URL",
		text: "下载：https://cdn.example.com/v1/file?token=sk-live-qrstuvwxyzabcde0123456789&dl=1",
		expectMasked: true,
	},
	{
		label: "fake password",
		text: "密码不是 hunter2secret，是 Xk9$mQzT7vLw2Pn4",
		expectMasked: false,
		expectMaskedWithJudge: true,
		note: "low-entropy password: invisible to the regex layer — covered by the judge layer once a judge section is configured",
		noteWithJudge: "low-entropy password: invisible to the regex layer, covered by the judge layer",
	},
	{
		label: "clean order number",
		text: "订单号 ORD-20240612-000123 已发货",
		expectMasked: false,
	},
];

/** /keep-secret test：合成样本逐项过管线统一出站入口（ADR-0001：judge→regex 完整掩码），报告掩码结果与期望是否一致。 */
async function buildSelfTestReport(
	options: KeepSecretCommandsOptions,
	ctx: ExtensionCommandContext,
): Promise<{ text: string; allPassed: boolean }> {
	const judge = options.pipeline.judgeInfo();
	const judgeEnabled = judge !== undefined;
	// 模型缺失 + fail_closed（默认）：未验证候选一律掩码——全部样本期望掩码
	//（含干净订单号：候选被兜底掩码属预期，而非配置问题）
	const failClosedNoModel =
		judge !== undefined && judge.onMissing === "fail_closed" && judge.modelMissing;
	const rows: ReportTableRow[] = [];
	let passed = 0;
	for (const sample of SELF_TEST_SAMPLES) {
		// 管线统一出站入口：完整掩码（judge 先判原文、regex 后兜底，伪值幂等
		// 跳过，Clean Verdict 协议在内）；judge 降级（regex_only）时仅 regex 层
		// 结果——假密码项如实报未通过
		const pipeline = options.pipeline;
		const current =
			"mask" in pipeline ? await pipeline.mask(sample.text, ctx) : pipeline.maskText(sample.text);
		const masked = current !== sample.text;
		const expectMasked = failClosedNoModel
			? true
			: judgeEnabled
				? (sample.expectMaskedWithJudge ?? sample.expectMasked)
				: sample.expectMasked;
		const ok = masked === expectMasked;
		if (ok) {
			passed += 1;
		}
		rows.push({
			cells: [
				ok ? "✓" : "✗",
				sample.label,
				masked ? "masked" : "unmasked",
				`expected ${expectMasked ? "masked" : "unmasked"}`,
			],
			note: judgeEnabled ? (sample.noteWithJudge ?? sample.note) : sample.note,
		});
	}
	const allPassed = passed === SELF_TEST_SAMPLES.length;
	const notes: string[] = [];
	if (judge !== undefined && judge.status.degradedTexts > 0 && !allPassed) {
		notes.push(
			"judge degraded (classifier model unavailable, regex layer only) — " +
				"the failing fake-password sample is the degradation signal",
		);
	}
	if (failClosedNoModel) {
		notes.push(
			"classifier model missing: fail_closed is active (all unverified candidates masked), so every " +
				"sample masking is the expected fallback — register the classifier model, or set " +
				'judge.onMissing="regex_only" explicitly',
		);
	}
	const summary = allPassed
		? `✓ ${passed}/${SELF_TEST_SAMPLES.length} passed`
		: `✗ ${passed}/${SELF_TEST_SAMPLES.length} passed — check the active detector configuration`;
	return {
		text: formatBlockReport({
			title: `pi-keep-secret · self-test — ${SELF_TEST_SAMPLES.length} samples, current detector set`,
			body: [
				...formatTable({ rows }),
				...(notes.length === 0 ? [] : ["", ...formatBullets({ bullets: notes })]),
			],
			footer: [summary],
		}),
		allPassed,
	};
}

/** reload 结果面板（三种结局统一骨架：config / detectors + 可选取舍提示）。 */
function buildReloadReport(spec: {
	configValue: string;
	detectorsValue?: string;
	note?: string;
}): string {
	const sections: ReportSection[] = [
		{
			fields: [
				{ label: "config", value: spec.configValue },
				...(spec.detectorsValue === undefined
					? []
					: [{ label: "detectors", value: spec.detectorsValue }]),
			],
		},
	];
	if (spec.note !== undefined) {
		sections.push({ bullets: [spec.note] });
	}
	return formatReport({ title: "pi-keep-secret · reload", sections });
}

/** 创建 T7 可见性扩展：input 预检通知 + /keep-secret 命令面。 */
export function createKeepSecretCommandsExtension(options: KeepSecretCommandsOptions) {
	return (pi: ExtensionAPI): void => {
		pi.on("input", (event, ctx) => {
			const suspects = precheckSuspects(event.text);
			if (suspects.length > 0) {
				ctx.ui.notify(
					`pi-keep-secret: this prompt looks like it contains a credential (${suspects.join(", ")}) — ` +
						"outbound requests will carry a placeholder instead; double-check you did not paste a real secret",
					"warning",
				);
			}
			return undefined; // 纯通知：不改写、不阻断
		});

		pi.registerCommand("keep-secret", {
			description: "Masking status, self-test, and config hot reload (status | test | reload)",
			handler: async (args, ctx) => {
				switch (args.trim()) {
				case "": {
					ctx.ui.notify(buildStatusReport(options), "info");
					break;
				}
				case "test": {
					const report = await buildSelfTestReport(options, ctx);
					ctx.ui.notify(report.text, report.allPassed ? "info" : "warning");
					break;
				}
				case "reload": {
					const before = options.loader.get();
					const beforeFingerprint = configFingerprint(before);
					const after = options.loader.reload(); // 变更时同步触发热应用（applyDetectors + 清空缓存）
					const activeDetectors = after.detectors.map((detector) => detector.name).join(", ");
					if (after.errors.length > 0) {
						ctx.ui.notify(
							formatReport({
								title: "pi-keep-secret · reload failed",
								sections: [
									{
										fields: [
											{
												label: "config",
												value: `invalid — fell back to built-in defaults (${after.path})`,
											},
										],
									},
									{ heading: "Errors", bulletMarker: "✗", bullets: after.errors },
								],
							}),
							"error",
						);
					} else if (configFingerprint(after) !== beforeFingerprint) {
						// 变更判定与 loader.reload/订阅同口径（configFingerprint）；检测器
						// 集是否变化仅决定提示语（热应用 vs 仅新会话生效）
						if (JSON.stringify(before.detectors) !== JSON.stringify(after.detectors)) {
							ctx.ui.notify(
								buildReloadReport({
									configValue: "re-read",
									detectorsValue: `hot-applied — ${after.detectors.length} active: ${activeDetectors}`,
									note: "hashLength / cleanCache / judge changes take effect in new sessions",
								}),
								"info",
							);
						} else {
							ctx.ui.notify(
								buildReloadReport({
									configValue: "re-read",
									detectorsValue: `unchanged — ${after.detectors.length} active: ${activeDetectors}`,
									note: "non-detector changes (judge / hashLength / cleanCache) take effect in new sessions",
								}),
								"info",
							);
						}
					} else {
						ctx.ui.notify(
							buildReloadReport({
								configValue: "unchanged",
								detectorsValue: `${after.detectors.length} active: ${activeDetectors}`,
							}),
							"info",
						);
					}
					break;
				}
				default: {
					ctx.ui.notify(
						formatReport({
							title: `pi-keep-secret · unknown subcommand ${JSON.stringify(args.trim())}`,
							sections: [
								{
									fields: [
										{
											label: "/keep-secret",
											value: "status: detector config, session counters, judge and compaction state",
										},
										{
											label: "/keep-secret test",
											value: "run synthetic samples through the live masking chain",
										},
										{
											label: "/keep-secret reload",
											value: "re-read the config file; detector changes hot-apply",
										},
									],
								},
							],
						}),
						"warning",
					);
				}
				}
			},
		});
	};
}
