/**
 * 检测/伪值字符串引擎公共接口(测试接缝 2,纯函数、零 pi 依赖、零 IO)。
 *
 * 消费方:
 * - T2(出站掩码驱动):compileRegexDetector(配置加载时编译)→
 *   detectRegexSpans(逐文本叶)→ redactText(替换并取回替换记录写注册表)。
 * - T3/T5(回程还原 / judge):unmaskText(tokens 取自注册表);
 *   extractCandidates 抽候选供 systemone 判定,命中后转 Span 并入同一
 *   redactText 管线(judge spans 无需长段豁免——候选层已按 >512 丢弃)。
 *
 * 语义基准:apps/litellm guardrails secret_mask.py(只读参考实现)。
 */
export type { Span } from "./span";
export { mergeSpans } from "./span";
export { exemptLongRuns } from "./exempt-long-runs";
export type { RegexDetectorSpec, CompiledRegexDetector } from "./detect";
export { compileRegexDetector, regexSpans, detectRegexSpans } from "./detect";
export type { Candidate } from "./candidate";
export { extractCandidates } from "./candidate";
export { makePlaceholder } from "./placeholder";
export type { Replacement, PlaceholderIssuer, RedactOptions } from "./redact";
export { redactText } from "./redact";
export { unmaskText } from "./unmask";
