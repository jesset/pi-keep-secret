/**
 * ticket #5 验收用例（接缝 1）：回程还原——脚本化响应回显的伪值在
 * transcript 落盘与工具执行之前还原为真值。参考 GitHub issue
 * jesset/pi-keep-secret#5 的 Acceptance criteria 逐条落成用例。
 *
 * 断言只看外部行为：假供应商收到什么（供应商视角，只见过伪值、只能
 * 回显伪值）、本地 transcript 与工具执行收到什么（真值）。
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makePlaceholder } from "../src/engine/index.ts";
import { createHarnessSession, requestText } from "../src/harness/fake-session.ts";

/** 正式扩展入口（目录扩展 index.ts 工厂：出站掩码 + 回程还原组合）。 */
const EXTENSION_ENTRY = join(import.meta.dir, "..", "extension", "index.ts");

/** 真值样本（形状对齐内置默认 openai-key 检测器）。 */
const OPENAI_KEY = "sk-live-abcdefghijklmnopqrst";
/** 出站确定性伪值（默认 hashLength=12；脚本化回显只能用供应商见过的伪值）。 */
const OPENAI_PH = makePlaceholder(OPENAI_KEY, "sk-{hash}", 12);

describe("T3 回程还原：message_end + tool_call", () => {
	test("脚本化文本响应回显伪值：transcript 落真值，供应商全程只见伪值", async () => {
		const h = await createHarnessSession({ extensionPaths: [EXTENSION_ENTRY] });
		try {
			// 供应商只见过伪值，脚本化回显伪值
			h.provider.setScript([{ text: `the key is ${OPENAI_PH}` }]);
			await h.session.prompt(`use my key ${OPENAI_KEY}`);

			// 供应商视角：出站只见伪值
			const [request] = h.provider.requests();
			expect(requestText(request)).toContain(OPENAI_PH);
			expect(requestText(request)).not.toContain(OPENAI_KEY);
			// 本地 transcript：助手文本已还原为真值
			expect(h.session.getLastAssistantText()).toBe(`the key is ${OPENAI_KEY}`);

			// 还原后的助手历史进入本地 transcript；下一轮出站重新掩码（伪值确定性）
			h.provider.setScript([{ text: "ok" }]);
			await h.session.prompt("again");
			const requests = h.provider.requests();
			const last = requests[requests.length - 1];
			expect(requestText(last)).not.toContain(OPENAI_KEY);
			expect(requestText(last)).toContain(OPENAI_PH);
		} finally {
			h.dispose();
		}
	});
});
