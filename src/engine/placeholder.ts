import { createHash } from "node:crypto";

/** RFC 4648 base32 字母表(大写,与 Python base64.b32encode 一致)。 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 字节序列 → 无 padding 大写 base32(Python `b32encode(...).rstrip("=")`)。 */
function base32Encode(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return out;
}

/**
 * 伪值生成:template.replaceAll("{hash}", base32(sha256(secret)).slice(0, hashLength))。
 * {hash} 可多次出现(如 JWT 三段模板 "eyJ{hash}.{hash}.{hash}"),各处均替换
 * 为同一哈希段(参考实现 redact_template "可多次出现保持形状" 语义)。
 *
 * 一致性哈希——伪值只由 (secret, template, hashLength) 决定,同一 secret 跨轮、
 * 跨消息恒得同一伪值:provider 每轮重收相同掩码文本,prompt-cache 前缀与
 * provider 侧签名才可能保持一致(规格 #1 Implementation Decisions)。
 * hashLength 默认 12(LiteLLM 生产配 20)。
 */
export function makePlaceholder(secret: string, template = "{hash}", hashLength = 12): string {
	const digest = createHash("sha256").update(secret, "utf8").digest();
	return template.replaceAll("{hash}", base32Encode(digest).slice(0, hashLength));
}
