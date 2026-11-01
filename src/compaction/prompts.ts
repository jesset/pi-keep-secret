/**
 * 掩码压缩的摘要提示词（对齐 pi 默认压缩/分支摘要提示词）。
 *
 * pi 1.4.0 未从包公开导出这些提示词常量（dist/core/compaction/compaction.js、
 * branch-summarization.js、utils.js 内部常量），为保持摘要质量与 pi 默认
 * 压缩对齐（研究笔记 §6：沿用 pi 的摘要提示词可减小差异），按 1.4.0 原文
 * 复制于此；升级 pi 版本时需同步校对。
 */

/** 摘要调用的 system 提示词（pi utils.js SUMMARIZATION_SYSTEM_PROMPT 原文）。 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** 首次压缩摘要指令（pi compaction.js SUMMARIZATION_PROMPT 原文）。 */
const COMPACTION_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 迭代更新压缩摘要指令（pi compaction.js UPDATE_SUMMARIZATION_PROMPT 原文）。 */
const COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 分支摘要指令（pi branch-summarization.js BRANCH_SUMMARY_PROMPT 原文）。 */
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 分支摘要正文前导（pi branch-summarization.js BRANCH_SUMMARY_PREAMBLE 原文）。 */
export const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

/** 组装压缩摘要提示词：序列化对话 + 上一份摘要（均已掩码）+ 指令。 */
export function buildCompactionPrompt(input: {
	conversationText: string;
	/** 上一次压缩的摘要（掩码后传入；缺省走首次摘要指令）。 */
	previousSummary?: string;
	/** /compact 自定义聚焦指令（掩码后传入）。 */
	customInstructions?: string;
}): string {
	let promptText = `<conversation>\n${input.conversationText}\n</conversation>\n\n`;
	if (input.previousSummary !== undefined) {
		promptText += `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`;
	}
	let basePrompt = input.previousSummary !== undefined ? COMPACTION_UPDATE_PROMPT : COMPACTION_SUMMARIZATION_PROMPT;
	if (input.customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${input.customInstructions}`;
	}
	return promptText + basePrompt;
}

/** 组装分支摘要提示词：序列化对话（已掩码）+ 指令。 */
export function buildBranchPrompt(input: {
	conversationText: string;
	/** 自定义指令（掩码后传入）；replaceInstructions 时整体替换默认指令。 */
	customInstructions?: string;
	replaceInstructions?: boolean;
}): string {
	let instructions: string;
	if (input.replaceInstructions && input.customInstructions) {
		instructions = input.customInstructions;
	} else if (input.customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${input.customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	return `<conversation>\n${input.conversationText}\n</conversation>\n\n${instructions}`;
}
