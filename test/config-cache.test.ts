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
import { createCleanCache } from "../src/cache/index.ts";
import { createEgressMaskingExtension } from "../src/masking/extension.ts";
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
