/**
 * ticket #6 验收用例（接缝 1）：clean cache 挂接掩码管线检测入口 +
 * 检测器 JSON 配置端到端。
 *
 * 断言口径：
 * - clean cache 注入观察（stats().misses = 实际执行检测的文本数，
 *   即「检测计数器」）：第二轮请求同历史消息不重复检测（只对新增
 *   文本 miss），含 secret 的消息每轮重扫（永不缓存）；
 * - 同一 secret 两轮伪值一致（cache 不破坏确定性）；
 * - 配置文件驱动：自定义 pattern 生效（经真实扩展入口 + 环境变量指向
 *   临时文件）、非法配置回退内置默认集、热重载换检测器集并使干净
 *   判定失效（缓存清空）。
 *
 * 全部配置走临时文件，不触真实 ~/.pi 路径。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_PATH_ENV } from "../src/config/loader.ts";
import { createConfiguredMaskingExtension } from "../src/config/index.ts";
import { createCleanCache } from "../src/cache/index.ts";
import { createEgressMaskingExtension } from "../src/masking/extension.ts";
import { createMaskingPipeline } from "../src/masking/index.ts";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/** 正式扩展入口（目录扩展 index.ts 工厂，读 JSON 配置）。 */
const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";
const CORP_KEY = "corp-zx9abcdefghijklmnopqrs"; // corp-[A-Za-z0-9]{20,}

/** 各测试的环境变量保存与临时目录登记（afterEach 统一恢复/清理）。 */
const tempDirs: string[] = [];
let savedEnv: string | undefined;

function tempConfig(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-keep-secret-t4-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "config.json"), content, "utf8");
	return join(dir, "config.json");
}

beforeEach(() => {
	savedEnv = process.env[CONFIG_PATH_ENV];
});
afterEach(() => {
	if (savedEnv === undefined) {
		delete process.env[CONFIG_PATH_ENV];
	} else {
		process.env[CONFIG_PATH_ENV] = savedEnv;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("T4 clean cache：检测入口挂接（检测计数断言）", () => {
	test("第二轮同历史消息不重复检测：缓存命中旧文本，只检测新增文本", async () => {
		const cache = createCleanCache();
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ cleanCache: cache })],
		});
		try {
			h.provider.setScript([{ text: "ok" }, { text: "ok again" }]);
			await h.session.prompt("alpha beta gamma delta");
			const afterRound1 = cache.stats();

			await h.session.prompt("epsilon zeta eta");
			const afterRound2 = cache.stats();

			// 第一轮：全部文本叶各检测一次（misses = 第一轮文本叶数）
			expect(afterRound1.hits).toBe(0);
			expect(afterRound1.misses).toBeGreaterThanOrEqual(2); // 至少 system + user
			// 第二轮：只有新增文本（助手回复 + 新用户消息）进入检测
			expect(afterRound2.misses - afterRound1.misses).toBe(2);
			// 第一轮全部文本第二轮命中缓存（未重复检测）
			expect(afterRound2.hits - afterRound1.hits).toBe(afterRound1.misses);
		} finally {
			h.dispose();
		}
	});

	test("含 secret 的消息每轮重扫（不缓存），同一 secret 两轮伪值一致", async () => {
		const cache = createCleanCache();
		const h = await createHarnessSession({
			extensionFactories: [createEgressMaskingExtension({ cleanCache: cache })],
		});
		try {
			h.provider.setScript([{ text: "ok" }, { text: "done" }]);
			await h.session.prompt(`deploy with ${OPENAI_KEY}`);
			const afterRound1 = cache.stats();

			await h.session.prompt("status please");
			const afterRound2 = cache.stats();

			// 第二轮检测增量 = 含 secret 的历史用户消息（重扫）+ 助手回复 + 新用户消息
			expect(afterRound2.misses - afterRound1.misses).toBe(3);
			// 第一轮其余干净文本（system 等）全部命中缓存
			expect(afterRound2.hits - afterRound1.hits).toBe(afterRound1.misses - 1);

			// 两轮出站同一伪值，真值始终不出站（确定性不因缓存破坏）
			const [req1, req2] = h.provider.requests();
			const ph1 = requestText(req1).match(/sk-[A-Z2-7]{12}/)?.[0];
			const ph2 = requestText(req2).match(/sk-[A-Z2-7]{12}/)?.[0];
			expect(ph1).toBeDefined();
			expect(ph2).toBe(ph1);
			for (const request of h.provider.requests()) {
				expect(requestText(request)).not.toContain(OPENAI_KEY);
			}
		} finally {
			h.dispose();
		}
	});
});

describe("T4 检测器 JSON 配置端到端（真实扩展入口 + 临时配置文件）", () => {
	const CORP_CONFIG = JSON.stringify({
		detectors: [
			{
				name: "corp-api-key",
				pattern: "corp-[A-Za-z0-9]{20,}",
				redactTemplate: "corp-{hash}",
			},
		],
	});

	test("自定义 pattern 生效：经环境变量指向临时配置，正式入口用配置检测器集", async () => {
		process.env[CONFIG_PATH_ENV] = tempConfig(CORP_CONFIG);
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt(`deploy with ${CORP_KEY} and ${OPENAI_KEY}`);

			const [request] = h.provider.requests();
			const text = requestText(request);
			// 自定义检测器命中：伪值保持 corp-{hash} 形状
			expect(text).not.toContain(CORP_KEY);
			expect(text).toMatch(/corp-[A-Z2-7]{12}/);
			// 配置 detectors 整体替换内置默认集：未配置的默认格式（sk-）不掩
			expect(text).toContain(OPENAI_KEY);
		} finally {
			h.dispose();
		}
	});

	test("非法配置回退内置默认集：默认格式照常掩码，自定义检测器不生效", async () => {
		process.env[CONFIG_PATH_ENV] = tempConfig(
			JSON.stringify({ detectors: [{ name: "corp-api-key", pattern: "corp-[A-Za-z0-9{" }] }),
		);
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt(`deploy with ${CORP_KEY} and ${OPENAI_KEY}`);

			const [request] = h.provider.requests();
			const text = requestText(request);
			// 回退默认集：sk- 照常掩码
			expect(text).not.toContain(OPENAI_KEY);
			expect(text).toMatch(/sk-[A-Z2-7]{12}/);
			// 自定义检测器未生效：corp 形状按原样放行（错误经 loader.get().errors 可见）
			expect(text).toContain(CORP_KEY);
		} finally {
			h.dispose();
		}
	});
});

describe("T4 配置热重载（load/reload/订阅，T7 /keep-secret reload 消费口径）", () => {
	const V1 = JSON.stringify({
		detectors: [
			{ name: "alpha-key", pattern: "alpha-[A-Za-z0-9]{20,}", redactTemplate: "alpha-{hash}" },
		],
	});
	const V2 = JSON.stringify({
		detectors: [
			{ name: "alpha-key", pattern: "alpha-[A-Za-z0-9]{20,}", redactTemplate: "alpha-{hash}" },
			{ name: "beta-key", pattern: "beta-[A-Za-z0-9]{20,}", redactTemplate: "beta-{hash}" },
		],
	});
	const BETA_KEY = "beta-qwertyuiopasdfghjklz";

	test("reload 换检测器集即时生效，且旧的干净判定失效（缓存清空不泄漏）", async () => {
		const path = tempConfig(V1);
		const { factory, loader } = createConfiguredMaskingExtension({ configPath: path });
		const h = await createHarnessSession({ extensionFactories: [factory] });
		try {
			h.provider.setScript([{ text: "ok" }, { text: "done" }]);
			// 第一轮：beta 形状在 v1 检测器集下干净 → 整条消息缓存为 clean
			await h.session.prompt(`rotate ${BETA_KEY}`);
			expect(requestText(h.provider.requests()[0])).toContain(BETA_KEY);

			// 重写配置为 v2（补 beta 检测器）并热重载
			writeFileSync(path, V2, "utf8");
			const reloaded = loader.reload();
			expect(reloaded.config.errors).toEqual([]);
			expect(reloaded.config.detectors.map((d) => d.name)).toContain("beta-key");

			// 第二轮：v1 时代判定干净的 beta 消息必须重新检测并掩码
			// （检测器集变更清空 clean cache，否则缓存的干净判定会造成泄漏）
			await h.session.prompt("status");
			const second = requestText(h.provider.requests()[1]);
			expect(second).not.toContain(BETA_KEY);
			expect(second).toMatch(/beta-[A-Z2-7]{12}/);
		} finally {
			h.dispose();
		}
	});

	test("reload 变更分类驱动热应用：judge-only 变更不清空 clean cache（旧干净判定仍短路）", async () => {
		const path = tempConfig(V1);
		const { factory, loader, pipeline } = createConfiguredMaskingExtension({ configPath: path });
		const h = await createHarnessSession({ extensionFactories: [factory] });
		try {
			h.provider.setScript([{ text: "ok" }, { text: "done" }]);
			await h.session.prompt(`rotate ${BETA_KEY}`); // v1：beta 干净 → 缓存干净结论
			const before = pipeline.cacheStats();

			// 仅新增 judge 段（检测器集不变）：分类判定不应触发热应用
			writeFileSync(
				path,
				JSON.stringify({
					detectors: JSON.parse(V1).detectors,
					judge: { provider: "litellm", modelId: "typesafe/jev-latest" },
				}),
				"utf8",
			);
			const outcome = loader.reload();
			expect(outcome.changes.judge).toBe(true);
			expect(outcome.changes.detectors).toBe(false);

			// 行为锚：reload 后旧文本仍命中缓存——第二轮检测增量仅为新增文本
			//（若误清缓存，历史 system/user 叶将全部重扫，增量 ≥ 3）
			await h.session.prompt("status");
			const after = pipeline.cacheStats();
			expect(after.misses - before.misses).toBe(2);
			expect(after.hits - before.hits).toBe(before.misses);
		} finally {
			h.dispose();
		}
	});

	test("applyDetectors 幂等：相同检测器集 no-op（统计保留），实质变更才清空", () => {
		const alpha = { name: "alpha-key", pattern: "alpha-[A-Za-z0-9]{20,}", template: "alpha-{hash}" };
		const pipeline = createMaskingPipeline({ detectors: [alpha] });
		pipeline.maskText("rotate alpha-qwertyuiopasdfghjklzx"); // 命中 → 墓碑 + 命中计数
		pipeline.maskText("nothing interesting here"); // 干净 → 缓存条目
		const stats = pipeline.cacheStats();
		const hits = pipeline.detectorHitCounts();
		expect(hits.get("alpha-key")).toBe(1);
		expect(stats.size).toBe(1); // 一条干净结论在缓存

		// 同集热应用：no-op——clean cache 与命中统计原样保留
		pipeline.applyDetectors([alpha]);
		expect(pipeline.cacheStats()).toEqual(stats);
		expect(pipeline.detectorHitCounts()).toEqual(hits);

		// 实质变更：清空（旧的干净判定对新检测器集不可信）
		pipeline.applyDetectors([
			alpha,
			{ name: "beta-key", pattern: "beta-[A-Za-z0-9]{20,}", template: "beta-{hash}" },
		]);
		expect(pipeline.cacheStats().size).toBe(0);
		expect(pipeline.detectorHitCounts().size).toBe(0);
	});
});
