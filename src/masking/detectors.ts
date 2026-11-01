/**
 * 内置默认 regex 检测器集（出厂默认；T4 起可由 JSON 配置整体替换）。
 * 模式对齐规格 #1 用户故事 2 的已知格式清单，形状保守：定长格式带
 * 尾部断言，避免截断命中破坏数据。
 *
 * T4 补全：PEM 私钥（多行 BEGIN PRIVATE KEY 块，RSA/EC/DSA/OPENSSH/
 * ENCRYPTED 变体）与 JWT（eyJ 三段，每段 ≥10 字符，截断两段不命中）。
 */
import type { RegexDetectorSpec } from "../engine/index.ts";

export const DEFAULT_DETECTOR_SPECS: RegexDetectorSpec[] = [
	{
		name: "openai-key",
		// sk-ant- 是 Anthropic 前缀，非 OpenAI 格式（对齐参考实现配置）
		pattern: "sk-(?!ant-)[A-Za-z0-9_-]{20,}",
		template: "sk-{hash}",
	},
	{
		name: "github-pat",
		pattern: "ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])",
		template: "ghp_{hash}",
	},
	{
		name: "aws-access-key-id",
		pattern: "AKIA[0-9A-Z]{16}(?![0-9A-Z])",
		template: "AKIA{hash}",
	},
	{
		name: "google-api-key",
		pattern: "AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])",
		template: "AIza{hash}",
	},
	{
		name: "slack-bot-token",
		pattern: "xoxb-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])",
		template: "xoxb-{hash}",
	},
	{
		// 多行 PEM 私钥块（含 RSA/EC/DSA/OPENSSH/ENCRYPTED 标签变体）；
		// [\s\S]*? 跨行非贪婪配对 BEGIN/END，整块替换
		name: "pem-private-key",
		pattern: "-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----",
		// 伪值仍是合法形状的 PEM 块（模型按“一块私钥”对待）
		template: "-----BEGIN PRIVATE KEY-----\n{hash}\n-----END PRIVATE KEY-----",
	},
	{
		// JWT：eyJ 起头的三段 base64url（header.payload.signature），
		// 每段 ≥10 字符，两段截断不命中
		name: "jwt",
		pattern: "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
		// 三段 {hash} 均替换为同一哈希段，保持三段 JWT 形状
		template: "eyJ{hash}.{hash}.{hash}",
	},
];
