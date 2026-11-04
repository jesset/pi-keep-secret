/**
 * 检测器 JSON 配置加载/校验与热重载 loader（ticket #6 / T4）。
 *
 * 配置文件（JSON 对象，未知键一律报错防 typo 静默失效）：
 * ```json
 * {
 *   "detectors": [
 *     { "name": "corp-api-key", "pattern": "corp-[A-Za-z0-9]{20,}",
 *       "redactTemplate": "corp-{hash}" }
 *   ],
 *   "hashLength": 20,
 *   "cleanCache": { "limit": 20000, "ttlMs": 86400000 },
 *   "judge": { "provider": "litellm", "modelId": "typesafe/jev-latest",
 *             "onMissing": "fail_closed", "api": "systemone" }
 * }
 * ```
 * - `detectors` 装配语义由 `detectorsMode`（T13，默认 replace）决定：
 *   replace——整体替换内置默认集（对齐参考实现 secret_detectors 语义，
 *   用户故事 30「tune detectors」）；merge——内置集 + 用户项合并，同名
 *   用户项原位覆盖内置（可微调 pattern/redactTemplate），非同名项追加
 *   在内置之后。`redactTemplate` 映射为引擎 RegexDetectorSpec.template，
 *   产物可直接喂 createEgressMaskingExtension。
 * - `judge`（T8 正式接线）：System One 判定检测器配置——provider/modelId
 *   必填 + 阈值/批参/并发/伪值模板/onMissing 策略可调（T14 起另有 api
 *   线缆偏好：systemone|decisions，缺省跟随模型注册条目的 api 字段；
 *   填写后按三分支应用（T16：已知 classifier api 覆盖分发线缆 / 插件
 *   自定义 api 尊重插件实现 + 偏好未生效提示），见 JudgeApi）；未配置
 *   即不接入 judge（仅 regex 检测层）。模型缺失时按 onMissing 处理（默认
 *   fail_closed——未验证候选一律掩码；regex_only——降级仅 regex 层，
 *   见 src/judge/masker.ts 与 JudgeOnMissing）。
 *   judge 段变更与 hashLength/cleanCache 同语义：仅新会话生效（会话内
 *   的 judge 装配在工厂创建时定格）。
 * - 路径解析优先级：显式参数 > 环境变量 PI_KEEP_SECRET_CONFIG > 默认
 *   ~/.pi/agent/extensions/pi-keep-secret/config.json。
 * - 文件不存在 → 内置默认集、无错误（默认安装无配置文件）。
 * - 任何非法（读失败/JSON 解析/schema/regex 编译）→ errors 可见 +
 *   **整体回退**内置默认集（全有或全无，不做部分采纳）。
 * - 热重载：reload() 重读磁盘并返回按段变更分类（ReloadOutcome，变更
 *   判定与通知的唯一口径），有实质变更才通知订阅者（T7 的 /keep-secret
 *   reload 消费；仅 detectors 段变更应热应用，hashLength/cleanCache/
 *   judge 段变更仅在断会话生效）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compileRegexDetector, type RegexDetectorSpec } from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "../masking/detectors.ts";

/** 配置路径覆盖环境变量（测试/部署指向任意路径）。 */
export const CONFIG_PATH_ENV = "PI_KEEP_SECRET_CONFIG";

/** 默认配置文件路径（用户级扩展安装位）。 */
export function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", "extensions", "pi-keep-secret", "config.json");
}

/**
 * 检测器策略开关（ticket #13 / T13）：replace（默认）——用户 detectors
 * 整体替换内置默认集（现行为）；merge——内置默认集 + 用户 detectors
 * 合并，同名用户项覆盖对应内置项（允许微调 pattern/redactTemplate），
 * 非同名项追加在内置之后（内置序保持在前）。
 */
export type DetectorsMode = "replace" | "merge";

/** clean cache 调参（缺省项由 createCleanCache 的默认值兜底）。 */
export interface CleanCacheConfig {
	/** 容量上限（默认 20000）。 */
	limit?: number;
	/** TTL 毫秒（默认 24 小时）。 */
	ttlMs?: number;
}

/**
 * judge 模型缺失策略（spec 故事 19：down judge never means an unmasked
 * request）：fail_closed（默认）——该消息未验证候选一律掩码；regex_only
 * （显式知情选择）——降级仅 regex 检测层（文本原样放行 + 可见计数）。
 */
export type JudgeOnMissing = "fail_closed" | "regex_only";

/**
 * judge 判定线缆偏好（T14 引入，T16 改语义）：systemone——pi-ai
 * `typesafe-system-one`（POST <baseUrl>/systemone，bool→noul）；
 * decisions——pi-ai `openai-decisions`（POST <baseUrl>/decisions，
 * bool→predicate、criteria 折进 instructions、state 为 JSON 文本）。
 * 两种协议同一 LiteLLM 网关后端路由，baseUrl 都配 `https://<host>/v1`。
 * loader 仅校验合法值（防 typo）；偏好的三分支应用在装配处（见
 * src/judge/masker.ts 的 JudgeTextMaskerOptions.api）。
 */
export type JudgeApi = "systemone" | "decisions";

/**
 * judge（T5 System One 判定检测器）配置段（T8 正式接线）：未配置即
 * 不接入 judge（仅 regex 检测层）；配置后 provider/modelId 必填。
 * 模型缺失时按 onMissing 策略处理（默认 fail_closed，见 JudgeOnMissing）。
 */
export interface JudgeConfig {
	/** classifier 供应商名（models.json/registerProvider 注册名）。 */
	provider: string;
	/** classifier 模型 id。 */
	modelId: string;
	/** gate 阈值（0..1，默认 0.5）。 */
	gateThreshold?: number;
	/** 候选阈值（0..1，默认 0.7）。 */
	candidateThreshold?: number;
	/** 每次批量判定的问题数上限（正整数，默认 128）。 */
	batchSize?: number;
	/** 批数上限（正整数，默认 8）。 */
	maxBatches?: number;
	/** 超长消息分块上限（正整数，默认 24000）。 */
	maxChars?: number;
	/** 候选最小长度（正整数，默认 6）。 */
	minCandidateLength?: number;
	/** classify 调用并发上限（正整数，默认 8）。 */
	concurrency?: number;
	/** judge 命中伪值模板（默认 "key-{hash}"）。 */
	redactTemplate?: string;
	/** classifier 模型缺失策略，默认 fail_closed（见 JudgeOnMissing）。 */
	onMissing?: JudgeOnMissing;
	/** 判定线缆偏好（见 JudgeApi）。缺省 undefined 跟随模型注册条目
	 *  的 api 字段；填写后按三分支应用（T16）：模型注册为 pi-ai 已知
	 *  classifier api → 覆盖分发线缆（typesafe-system-one↔systemone、
	 *  openai-decisions↔decisions，见 src/judge/masker.ts 的
	 *  MODEL_API_BY_JUDGE_API）；插件自定义 api → 尊重插件实现、偏好
	 *  未生效（info 通知 + 状态面标记）。分工：loader 只校验合法值
	 *  （非法仍 judge 段整体回退），偏好在装配处应用。 */
	api?: JudgeApi;
}

/** 一次加载的解析结果（错误非空时 detectors 为内置默认集回退）。 */
export interface ResolvedConfig {
	/** 解析来源路径。 */
	path: string;
	/** 配置文件是否存在。 */
	exists: boolean;
	/** 生效检测器 specs（可直接喂 createEgressMaskingExtension；装配语义见 detectorsMode）。 */
	detectors: RegexDetectorSpec[];
	/** 检测器策略开关（replace 整体替换 / merge 同名覆盖合并；缺省与回退均为 replace）。 */
	detectorsMode: DetectorsMode;
	/** 伪值哈希段长度；未配置为 undefined（引擎默认 12）。 */
	hashLength?: number;
	/** clean cache 调参；未配置为 undefined（默认 20000/24h）。 */
	cleanCache?: CleanCacheConfig;
	/** judge 配置段；未配置为 undefined（仅 regex 检测层）。 */
	judge?: JudgeConfig;
	/** 加载/校验错误（空 = 配置有效或文件不存在）。 */
	errors: string[];
}

/** 内置默认集副本（避免调用方改动污染共享常量）。 */
function defaultDetectors(): RegexDetectorSpec[] {
	return DEFAULT_DETECTOR_SPECS.map((spec) => ({ ...spec }));
}

const ROOT_KEYS = new Set(["detectors", "detectorsMode", "hashLength", "cleanCache", "judge"]);
const DETECTOR_KEYS = new Set(["name", "pattern", "redactTemplate"]);
const CLEAN_CACHE_KEYS = new Set(["limit", "ttlMs"]);
const JUDGE_KEYS = new Set([
	"provider",
	"modelId",
	"gateThreshold",
	"candidateThreshold",
	"batchSize",
	"maxBatches",
	"maxChars",
	"minCandidateLength",
	"concurrency",
	"redactTemplate",
	"onMissing",
	"api",
]);
/** base32(sha256) 无 padding 共 52 字符，哈希段长度上限由此决定。 */
const MAX_HASH_LENGTH = 52;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 正整数校验（含整数性）。 */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** 概率阈值校验（0..1 含端点的数值）。 */
function isProbability(value: unknown): value is number {
	return typeof value === "number" && value >= 0 && value <= 1;
}

/**
 * 校验已解析的 JSON 值。返回合法字段，或错误列表（任一错误即整体回退）。
 */
function validateConfig(json: unknown): {
	detectors?: RegexDetectorSpec[];
	detectorsMode?: DetectorsMode;
	hashLength?: number;
	cleanCache?: CleanCacheConfig;
	judge?: JudgeConfig;
	errors: string[];
} {
	const errors: string[] = [];
	if (!isPlainObject(json)) {
		return { errors: ["config root must be a JSON object"] };
	}

	for (const key of Object.keys(json)) {
		if (!ROOT_KEYS.has(key)) {
			errors.push(`unknown top-level key "${key}"`);
		}
	}

	let detectors: RegexDetectorSpec[] | undefined;
	if (json.detectors !== undefined) {
		if (!Array.isArray(json.detectors)) {
			errors.push("detectors must be an array");
		} else if (json.detectors.length === 0) {
			errors.push("detectors must contain at least one detector (empty list disables all local regex detection)");
		} else {
			const specs: RegexDetectorSpec[] = [];
			const names = new Set<string>();
			json.detectors.forEach((entry, index) => {
				if (!isPlainObject(entry)) {
					errors.push(`detectors[${index}] must be an object`);
					return;
				}
				for (const key of Object.keys(entry)) {
					if (!DETECTOR_KEYS.has(key)) {
						errors.push(`detectors[${index}]: unknown key "${key}"`);
					}
				}
				const name = typeof entry.name === "string" ? entry.name : undefined;
				const pattern = typeof entry.pattern === "string" ? entry.pattern : undefined;
				const template =
					typeof entry.redactTemplate === "string" ? entry.redactTemplate : undefined;
				const nameInvalid = name === undefined || name.length === 0;
				const patternInvalid = pattern === undefined || pattern.length === 0;
				const templateInvalid = template !== undefined && template.length === 0;
				if (nameInvalid) {
					errors.push(`detectors[${index}]: name must be a non-empty string`);
				}
				if (patternInvalid) {
					errors.push(`detectors[${index}]: pattern must be a non-empty string`);
				}
				if (templateInvalid) {
					errors.push(`detectors[${index}]: redactTemplate must be a non-empty string`);
				}
				if (nameInvalid || patternInvalid || templateInvalid) {
					return; // 该条目已有错，不再编译
				}
				if (names.has(name)) {
					errors.push(`duplicate detector name "${name}"`);
					return;
				}
				try {
					compileRegexDetector({ name, pattern, template });
				} catch (e) {
					errors.push(
						`detectors[${index}] ${JSON.stringify(name)}: ${e instanceof Error ? e.message : String(e)}`,
					);
					return;
				}
				names.add(name);
				specs.push({ name, pattern, template });
			});
			if (errors.length === 0) {
				detectors = specs;
			}
		}
	}

	let detectorsMode: DetectorsMode | undefined;
	if (json.detectorsMode !== undefined) {
		if (json.detectorsMode !== "replace" && json.detectorsMode !== "merge") {
			errors.push('detectorsMode must be "replace" or "merge"');
		} else {
			detectorsMode = json.detectorsMode;
		}
	}

	let hashLength: number | undefined;
	if (json.hashLength !== undefined) {
		const value = json.hashLength;
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < 1 ||
			value > MAX_HASH_LENGTH
		) {
			errors.push(`hashLength must be an integer between 1 and ${MAX_HASH_LENGTH} (base32(sha256) length)`);
		} else {
			hashLength = value;
		}
	}

	let cleanCache: CleanCacheConfig | undefined;
	if (json.cleanCache !== undefined) {
		if (!isPlainObject(json.cleanCache)) {
			errors.push("cleanCache must be an object");
		} else {
			const { limit, ttlMs } = json.cleanCache;
			let valid = true;
			for (const key of Object.keys(json.cleanCache)) {
				if (!CLEAN_CACHE_KEYS.has(key)) {
					errors.push(`cleanCache: unknown key "${key}"`);
					valid = false;
				}
			}
			if (limit !== undefined && !isPositiveInteger(limit)) {
				errors.push("cleanCache.limit must be a positive integer");
				valid = false;
			}
			if (ttlMs !== undefined && !isPositiveInteger(ttlMs)) {
				errors.push("cleanCache.ttlMs must be a positive integer");
				valid = false;
			}
			if (valid) {
				cleanCache = {
					limit: limit as number | undefined,
					ttlMs: ttlMs as number | undefined,
				};
			}
		}
	}

	let judge: JudgeConfig | undefined;
	if (json.judge !== undefined) {
		if (!isPlainObject(json.judge)) {
			errors.push("judge must be an object");
		} else {
			const section = json.judge;
			let valid = true;
			for (const key of Object.keys(section)) {
				if (!JUDGE_KEYS.has(key)) {
					errors.push(`judge: unknown key "${key}"`);
					valid = false;
				}
			}
			for (const key of ["provider", "modelId"] as const) {
				if (typeof section[key] !== "string" || (section[key] as string).length === 0) {
					errors.push(`judge.${key} must be a non-empty string`);
					valid = false;
				}
			}
			if (section.gateThreshold !== undefined && !isProbability(section.gateThreshold)) {
				errors.push("judge.gateThreshold must be a number between 0 and 1");
				valid = false;
			}
			if (section.candidateThreshold !== undefined && !isProbability(section.candidateThreshold)) {
				errors.push("judge.candidateThreshold must be a number between 0 and 1");
				valid = false;
			}
			const intKeys = [
				"batchSize",
				"maxBatches",
				"maxChars",
				"minCandidateLength",
				"concurrency",
			] as const;
			for (const key of intKeys) {
				if (section[key] !== undefined && !isPositiveInteger(section[key])) {
					errors.push(`judge.${key} must be a positive integer`);
					valid = false;
				}
			}
			if (section.redactTemplate !== undefined && (typeof section.redactTemplate !== "string" || section.redactTemplate.length === 0)) {
				errors.push("judge.redactTemplate must be a non-empty string");
				valid = false;
			}
			if (
				section.onMissing !== undefined &&
				section.onMissing !== "fail_closed" &&
				section.onMissing !== "regex_only"
			) {
				errors.push('judge.onMissing must be "fail_closed" or "regex_only"');
				valid = false;
			}
			if (
				section.api !== undefined &&
				section.api !== "systemone" &&
				section.api !== "decisions"
			) {
				errors.push('judge.api must be "systemone" or "decisions"');
				valid = false;
			}
			if (valid) {
				judge = {
					provider: section.provider as string,
					modelId: section.modelId as string,
					gateThreshold: section.gateThreshold as number | undefined,
					candidateThreshold: section.candidateThreshold as number | undefined,
					batchSize: section.batchSize as number | undefined,
					maxBatches: section.maxBatches as number | undefined,
					maxChars: section.maxChars as number | undefined,
					minCandidateLength: section.minCandidateLength as number | undefined,
					concurrency: section.concurrency as number | undefined,
					redactTemplate: section.redactTemplate as string | undefined,
					onMissing: section.onMissing as JudgeOnMissing | undefined,
					api: section.api as JudgeApi | undefined,
				};
			}
		}
	}

	return errors.length > 0
		? { errors }
		: { detectors, detectorsMode, hashLength, cleanCache, judge, errors };
}

/**
 * 生效检测器集装配（T13）：detectors 未配置时两种模式均等价纯内置集；
 * replace——用户集整体替换；merge——内置序在前（同名用户项原位覆盖，
 * 仅 pattern/redactTemplate 微调生效），非同名用户项追加在后。
 */
function effectiveDetectors(mode: DetectorsMode, detectors?: RegexDetectorSpec[]): RegexDetectorSpec[] {
	if (detectors === undefined) {
		return defaultDetectors();
	}
	if (mode === "replace") {
		return detectors;
	}
	const overrides = new Map(detectors.map((spec) => [spec.name, spec]));
	const builtinNames = new Set(DEFAULT_DETECTOR_SPECS.map((spec) => spec.name));
	return [
		...DEFAULT_DETECTOR_SPECS.map((spec) => overrides.get(spec.name) ?? { ...spec }),
		...detectors.filter((spec) => !builtinNames.has(spec.name)),
	];
}

/** 从磁盘读取并解析一次配置（错误都落 errors，绝不抛出）。 */
function loadFromDisk(path: string): ResolvedConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const notFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
		if (notFound) {
			return { path, exists: false, detectors: defaultDetectors(), detectorsMode: "replace", errors: [] };
		}
		return {
			path,
			exists: false,
			detectors: defaultDetectors(),
			detectorsMode: "replace",
			errors: [`failed to read config file: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return {
			path,
			exists: true,
			detectors: defaultDetectors(),
			detectorsMode: "replace",
			errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const validated = validateConfig(json);
	if (validated.errors.length > 0) {
		return { path, exists: true, detectors: defaultDetectors(), detectorsMode: "replace", errors: validated.errors };
	}
	const detectorsMode = validated.detectorsMode ?? "replace";
	return {
		path,
		exists: true,
		detectors: effectiveDetectors(detectorsMode, validated.detectors),
		detectorsMode,
		hashLength: validated.hashLength,
		cleanCache: validated.cleanCache,
		judge: validated.judge,
		errors: [],
	};
}

/** reload 变更分类（按配置段逐字段；订阅通知与 /keep-secret reload 文案的
 *  唯一口径——命令面不再自行比对 fingerprint）。热应用语义：仅
 *  `changes.detectors` 为 true 时订阅者才应重编译检测器集；judge/
 *  hashLength/cleanCache 等段仅新会话生效（会话内装配在工厂创建时定格）。 */
export interface ReloadChanges {
	/** 检测器集（含 detectorsMode 解析后的最终集）变更——可热应用。 */
	detectors: boolean;
	/** 检测器合并策略变更（展示口径；通常伴随 detectors 变更）。 */
	detectorsMode: boolean;
	/** 伪值哈希段长度变更——仅新会话生效。 */
	hashLength: boolean;
	/** clean cache 调参变更——仅新会话生效。 */
	cleanCache: boolean;
	/** judge 段变更——仅新会话生效。 */
	judge: boolean;
	/** 配置错误列表变更（回退语义变化）。 */
	errors: boolean;
}

/** reload 结果：最新配置 + 按段变更分类。 */
export interface ReloadOutcome {
	/** 重读后的最新配置（与随后 get() 一致）。 */
	config: ResolvedConfig;
	/** 是否有任一配置段实质变更（变更才通知订阅者）。 */
	changed: boolean;
	/** 各段变更标志（相对重读前）。 */
	changes: ReloadChanges;
}

/** 单段深度比较（loader 自建对象键序稳定，JSON 序列化可作等值判定）。 */
const fieldDiffers = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** 重读前后各配置段变更分类（变更判定与订阅通知的唯一口径）。 */
function classifyReload(next: ResolvedConfig, current: ResolvedConfig): ReloadOutcome {
	const changes: ReloadChanges = {
		detectors: fieldDiffers(next.detectors, current.detectors),
		detectorsMode: fieldDiffers(next.detectorsMode, current.detectorsMode),
		hashLength: fieldDiffers(next.hashLength, current.hashLength),
		cleanCache: fieldDiffers(next.cleanCache, current.cleanCache),
		judge: fieldDiffers(next.judge, current.judge),
	errors: fieldDiffers(next.errors, current.errors),
	};
	return { config: next, changed: Object.values(changes).some(Boolean), changes };
}

export interface ConfigLoaderOptions {
	/** 显式配置路径（最高优先级；缺省走环境变量 → 默认路径）。 */
	path?: string;
}

export interface ConfigLoader {
	/** 当前生效配置（创建时即完成首次加载）。 */
	get(): ResolvedConfig;
	/** 重读磁盘并返回变更分类结果；有实质变更时通知订阅者。 */
	reload(): ReloadOutcome;
	/** 订阅配置变更（T7 /keep-secret reload 后热应用检测器集；仅
	 *  outcome.changes.detectors 时才应重编译）。返回解绑函数。 */
	subscribe(listener: (config: ResolvedConfig, outcome: ReloadOutcome) => void): () => void;
}

/** 创建配置 loader：创建即加载，reload 支持热重载（变更订阅）。 */
export function createConfigLoader(options: ConfigLoaderOptions = {}): ConfigLoader {
	const path = options.path ?? process.env[CONFIG_PATH_ENV] ?? defaultConfigPath();
	let current = loadFromDisk(path);
	const listeners = new Set<(config: ResolvedConfig, outcome: ReloadOutcome) => void>();

	return {
		get() {
			return current;
		},
		reload() {
			const next = loadFromDisk(path);
			const outcome = classifyReload(next, current);
			current = next;
			if (outcome.changed) {
				for (const listener of [...listeners]) {
					listener(current, outcome);
				}
			}
			return outcome;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
