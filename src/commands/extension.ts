/**
 * 入站预检通知 + /keep-secret 命令面（ticket #9 / T7）。
 *
 * - `input` 预检：提交的 prompt 按内置默认 regex 集快扫（已知格式
 *   sk-/ghp_/AKIA/…/PEM/JWT；与配置无关的固定提示层——掩码执法始终
 *   以当前配置检测器集为准），命中即非阻塞 notify（不改写、不阻断；
 *   无 UI 模式 notify 为 no-op，静默）。
 * - `/keep-secret`：状态面板（检测器配置摘要/注册表/clean cache/各检测
 *   器命中/judge 预留位/压缩回退计数）。
 * - `/keep-secret test`：合成样本内联自测。
 * - `/keep-secret reload`：配置热重载（loader.reload → applyDetectors）。
 *
 * 三模式安全降级：输出一律经 ctx.ui.notify（TUI 直接可见、RPC 经
 * extension_ui_request 转发、print/json no-op 静默），无任何交互原语
 * （select/confirm/custom），无 UI 也不影响命令动作本身执行。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compileRegexDetector, detectRegexSpans, type CompiledRegexDetector } from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "../masking/detectors.ts";
import type { MaskingPipeline } from "../masking/index.ts";
import type { ConfigLoader } from "../config/index.ts";
import type { MaskedCompactionStatus } from "../compaction/index.ts";

/** T5 judge 计数预留位（judge 未合入时缺省 → 状态面显示「未接入」）。 */
export interface JudgeStats {
	/** 候选分批超上限被截断的次数。 */
	truncations: number;
	/** judge 失败触发 fail-closed 掩码的次数。 */
	fallbacks: number;
}

export interface KeepSecretCommandsOptions {
	/** 配置 loader（状态面的配置摘要来源；reload 动作消费）。 */
	loader: ConfigLoader;
	/** 会话级掩码管线（状态面的注册表/缓存/检测器命中计数来源）。 */
	pipeline: MaskingPipeline;
	/** 掩码压缩故障状态（状态面的回退计数来源）。 */
	compaction: MaskedCompactionStatus;
	/** T5 judge 计数（预留位；缺省显示「未接入」）。 */
	judge?: JudgeStats;
}

/** 预检快扫检测器集（内置默认集编译态；与配置无关的固定提示层）。 */
const precheckDetectors: CompiledRegexDetector[] = DEFAULT_DETECTOR_SPECS.map(compileRegexDetector);

/** 提交内容疑似凭据快扫：命中的检测器名集合（空 = 未命中）。 */
function precheckSuspects(text: string): string[] {
	const names = new Set(detectRegexSpans(precheckDetectors, text).map((span) => span.detector));
	return [...names];
}

/** 配置来源描述：默认集 / 配置文件 / 非法回退（状态面第一行用）。 */
function describeConfigSource(loader: ConfigLoader): string {
	const config = loader.get();
	if (!config.exists) {
		return `内置默认集（未找到配置文件 ${config.path}）`;
	}
	if (config.errors.length > 0) {
		return `配置文件 ${config.path}（非法，已回退内置默认集）`;
	}
	return `配置文件 ${config.path}`;
}

/** 命中率百分比文本（零样本显示「n/a」）。 */
function hitRate(hits: number, total: number): string {
	if (total === 0) {
		return "n/a";
	}
	return `${Math.round((hits / total) * 100)}%`;
}

/** /keep-secret 状态面板文本（数据源：loader/pipeline/compaction/judge）。 */
function buildStatusReport(options: KeepSecretCommandsOptions): string {
	const config = options.loader.get();
	const lines: string[] = [
		"pi-keep-secret 状态",
		`检测器：${config.detectors.length} 个，来源：${describeConfigSource(options.loader)}`,
		`  名称：${config.detectors.map((d) => d.name).join(", ")}`,
		`伪值注册表：${options.pipeline.registry.size} 条`,
	];
	for (const error of config.errors) {
		lines.push(`配置错误：${error}（已回退内置默认集）`);
	}
	const cache = options.pipeline.cacheStats();
	lines.push(
		`clean cache：${cache.size} 条，命中率 ${hitRate(cache.hits, cache.hits + cache.misses)}（命中 ${cache.hits} / 检测 ${cache.misses}）`,
	);
	const hits = options.pipeline.detectorHitCounts();
	lines.push(
		hits.size === 0
			? "检测器命中：（无）"
			: `检测器命中：${[...hits.entries()].map(([name, count]) => `${name}=${count}`).join(", ")}`,
	);
	lines.push(
		options.judge === undefined
			? "judge：未接入（T5 未合入）"
			: `judge：截断 ${options.judge.truncations} 次，fail-closed 回退 ${options.judge.fallbacks} 次`,
	);
	lines.push(
		`掩码压缩回退：${options.compaction.fallbacks} 次` +
			(options.compaction.fallbacks > 0 && options.compaction.lastFallbackError !== undefined
				? `（最近原因：${options.compaction.lastFallbackError}）`
				: ""),
	);
	return lines.join("\n");
}

/** 自测合成样本（固定常量；期望针对 regex 掩码层）。 */
interface SelfTestSample {
	label: string;
	text: string;
	expectMasked: boolean;
	/** 期望说明（如假密码的 regex 层/judge 职责边界）。 */
	note?: string;
}

const SELF_TEST_SAMPLES: SelfTestSample[] = [
	{
		label: "sk- 假 key",
		text: "临时密钥：sk-live-abcdefghijklmnopqrstuvwxyz012345 请尽快轮换",
		expectMasked: true,
	},
	{
		label: "URL 藏 key",
		text: "下载：https://cdn.example.com/v1/file?token=sk-live-qrstuvwxyzabcde0123456789&dl=1",
		expectMasked: true,
	},
	{
		label: "假密码",
		text: "密码不是 hunter2secret，是 Xk9$mQzT7vLw2Pn4",
		expectMasked: false,
		note: "regex 层不命中；低熵密码归 judge（T5 合入后改判）",
	},
	{
		label: "干净订单号",
		text: "订单号 ORD-20240612-000123 已发货",
		expectMasked: false,
	},
];

/** /keep-secret test：合成样本逐项过会话管线，报告掩码结果与期望是否一致。 */
function buildSelfTestReport(pipeline: MaskingPipeline): { text: string; allPassed: boolean } {
	const lines = ["pi-keep-secret 自测（合成样本，当前生效检测器集）"];
	let passed = 0;
	for (const sample of SELF_TEST_SAMPLES) {
		const masked = pipeline.maskText(sample.text) !== sample.text;
		const ok = masked === sample.expectMasked;
		if (ok) {
			passed += 1;
		}
		lines.push(
			`${sample.label}：${masked ? "已掩码" : "未掩码"}（期望：${sample.expectMasked ? "掩码" : "未掩码"}${
				sample.note === undefined ? "" : `——${sample.note}`
			}）${ok ? "✓ 通过" : "✗ 未通过"}`,
		);
	}
	const allPassed = passed === SELF_TEST_SAMPLES.length;
	lines.push(
		`${passed}/${SELF_TEST_SAMPLES.length} 通过${allPassed ? "" : "（有未通过项——请检查当前检测器配置）"}`,
	);
	return { text: lines.join("\n"), allPassed };
}

/** 创建 T7 可见性扩展：input 预检通知 + /keep-secret 命令面。 */
export function createKeepSecretCommandsExtension(options: KeepSecretCommandsOptions) {
	return (pi: ExtensionAPI): void => {
		pi.on("input", (event, ctx) => {
			const suspects = precheckSuspects(event.text);
			if (suspects.length > 0) {
				ctx.ui.notify(
					`pi-keep-secret：提交内容含疑似凭据（${suspects.join(", ")}），出站将自动掩码为占位符——请确认没有误粘贴真实密钥`,
					"warning",
				);
			}
			return undefined; // 纯通知：不改写、不阻断
		});

		pi.registerCommand("keep-secret", {
			description: "掩码扩展状态 / 自测 / 配置热重载（status | test | reload）",
			handler: async (args, ctx) => {
				switch (args.trim()) {
				case "": {
					ctx.ui.notify(buildStatusReport(options), "info");
					break;
				}
				case "test": {
					const report = buildSelfTestReport(options.pipeline);
					ctx.ui.notify(report.text, report.allPassed ? "info" : "warning");
					break;
				}
				case "reload": {
					const before = options.loader.get();
					const after = options.loader.reload(); // 变更时同步触发热应用（applyDetectors + 清空缓存）
					if (after.errors.length > 0) {
						ctx.ui.notify(
							`pi-keep-secret reload：配置错误（已回退内置默认集）——\n${after.errors.join("\n")}`,
							"error",
						);
					} else if (JSON.stringify(before.detectors) !== JSON.stringify(after.detectors)) {
						ctx.ui.notify(
							`pi-keep-secret reload：检测器集已热应用（${after.detectors.length} 个：${after.detectors.map((d) => d.name).join(", ")}；hashLength/cleanCache 变更仅新会话生效）`,
							"info",
						);
					} else {
						ctx.ui.notify(
							"pi-keep-secret reload：配置已重读，检测器集无变更（hashLength/cleanCache 变更仅新会话生效）",
							"info",
						);
					}
					break;
				}
				default: {
					ctx.ui.notify(
						`未知子命令 ${JSON.stringify(args.trim())}。用法：/keep-secret（状态）| /keep-secret test（自测）| /keep-secret reload（配置热重载）`,
						"warning",
					);
				}
				}
			},
		});
	};
}
