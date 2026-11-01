/**
 * 检测器 JSON 配置加载/校验/热重载接口用例（ticket #6 / T4）。
 *
 * 语义（研究笔记 §3 + 参考 README 配置节）：
 * - 路径解析优先级：显式参数 > 环境变量 PI_KEEP_SECRET_CONFIG > 默认
 *   ~/.pi/agent/extensions/pi-keep-secret/config.json；
 * - 文件不存在 → 内置默认集、无错误（默认安装无配置文件）；
 * - 任何非法（JSON 解析/schema/regex 编译）→ errors 可见 + 整体回退
 *   内置默认集（全有或全无，不做部分采纳）；
 * - 解析产物可直接喂 createEgressMaskingExtension（redactTemplate →
 *   引擎 spec 的 template）；
 * - reload() 重读并按内容变更通知订阅者（热重载钩子，T7 /keep-secret
 *   reload 消费）。
 *
 * 全部用临时目录配置文件，不触真实 ~/.pi 路径。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compileRegexDetector } from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "../masking/detectors.ts";
import { CONFIG_PATH_ENV, createConfigLoader } from "./loader.ts";

const ENV_KEY = CONFIG_PATH_ENV;

/** 本用例创建的临时配置目录（afterEach 统一清理）。 */
const tempDirs: string[] = [];

/** 建临时目录并写入配置文件，返回路径（测试自清理）。 */
function writeTempConfig(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-cfg-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "config.json"), content, "utf8");
	return join(dir, "config.json");
}

const CORP_CONFIG = JSON.stringify({
	detectors: [
		{
			name: "corp-api-key",
			pattern: "corp-[A-Za-z0-9]{20,}",
			redactTemplate: "corp-{hash}",
		},
	],
});

describe("配置加载与校验", () => {
	let savedEnv: string | undefined;
	beforeEach(() => {
		savedEnv = process.env[ENV_KEY];
	});
	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env[ENV_KEY];
		} else {
			process.env[ENV_KEY] = savedEnv;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("文件不存在：内置默认集生效，无错误", () => {
		const missing = join(tmpdir(), "pi-keep-secret-absent", "config.json");
		const loader = createConfigLoader({ path: missing });
		const config = loader.get();
		expect(config.exists).toBe(false);
		expect(config.errors).toEqual([]);
		expect(config.detectors).toEqual(DEFAULT_DETECTOR_SPECS);
	});

	test("自定义 pattern 生效：redactTemplate 映射为引擎 template，产物可直接编译", () => {
		const loader = createConfigLoader({ path: writeTempConfig(CORP_CONFIG) });
		const config = loader.get();
		expect(config.exists).toBe(true);
		expect(config.errors).toEqual([]);
		expect(config.detectors).toEqual([
			{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9]{20,}", template: "corp-{hash}" },
		]);
		// 直接喂掩码扩展的编译入口不抛错（createEgressMaskingExtension 同款装配）
		expect(() => config.detectors.map(compileRegexDetector)).not.toThrow();
	});

	test("非法 JSON：错误可见并整体回退内置默认集", () => {
		const loader = createConfigLoader({ path: writeTempConfig("{ not json") });
		const config = loader.get();
		expect(config.errors.length).toBeGreaterThan(0);
		expect(config.detectors).toEqual(DEFAULT_DETECTOR_SPECS);
	});

	test("非法 regex：错误含检测器名并回退默认集", () => {
		const loader = createConfigLoader({
			path: writeTempConfig(
				JSON.stringify({
					detectors: [{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9{" }],
				}),
			),
		});
		const config = loader.get();
		expect(config.errors.join("\n")).toContain("corp-api-key");
		expect(config.detectors).toEqual(DEFAULT_DETECTOR_SPECS);
	});

	test("schema 违例逐类可见并回退：形状/空名/空列表/重名/越界/未知键", () => {
		const cases: Array<{ json: unknown; fragment: string }> = [
			{ json: { detectors: "nope" }, fragment: "detectors" },
			{ json: { detectors: [{ pattern: "corp-x{20,}" }] }, fragment: "name" },
			{
				json: { detectors: [{ name: "corp-api-key", pattern: 42 }] },
				fragment: "pattern",
			},
			{ json: { detectors: [] }, fragment: "at least one" },
			{
				json: {
					detectors: [
						{ name: "dup", pattern: "aaa20charsexactlyyy" },
						{ name: "dup", pattern: "bbb20charsexactlyyy" },
					],
				},
				fragment: "dup",
			},
			{ json: { hashLength: 0 }, fragment: "hashLength" },
			{ json: { hashLength: 999 }, fragment: "hashLength" },
			{ json: { cleanCache: { limit: 0 } }, fragment: "cleanCache" },
			{ json: { detector: [] }, fragment: "detector" }, // 键名 typo 不被静默忽略
		];
		for (const { json, fragment } of cases) {
			const loader = createConfigLoader({ path: writeTempConfig(JSON.stringify(json)) });
			const config = loader.get();
			expect(config.errors.join("\n")).toContain(fragment);
			expect(config.detectors).toEqual(DEFAULT_DETECTOR_SPECS);
		}
	});

	test("合法配置的 hashLength 与 cleanCache 调参透出", () => {
		const loader = createConfigLoader({
			path: writeTempConfig(
				JSON.stringify({
					detectors: [{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9]{20,}" }],
				hashLength: 20,
				cleanCache: { limit: 100, ttlMs: 3600_000 },
				}),
			),
		});
		const config = loader.get();
		expect(config.errors).toEqual([]);
		expect(config.hashLength).toBe(20);
		expect(config.cleanCache).toEqual({ limit: 100, ttlMs: 3600_000 });
	});

	test("未配置 judge 段：judge 为 undefined（仅 regex 检测层）", () => {
		const loader = createConfigLoader({ path: writeTempConfig(CORP_CONFIG) });
		expect(loader.get().judge).toBeUndefined();
	});

	test("judge 段解析：provider/modelId 必填，阈值调参透出（未配项 undefined）", () => {
		const loader = createConfigLoader({
			path: writeTempConfig(
				JSON.stringify({
					judge: {
					provider: "litellm",
					modelId: "typesafe/jev-latest",
					gateThreshold: 0.4,
					candidateThreshold: 0.8,
					redactTemplate: "secret-{hash}",
					},
				}),
			),
		});
		const config = loader.get();
		expect(config.errors).toEqual([]);
		expect(config.judge).toEqual({
			provider: "litellm",
			modelId: "typesafe/jev-latest",
			gateThreshold: 0.4,
			candidateThreshold: 0.8,
			batchSize: undefined,
			maxBatches: undefined,
			maxChars: undefined,
			minCandidateLength: undefined,
			concurrency: undefined,
			redactTemplate: "secret-{hash}",
			onMissing: undefined,
		});
	});

	test("judge.onMissing 解析：fail_closed / regex_only 两合法值透出（缺省 undefined → 消费方默认 fail_closed）", () => {
		for (const onMissing of ["fail_closed", "regex_only"] as const) {
			const loader = createConfigLoader({
				path: writeTempConfig(
					JSON.stringify({ judge: { provider: "litellm", modelId: "jev", onMissing } }),
				),
			});
			const config = loader.get();
			expect(config.errors).toEqual([]);
			expect(config.judge?.onMissing).toBe(onMissing);
		}
		const loader = createConfigLoader({
			path: writeTempConfig(JSON.stringify({ judge: { provider: "litellm", modelId: "jev" } })),
		});
		expect(loader.get().judge?.onMissing).toBeUndefined(); // 未配置即默认 fail_closed
	});

	test("judge.api 解析：systemone / decisions 两合法值透出（缺省 undefined → 跟随模型注册条目 api，不校验）", () => {
		for (const api of ["systemone", "decisions"] as const) {
			const loader = createConfigLoader({
				path: writeTempConfig(
					JSON.stringify({ judge: { provider: "litellm", modelId: "jev", api } }),
				),
			});
			const config = loader.get();
			expect(config.errors).toEqual([]);
			expect(config.judge?.api).toBe(api);
		}
		const loader = createConfigLoader({
			path: writeTempConfig(JSON.stringify({ judge: { provider: "litellm", modelId: "jev" } })),
		});
		expect(loader.get().judge?.api).toBeUndefined(); // 未配置即不校验，跟随模型注册
	});

	test("judge 段非法：错误可见、judge 不生效（整体回退语义）", () => {
		const cases: Array<{ json: unknown; fragment: string }> = [
			{ json: { judge: { modelId: "jev" } }, fragment: "provider" },
			{ json: { judge: { provider: "litellm" } }, fragment: "modelId" },
			{ json: { judge: { provider: "", modelId: "jev" } }, fragment: "provider" },
			{ json: { judge: { provider: "litellm", modelId: "jev", gateThreshold: 2 } }, fragment: "gateThreshold" },
			{ json: { judge: { provider: "litellm", modelId: "jev", candidateThreshold: "0.7" } }, fragment: "candidateThreshold" },
			{ json: { judge: { provider: "litellm", modelId: "jev", batchSize: 0 } }, fragment: "batchSize" },
			{ json: { judge: { provider: "litellm", modelId: "jev", maxBatches: 1.5 } }, fragment: "maxBatches" },
			{ json: { judge: { provider: "litellm", modelId: "jev", maxChars: 0 } }, fragment: "maxChars" },
			{ json: { judge: { provider: "litellm", modelId: "jev", minCandidateLength: 0 } }, fragment: "minCandidateLength" },
			{ json: { judge: { provider: "litellm", modelId: "jev", concurrency: 0 } }, fragment: "concurrency" },
			{ json: { judge: { provider: "litellm", modelId: "jev", redactTemplate: "" } }, fragment: "redactTemplate" },
			{ json: { judge: { provider: "litellm", modelId: "jev", onMissing: "permissive" } }, fragment: "onMissing" }, // 只允许 fail_closed | regex_only
			{ json: { judge: { provider: "litellm", modelId: "jev", onMissing: true } }, fragment: "onMissing" },
			{ json: { judge: { provider: "litellm", modelId: "jev", api: "openai" } }, fragment: "api" }, // 只允许 systemone | decisions
			{ json: { judge: { provider: "litellm", modelId: "jev", api: true } }, fragment: "api" },
			{ json: { judge: { provider: "litellm", modelId: "jev", gate: 0.5 } }, fragment: "judge" }, // 键名 typo 不被静默忽略
			{ json: { judge: "litellm" }, fragment: "judge" },
		];
		for (const { json, fragment } of cases) {
			const loader = createConfigLoader({ path: writeTempConfig(JSON.stringify(json)) });
			const config = loader.get();
			expect(config.errors.join("\n")).toContain(fragment);
			expect(config.judge).toBeUndefined(); // 任一非法：judge 段不生效（不部分采纳）
			expect(config.detectors).toEqual(DEFAULT_DETECTOR_SPECS);
		}
	});

	test("路径解析优先级：显式参数 > 环境变量 > 未设时的默认路径", () => {
		const explicit = writeTempConfig(CORP_CONFIG);
		const viaEnv = writeTempConfig(
			JSON.stringify({ detectors: [{ name: "env-key", pattern: "env-[A-Za-z0-9]{20,}" }] }),
		);
		// 显式参数胜出
		process.env[ENV_KEY] = viaEnv;
		expect(createConfigLoader({ path: explicit }).get().detectors[0].name).toBe("corp-api-key");
		// 无参数时走环境变量
		expect(createConfigLoader().get().detectors[0].name).toBe("env-key");
		// 都未设：解析到默认路径（不断言读到的内容——不依赖机器上是否存在该文件）
		delete process.env[ENV_KEY];
		const config = createConfigLoader().get();
		expect(config.path).toBe(
			join(homedir(), ".pi", "agent", "extensions", "pi-keep-secret", "config.json"),
		);
	});
});

describe("配置热重载（load/reload/订阅变更）", () => {
	let savedEnv: string | undefined;
	beforeEach(() => {
		savedEnv = process.env[ENV_KEY];
	});
	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env[ENV_KEY];
		} else {
			process.env[ENV_KEY] = savedEnv;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reload 重读文件：内容变更通知订阅者，get() 反映新配置", () => {
		const path = writeTempConfig(CORP_CONFIG);
		const loader = createConfigLoader({ path });
		const seen: string[] = [];
		const unsubscribe = loader.subscribe((config) => {
			seen.push(config.detectors[0]?.name ?? "<defaults>");
		});

		expect(loader.get().detectors[0].name).toBe("corp-api-key");
		expect(seen).toEqual([]); // 订阅只在变更时通知，订阅本身不回放

		writeFileSync(
			path,
			JSON.stringify({ detectors: [{ name: "corp-v2", pattern: "corp-[A-Za-z0-9]{20,}" }] }),
			"utf8",
		);
		const reloaded = loader.reload();
		expect(reloaded.detectors[0].name).toBe("corp-v2");
		expect(loader.get().detectors[0].name).toBe("corp-v2");
		expect(seen).toEqual(["corp-v2"]);

		unsubscribe();
		loader.reload();
		expect(seen).toEqual(["corp-v2"]); // 解绑后不再通知
	});

	test("内容未变的 reload 不通知；坏配置 reload 后回退默认并通知", () => {
		const path = writeTempConfig(CORP_CONFIG);
		const loader = createConfigLoader({ path });
		const seen: number[] = [];
		loader.subscribe(() => seen.push(1));

		loader.reload(); // 同内容
		expect(seen).toEqual([]);

		writeFileSync(path, "{ broken", "utf8");
		const reloaded = loader.reload();
		expect(reloaded.errors.length).toBeGreaterThan(0);
		expect(reloaded.detectors).toEqual(DEFAULT_DETECTOR_SPECS);
		expect(seen).toEqual([1]);
	});
});
