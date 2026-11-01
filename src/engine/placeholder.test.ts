import { describe, expect, test } from "bun:test";
import { makePlaceholder } from "./placeholder";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";
const OTHER_SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET2 = "sk-zyxwvutsrqponmlkjihgfed";

// 参考值由行为基准(secret_mask.py 的 _hash_suffix)独立计算:
// base32(sha256(secret)).slice(0, hashLength)。其中 SECRET 的前 12 位
// 与语料 test_stream_unmasker_incremental 硬编码的 "sk-GYY3L4LYIDPR" 一致。
describe("makePlaceholder", () => {
	test("默认模板 {hash}、默认 hashLength 12(语料锚点值)", () => {
		expect(makePlaceholder(SECRET)).toBe("GYY3L4LYIDPR");
	});

	test("模板替换 {hash} 前缀保形", () => {
		expect(makePlaceholder(SECRET, "sk-{hash}")).toBe("sk-GYY3L4LYIDPR");
		expect(makePlaceholder(OTHER_SECRET, "ghp_{hash}")).toBe("ghp_AOVPWAUNKOFQ");
	});

	test("hashLength 可配(生产配 20;52 为 sha256 的完整 base32 长度)", () => {
		expect(makePlaceholder(SECRET, "sk-{hash}", 20)).toBe("sk-GYY3L4LYIDPRZMCXLM3Q");
		expect(makePlaceholder(SECRET, "{hash}", 52)).toBe(
			"GYY3L4LYIDPRZMCXLM3QRSMCZ4FNL6E2ACQ3DLY5ZXZB65NZUHHQ",
		);
	});

	test("同 secret 同伪值(确定性)、不同 secret 不同伪值", () => {
		expect(makePlaceholder(SECRET, "sk-{hash}")).toBe(makePlaceholder(SECRET, "sk-{hash}"));
		expect(makePlaceholder(SECRET, "sk-{hash}")).not.toBe(makePlaceholder(SECRET2, "sk-{hash}"));
	});

	test("模板无 {hash} 占位符则原样返回", () => {
		expect(makePlaceholder(SECRET, "tok-static")).toBe("tok-static");
	});
});
