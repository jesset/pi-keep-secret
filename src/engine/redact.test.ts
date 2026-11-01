import { describe, expect, test } from "bun:test";
import { redactText } from "./redact";
import type { Span } from "./span";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";
const OTHER_SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET2 = "sk-zyxwvutsrqponmlkjihgfed";

const templates = new Map<string, string>([
	["openai", "sk-{hash}"],
	["github", "ghp_{hash}"],
]);

function spanIn(text: string, needle: string, detector: string): Span {
	const start = text.indexOf(needle);
	return { start, end: start + needle.length, detector };
}

describe("redactText", () => {
	test("命中替换为格式保真伪值,原文不再出现(语料 test_regex_mask_consistent_hash)", () => {
		const text = `please use my key ${SECRET} thanks`;
		const { text: out, replacements } = redactText(text, [spanIn(text, SECRET, "openai")], templates);
		expect(out).toBe(`please use my key sk-GYY3L4LYIDPR thanks`);
		expect(out).not.toContain(SECRET);
		expect(replacements).toEqual([
			{ placeholder: "sk-GYY3L4LYIDPR", secret: SECRET, detector: "openai" },
		]);
	});

	test("同一 secret 多次出现复用同一伪值(语料 test_same_secret_same_placeholder)", () => {
		const text = `${SECRET} and again ${SECRET}`;
		const first = text.indexOf(SECRET);
		const second = text.indexOf(SECRET, first + 1);
		const { text: out, replacements } = redactText(
			text,
			[
				{ start: first, end: first + SECRET.length, detector: "openai" },
				{ start: second, end: second + SECRET.length, detector: "openai" },
			],
			templates,
		);
		// 同 secret 同伪值(确定性哈希),两处均被替换
		expect(replacements).toHaveLength(2);
		const ph = replacements[0].placeholder;
		expect(replacements[1].placeholder).toBe(ph);
		expect(out.split(ph).length - 1).toBe(2);
	});

	test("不同 secret 得到不同伪值(语料 test_different_secrets_get_distinct_placeholders)", () => {
		const text = `${SECRET} and ${OTHER_SECRET}`;
		const { replacements } = redactText(
			text,
			[spanIn(text, SECRET, "openai"), spanIn(text, OTHER_SECRET, "github")],
			templates,
		);
		expect(replacements).toHaveLength(2);
		expect(new Set(replacements.map((r) => r.placeholder)).size).toBe(2);
		expect(new Set(replacements.map((r) => r.secret))).toEqual(new Set([SECRET, OTHER_SECRET]));
	});

	test("无 span 原样返回(语料 test_no_secret_untouched)", () => {
		const { text: out, replacements } = redactText("clean message", [], templates);
		expect(out).toBe("clean message");
		expect(replacements).toEqual([]);
	});

	test("span 的 detector 无模板配置时抛错", () => {
		const text = `x ${SECRET2}`;
		expect(() => redactText(text, [spanIn(text, SECRET2, "unknown")], templates)).toThrow(/unknown/);
	});

	describe("注入伪值签发器", () => {
		test("issuePlaceholder 覆盖默认哈希签发(注册表层碰撞兜底的注入点)", () => {
			const text = `keys ${SECRET} and ${SECRET2}`;
			const issued = new Map<string, string>([
				[SECRET, "sk-COLLIDED"],
			[SECRET2, "sk-COLLIDEDx"],
			]);
			const { text: out, replacements } = redactText(
				text,
				[spanIn(text, SECRET, "openai"), spanIn(text, SECRET2, "openai")],
				templates,
				{ hashLength: undefined, issuePlaceholder: (secret) => issued.get(secret)! },
			);
			expect(out).toBe("keys sk-COLLIDED and sk-COLLIDEDx");
			expect(replacements.map((r) => r.placeholder)).toEqual(["sk-COLLIDED", "sk-COLLIDEDx"]);
		});

		test("缺省注入时行为不变(仍走 makePlaceholder 确定性哈希)", () => {
			const text = `key ${SECRET}`;
			const { text: out } = redactText(text, [spanIn(text, SECRET, "openai")], templates, {});
			expect(out).toBe("key sk-GYY3L4LYIDPR");
		});
	});

	test("替换只动 span 区间,前后文及句读不动", () => {
		const text = `My key: ${SECRET}.`;
		const { text: out } = redactText(text, [spanIn(text, SECRET, "openai")], templates);
		expect(out).toBe("My key: sk-GYY3L4LYIDPR.");
	});
});
