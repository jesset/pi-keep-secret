# pi-keep-secret

pi 会话的透明出站密钥掩码扩展（LiteLLM `secret-mask` guardrail 移植）：出站请求里的凭据被替换为格式保持的确定性伪值，回程响应再还原，本地 transcript 与工具执行始终拿真值。规格见 GitHub issue jesset/pi-keep-secret#1。

## 脚手架决策（T0，issue #2）

- **包管理器/运行时：bun**（1.4.x）。**测试框架：`bun test`**。理由：TypeScript 原生执行、免编译步骤，与 pi 包（TS ESM）直接互操作；本仓库不引入构建管线。
- **devDependencies**：
  - `@earendil-works/pi-coding-agent@1.4.0` — pi SDK（`createAgentSession`、`DefaultResourceLoader`、扩展 API 类型等）。
  - `@earendil-works/pi-ai@1.4.0`、`@earendil-works/pi-agent-core@1.4.0` — harness 直接引用其类型（`Message`、`JsonObject` 等）与 faux 供应商工具，显式声明为直接依赖以避免传递依赖漂移。
- **命令**：`bun test`（测试）、`bunx tsc --noEmit`（类型检查）。版本与全局安装的 pi 1.4.0 一致。

## 测试接缝 1：进程内会话 + 脚本化假供应商 harness

代码：`src/harness/fake-session.ts`；冒烟测试：`test/smoke.test.ts`。

```ts
import { createHarnessSession, requestText } from "./src/harness/fake-session.ts";

const h = await createHarnessSession({
  extensionFactories: [myMaskingExtension], // 内联扩展（冒烟用）
  extensionPaths: ["./extension/index.ts"], // 或扩展文件/目录路径
  customTools: [myRecordingTool],           // 自定义工具（内置 read/bash/edit/write 默认禁用）
});
try {
  h.provider.setScript([
    { text: "回复文本" },                                     // 一次模型请求消耗一条
    { toolCall: { name: "my_tool", arguments: { k: "v" } } }, // 工具调用回合
  ]);
  await h.session.prompt("包含密钥的提示词");

  // 供应商视角：context 钩子之后、发给「供应商」的全部消息
  for (const request of h.provider.requests()) {
    expect(requestText(request)).not.toContain(REAL_SECRET);
  }
  // 本地 transcript 与工具执行拿真值
  expect(h.session.getLastAssistantText()).toContain(REAL_SECRET);
} finally {
  h.dispose(); // 关闭会话并清理临时目录
}
```

harness 特性：

- 会话运行在临时目录（cwd/agentDir）、内存 settings、内存 session 中，不触网、不落盘；`settings` 选项可注入内存 settings 初始值（如调低 `compaction.keepRecentTokens` 驱动手动/阈值压缩用例）。
- 假供应商记录的 `messages` 即「供应商视角」：`context_with_system` 钩子与 `convertToLlm` 之后的消息（LLM 格式）。
- 脚本化响应按请求顺序逐次消耗；`{ error }` 变体返回 stopReason=error 应答（故障回退用例）；脚本耗尽后再被请求会得到错误消息（`No more faux responses queued`），欠脚本的测试显式失败。

### 主路径与回退决策

- **主路径（已采用，已验证）**：SDK `createAgentSession` + `ModelRuntime.registerNativeProvider(faux.provider)`。pi-ai 自带测试用 [faux 供应商](node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts)：其 stream 函数就是注入的假 streamFn，出站请求走完整 pi 管线（扩展钩子、convertToLlm、认证解析）后由它应答。脚本化响应用 `fauxAssistantMessage`/`fauxToolCall` 构造（含 text/thinking/toolCall 块与流式事件）。
- **决策理由**：无需替换 `Agent.streamFunction` 字段或绕过 pi 内部管线，注入点最贴近真实供应商路径（ModelRuntime 分发、请求选项、缓存预热全走真实代码）；5 个冒烟测试全绿，覆盖出站断言、message_end 文本还原、toolCall 参数还原、跨轮重掩码、扩展文件加载。
- **回退方案（未实现）**：触发条件是「SDK 进程内注入受限」。本次未触发，故未实现。若未来受限：`pi -p --extension <dir>` 子进程 + 扩展内 `pi.registerProvider` 指向本地假 HTTP 供应商（pi 包 `examples/extensions/custom-provider-gitlab-duo/` 有完整模式），断言口径不变、速度更慢。

### T0 事实发现（后续 ticket 注意）

- `context_with_system` 钩子处 user content 已规范化为 text 块数组（非 string），正式掩码实现两种形态都要处理。
- `message_end` 返回替换消息在 transcript 落盘与工具执行之前生效；工具结果（含回显真值）会进入下一轮出站请求，出站掩码必须覆盖 toolResult 文本。
- 助手历史（含还原后的 toolCall 参数）每轮出站重新掩码后，供应商视角始终只见伪值（伪值确定性）。

## 出站掩码扩展（T2，issue #4）

代码：`src/masking/`（registry/walk/detectors/extension）+ 扩展入口 `extension/index.ts`；验收用例：`test/egress-masking.test.ts`（接缝 1）。

```ts
// 目录扩展入口（内置默认检测器集，pi --extension ./extension 或用户级安装）
// 等价的参数化工厂（测试/定制用）：
import { createEgressMaskingExtension, createPlaceholderRegistry } from "./src/masking/index.ts";

const factory = createEgressMaskingExtension({
  detectors: [{ name: "openai-key", pattern: "sk-(?!ant-)[A-Za-z0-9_-]{20,}", template: "sk-{hash}" }],
  registryLimit: 5000, // 默认
  hashLength: 12,      // 默认
});
```

- 管线：`detectRegexSpans`（T1）→ 注册表层幂等过滤（命中文本已是伪值则跳过，防嵌套 mask）→ `redactText` 注入注册表签发器（确定性伪值 + 碰撞 x 后缀兜底 + LRU 写入）。
- 遍历（笔记 §2）：user（string/text 块）、toolResult text 块、assistant 的 text/thinking/toolCall.arguments 深遍历、system 的 prose 与 sections 字符串值；豁免 ImageContent.data、*Signature、id/name/role/type、toolsAdded/toolsRemoved、nestedCalls、argumentsError、toolResult.details。
- 内置默认检测器：openai-key（`sk-`，排除 `sk-ant-`）、github-pat（`ghp_`）、aws-access-key-id（`AKIA`+16）、google-api-key（`AIza`+35）、slack-bot-token（`xoxb-`）；PEM/JWT 留待 T4 配置化与 T5 judge。
- 伪值注册表（`createPlaceholderRegistry`，会话生命周期闭包状态，供 T3/T5 共用）：`issue(secret, template)`（幂等，写入刷新 LRU，碰撞 x 后缀）、`has`/`get`（幂等过滤/还原查值）、`snapshot()`（T3 还原 tokens 副本）、`size`/`clear`。

### T2 事实发现（后续 ticket 注意）

- `before_agent_start` 返回的 `systemPrompt` 强制覆盖在 context 钩子**之后**由 pi 的 `_installAgentForcedPromptProjection` 投影为请求头部，**绕过 `context_with_system` 掩码**——扩展自身不强制 prompt 不受影响；若未来某扩展把密钥写进强制 prompt 则是泄漏路径（规格外的已知限制）。
- AGENTS.md 等项目指令进入 system 消息 `sections.project_context`，在 `context_with_system` 可见且已被掩码覆盖（验收用例锚定）。
- 默认 hashLength=12 时伪值 `sk-`+12 位不命中 `sk-` 检测器（{20,}），但配置长哈希后伪值可自匹配——幂等过滤为此必需（用例已锚定）。

## 回程还原（T3，issue #5）

代码：`src/ingress/`（restore/extension）+ 扩展入口组合接线；验收用例：`test/ingress-restoration.test.ts`（接缝 1）。

- `message_end` 钩子：assistant 消息的 text/thinking/toolCall.arguments（深遍历字符串值）伪值→真值，返回替换消息（同 role）；在 transcript 落盘与工具执行之前生效。
- `tool_call` 钩子：`event.input` 原位还原（深遍历字符串值），防 message_end 之外路径的第二道兑底；突变校验确认钧子敏感性。
- 还原 tokens 来自与出站掩码共用的注册表实例 `snapshot()`（合并视图）；截断前缀兑底（max_tokens 半个伪值）在引擎 `unmaskText`。
- 幂等：注册表为空或消息无伪值时零改动（不返回替换消息）。

```ts
// 组合接线（extension/index.ts）：出站掩码与回程还原共用同一注册表实例
import { createIngressRestorationExtension } from "./src/ingress/index.ts";
import { createEgressMaskingExtension, createPlaceholderRegistry } from "./src/masking/index.ts";

const registry = createPlaceholderRegistry();
const compose = (pi: ExtensionAPI): void => {
	createEgressMaskingExtension({ registry })(pi);
	createIngressRestorationExtension({ registry })(pi);
};
```

### T3 事实发现（后续 ticket 注意）

- `message_end` 原位改写与返回副本等价：pi 的 `_replaceMessageInPlace` 对 target===replacement 直接返回，且注释明确 bless 原位改写以保持 agent 状态/事件监听/SessionManager 落盘同步。
- 工具执行参数与 transcript 的 toolCall.arguments 是同一对象（`validateToolArguments` 原位 coercion）：tool_call 钩子的原位还原会同时体现于两者。
- 扩展加载顺序：`extensionPaths` 先于 `extensionFactories`（inline）注册，同一事件的处理器按此顺序链式传递（message_end 的替换消息会传给后续处理器）。
- faux 供应商会别掉助手文本的行首空格（测试脚本避免行首空格这种无关变量）。

## 掩码压缩（T6，issue #8）

代码：`src/compaction/`（extension/prompts）；验收用例：`test/compaction.test.ts`（接缝 1）。

- `session_before_compact` 处理器返回完整 `CompactionResult`，整体替换 pi 自带压缩（manual `/compact`、阈值、overflow 三路径都走此钩子）：preparation 的 messagesToSummarize + turnPrefixMessages → `convertToLlm`（含 branchSummary/compactionSummary 投影）→ 与出站同一掩码管线掩码文本叶 → `serializeConversation` 入摘要提示词 → `ctx.modelRegistry.complete`（当前会话模型）摘要 → 摘要文本按注册表还原 → `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage } }`。
- 摘要提示词对齐 pi 默认（pi 1.4.0 未公开导出提示词常量，按原文复制于 `src/compaction/prompts.ts`，升级时需同步校对）；previousSummary / customInstructions 掩码后入摘要上下文，结果还原。
- `session_before_tree` 同模式返回 `{ summary: { summary: 还原后文本, usage } }`（entriesToSummarize 经 `prepareBranchEntries` 投影）。
- 故障策略（ticket 锁定）：摘要调用不可恢复错误（error/length/工具调用/空文本/抛错）→ 返回 undefined 显式回退 pi 默认压缩 + `ctx.ui.notify` 告警 + 状态栏标记 + `MaskedCompactionStatus` 计数（无 UI 模式仅计数）；绝不能静默回退——默认压缩不掩码，摘要模型会看到真值。用户中止（abort）不算回退，返回 `{ cancel: true }`。
- 出站兑底：压缩/分支摘要消息（`compactionSummary`/`branchSummary` 自定义 AgentMessage，携带还原真值）的 `summary` 字段由遍历器掩码（T6 起进入出站覆盖）。

```ts
// 组合接线（extension/index.ts）：出站掩码、回程还原、掩码压缩共享同一管线
import { createMaskedCompactionExtension } from "./src/compaction/index.ts";
import { createIngressRestorationExtension } from "./src/ingress/index.ts";
import { createEgressMaskingExtension, createMaskingPipeline } from "./src/masking/index.ts";

const pipeline = createMaskingPipeline();
const compose = (pi: ExtensionAPI): void => {
	createEgressMaskingExtension({ pipeline })(pi);
	createIngressRestorationExtension({ registry: pipeline.registry })(pi);
	createMaskedCompactionExtension({ pipeline })(pi);
};
```

### T6 事实发现（后续 ticket 注意）

- 扩展侧 `ctx.modelRegistry` 是同步兼容门面（`ModelRegistry`）：有 `complete`/`streamSimple`，**无** `completeSimple`（那是 `ModelRuntime` 的方法）；掩码摘要走 `ctx.modelRegistry.complete`（请求时认证）。
- pi 默认压缩自带重试（`retryAssistantCall`）；掩码压缩的单次 `complete` 无重试，瞬时故障即回退（回退可见性弥补）。若需对齐重试语义，后续可在 `requestSummary` 外套重试。
- 压缩后 `firstKeptEntryId` 之前的历史由 compaction 条目替换，投影生成 `compactionSummary` 角色消息（`summary` 字段携带真值），`convertToLlm` 展开为 user 文本——若遍历器不覆盖该角色，压缩后每一轮出站都会泄漏真值（T6 已补，用例锚定）。
- `SettingsManager.inMemory(partial)` 可注入 `compaction.keepRecentTokens`/`reserveTokens`，harness 以此驱动手动/阈值压缩；keepRecentTokens 必须小于会话尾部 token 量，否则 `prepareCompaction` 返回 undefined（"Nothing to compact"）。
- `bashExecution`/`custom` 自定义消息（`!命令` 等）尚未在出站遍历器覆盖（T2 既有缺口，与压缩无关；待后续 ticket 处理）。

## System One judge（T5，issue #7）

- 适配器 `createSystemOneJudge`（`src/judge/system-one.ts`）：classify 通道注入（`ClassifyFn`）——扩展层绑 `ctx.modelRegistry.classify`，纯逻辑测试注入进程内假函数。两阶段：gate 单 bool 问（阈值 0.5）低短路 → 候选批量逐个 bool 问（阈值 0.7）；128 问/批拆批全覆盖，仅超 8 批才截断保最长（`truncatedCandidates` 计数，gate 零定位不升级）；超长文本 24000/块、重叠 min(2000, maxChars/4)；全部 classify 调用走会话级共享 FIFO 信号量（默认 8 路，消息级并发安全）。
- fail_closed：`classify` never-rejects，错误在 `stopReason`。gate 故障 → 该块候选全掩且不追加注定失败的候选批；候选批故障 → 该批全掩、其余批判定结论照常采纳；stop 结果缺应答的候选视为未验证一并掩（≠「判定非凭据」丢弃）。真值由共享注册表保留，本地可恢复。
- 出站扩展 `createJudgeEgressExtension`（`src/judge/extension.ts`）：注册 `context_with_system`，必须先于 regex 出站扩展（判定需要原文；regex 层幂等跳过已签发伪值）。命中 span 掩码为 `key-{hash}` 确定性伪值（与出站/回程/压缩同一注册表）。
- classifier 模型解析：配置引用 `{provider, modelId}` → `ctx.modelRegistry.findOfType("classifier", ...)`（T4 JSON 配置合入前由装配方显式传 modelRef；正式组合接线在 T4/T8 落地）。模型缺失 → 显式降级而非静默：notify 一次 + 状态栏标记 + `JudgeStatus` 每请求计数（无 UI 模式仅计数），出站仅 regex 层工作。
- 与 T4 clean cache 协同（接口预留）：`JudgeVerdict.clean`（零命中、零 gate 命中、零 fail_closed 才为 true）；命中/gate 命中/故障文本均不可缓存 clean，T4 合入后在扩展层接缓存查询。

### 假 classifier 方案（三层验证）

1. **适配器纯替身**（`src/judge/system-one.test.ts`）：进程内假 classify 按问题 id 应答，概率脚本锚定真实网关实测校准数字（密码 0.96 / 订单号 0.04 / gate 0.98），同时记录全部调用锚定两阶段形态。
2. **harness 注入点**（`test/judge-egress.test.ts`，接缝 1）：扩展工厂的 `resolveModel`/`classify` 选项挂进程内替身，驱动完整钩子链（judge → regex 串联、降级、fail_closed 全链路）；模型缺失用例走缺省 `findOfType` 路径（harness 注册表无该模型）。
3. **真实网关验证**（`research/systemone-gateway.test.ts`）：默认跳过，三个环境变量齐备才启用（`PI_KEEP_SECRET_JUDGE_BASE_URL`/`_MODEL`/`_API_KEY`；凭据仅环境变量，严禁入库）；直接 POST 线缆级 noul 问题断言校准锚点区间。

## 约定

- Conventional Commits；分支 `ticket/<n>-<slug>`（每张 ticket 在自己的 worktree 基于 `feat/secret-masking`）。合并到 main 需用户明示许可。
- 回复与文档使用简体中文。Issue 跟踪见 `docs/agents/issue-tracker.md`。
