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
 *   "cleanCache": { "limit": 20000, "ttlMs": 86400000 }
 * }
 * ```
 * - `detectors` **整体替换**内置默认集（对齐参考实现 secret_detectors
 *   语义，用户故事 30「tune detectors」）；`redactTemplate` 映射为引擎
 *   RegexDetectorSpec.template，产物可直接喂 createEgressMaskingExtension。
 * - 路径解析优先级：显式参数 > 环境变量 PI_KEEP_SECRET_CONFIG > 默认
 *   ~/.pi/agent/extensions/pi-keep-secret/config.json。
 * - 文件不存在 → 内置默认集、无错误（默认安装无配置文件）。
 * - 任何非法（读失败/JSON 解析/schema/regex 编译）→ errors 可见 +
 *   **整体回退**内置默认集（全有或全无，不做部分采纳）。
 * - 热重载：reload() 重读磁盘并按内容指纹判定变更，变更才通知订阅者
 *   （T7 的 /keep-secret reload 消费；hashLength/cleanCache 变更仅在
 *   新会话生效，检测器集变更经订阅即时热应用）。
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

/** clean cache 调参（缺省项由 createCleanCache 的默认值兜底）。 */
export interface CleanCacheConfig {
	/** 容量上限（默认 20000）。 */
	limit?: number;
	/** TTL 毫秒（默认 24 小时）。 */
	ttlMs?: number;
}

/** 一次加载的解析结果（错误非空时 detectors 为内置默认集回退）。 */
export interface ResolvedConfig {
	/** 解析来源路径。 */
	path: string;
	/** 配置文件是否存在。 */
	exists: boolean;
	/** 生效检测器 specs（可直接喂 createEgressMaskingExtension）。 */
	detectors: RegexDetectorSpec[];
	/** 伪值哈希段长度；未配置为 undefined（引擎默认 12）。 */
	hashLength?: number;
	/** clean cache 调参；未配置为 undefined（默认 20000/24h）。 */
	cleanCache?: CleanCacheConfig;
	/** 加载/校验错误（空 = 配置有效或文件不存在）。 */
	errors: string[];
}

/** 内置默认集副本（避免调用方改动污染共享常量）。 */
function defaultDetectors(): RegexDetectorSpec[] {
	return DEFAULT_DETECTOR_SPECS.map((spec) => ({ ...spec }));
}

const ROOT_KEYS = new Set(["detectors", "hashLength", "cleanCache"]);
const DETECTOR_KEYS = new Set(["name", "pattern", "redactTemplate"]);
const CLEAN_CACHE_KEYS = new Set(["limit", "ttlMs"]);
/** base32(sha256) 无 padding 共 52 字符，哈希段长度上限由此决定。 */
const MAX_HASH_LENGTH = 52;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 正整数校验（含整数性）。 */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * 校验已解析的 JSON 值。返回合法字段，或错误列表（任一错误即整体回退）。
 */
function validateConfig(json: unknown): {
	detectors?: RegexDetectorSpec[];
	hashLength?: number;
	cleanCache?: CleanCacheConfig;
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

	return errors.length > 0
		? { errors }
		: { detectors, hashLength, cleanCache, errors };
}

/** 从磁盘读取并解析一次配置（错误都落 errors，绝不抛出）。 */
function loadFromDisk(path: string): ResolvedConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const notFound = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
		if (notFound) {
			return { path, exists: false, detectors: defaultDetectors(), errors: [] };
		}
		return {
			path,
			exists: false,
			detectors: defaultDetectors(),
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
			errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const validated = validateConfig(json);
	if (validated.errors.length > 0) {
		return { path, exists: true, detectors: defaultDetectors(), errors: validated.errors };
	}
	return {
		path,
		exists: true,
		detectors: validated.detectors ?? defaultDetectors(),
		hashLength: validated.hashLength,
		cleanCache: validated.cleanCache,
		errors: [],
	};
}

/** 配置内容指纹（reload 变更判定与订阅通知依据）。 */
function fingerprint(config: ResolvedConfig): string {
	return JSON.stringify([config.exists, config.detectors, config.hashLength, config.cleanCache, config.errors]);
}

export interface ConfigLoaderOptions {
	/** 显式配置路径（最高优先级；缺省走环境变量 → 默认路径）。 */
	path?: string;
}

export interface ConfigLoader {
	/** 当前生效配置（创建时即完成首次加载）。 */
	get(): ResolvedConfig;
	/** 重读磁盘并返回最新配置；内容变更时通知订阅者。 */
	reload(): ResolvedConfig;
	/** 订阅配置变更（T7 /keep-secret reload 后热应用检测器集）。返回解绑函数。 */
	subscribe(listener: (config: ResolvedConfig) => void): () => void;
}

/** 创建配置 loader：创建即加载，reload 支持热重载（变更订阅）。 */
export function createConfigLoader(options: ConfigLoaderOptions = {}): ConfigLoader {
	const path = options.path ?? process.env[CONFIG_PATH_ENV] ?? defaultConfigPath();
	let current = loadFromDisk(path);
	const listeners = new Set<(config: ResolvedConfig) => void>();

	return {
		get() {
			return current;
		},
		reload() {
			const next = loadFromDisk(path);
			const changed = fingerprint(next) !== fingerprint(current);
			current = next;
			if (changed) {
				for (const listener of [...listeners]) {
					listener(current);
				}
			}
			return current;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
