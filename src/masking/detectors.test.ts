/**
 * 内置默认 regex 检测器集接口用例（ticket #6 / T4）：T2 的五种已知
 * 格式之外补 PEM 私钥（多行 BEGIN PRIVATE KEY 块）与 JWT（eyJ 三段）。
 *
 * 断言经引擎公共接口（compile → detectRegexSpans → redactText）走完整
 * 检测/替换路径；负例锚定保守形状（截断 JWT 两段不命中）。
 */
import { describe, expect, test } from "bun:test";
import {
	compileRegexDetector,
	detectRegexSpans,
	redactText,
	type CompiledRegexDetector,
} from "../engine/index.ts";
import { DEFAULT_DETECTOR_SPECS } from "./detectors.ts";

/** T2 既有默认集仍完整在场（T4 只增不删）。 */
const T2_NAMES = [
	"openai-key",
	"github-pat",
	"aws-access-key-id",
	"google-api-key",
	"slack-bot-token",
];

/** 按内置默认集编译（与掩码管线同一装配路径）。 */
function compileDefaults(): {
	detectors: CompiledRegexDetector[];
	templates: Map<string, string>;
} {
	const detectors = DEFAULT_DETECTOR_SPECS.map(compileRegexDetector);
	return { detectors, templates: new Map(detectors.map((d) => [d.name, d.template])) };
}

/** 掩码一段文本并返回结果（含命中检测器名）。 */
function maskDefaults(text: string): { text: string; detectors: string[] } {
	const { detectors, templates } = compileDefaults();
	const spans = detectRegexSpans(detectors, text);
	const { text: masked, replacements } = redactText(text, spans, templates);
	return { text: masked, detectors: [...new Set(replacements.map((r) => r.detector))] };
}

const PEM_RSA = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfnLyJIMTiiaZJEVJbhcy2Q7GiRlf6bm
4hdKdtq0vatRqmvnf3ZZkkPdR2E0S0O3blWwD8faXmJ2mIFo/9AeSy2b9WIQ
-----END RSA PRIVATE KEY-----`;

const PEM_OPENSSH = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEAtc0vL3noz5VSTNtmDp3dKZsPTl9yqUeVly0GQ==
-----END OPENSSH PRIVATE KEY-----`;

const JWT =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N2LgL0n3I9PlFUP0THsR8U";

describe("内置默认检测器集（T4 补 PEM/JWT）", () => {
	test("T2 五种已知格式默认集保持兼容（只增不删）", () => {
		const names = DEFAULT_DETECTOR_SPECS.map((spec) => spec.name);
		for (const name of T2_NAMES) {
			expect(names).toContain(name);
		}
		expect(names).toContain("pem-private-key");
		expect(names).toContain("jwt");
	});

	test("PEM 私钥块整块掩码，伪值保持 PEM 块形状（RSA/OPENSSH 变体）", () => {
		for (const pem of [PEM_RSA, PEM_OPENSSH]) {
			const { text, detectors } = maskDefaults(pem);
			expect(detectors).toEqual(["pem-private-key"]);
			expect(text).not.toContain("MIIEpAIBAAKCAQEA");
			expect(text).not.toContain("b3BlbnNzaC1rZXktdjE");
			// 伪值是仍是合法形状的 PEM 块（BEGIN/END + base32 哈希段）
			expect(text).toMatch(
				/^-----BEGIN PRIVATE KEY-----\n[A-Z2-7]{12}\n-----END PRIVATE KEY-----$/,
			);
		}
	});

	test("JWT 三段整体掩码，伪值保持 eyJ 三段形状；截断两段不命中", () => {
		const { text, detectors } = maskDefaults(`token: ${JWT} end`);
		expect(detectors).toEqual(["jwt"]);
		expect(text).not.toContain(JWT);
		expect(text).toMatch(/token: eyJ[A-Z2-7]{12}\.[A-Z2-7]{12}\.[A-Z2-7]{12} end/);

		// 两段（非 JWT 形状）不命中：伪值自匹配与散文误报都靠保守形状避免
		const twoSegment = maskDefaults("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0");
		expect(twoSegment.detectors).toEqual([]);
		expect(twoSegment.text).toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0");
	});
});
