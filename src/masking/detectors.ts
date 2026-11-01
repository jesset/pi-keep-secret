/**
 * 内置默认 regex 检测器集（T4 配置加载之前的出厂默认；T4 起可由
 * JSON 配置覆盖/扩展）。模式对齐规格 #1 用户故事 2 的已知格式清单，
 * 形状保守：定长格式带尾部断言，避免截断命中破坏数据。
 * PEM 私钥/JWT 留待 T4（配置化多行模式）与 T5（judge 兜自造格式）。
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
];
