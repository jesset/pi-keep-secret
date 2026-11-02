# pi-keep-secret

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-keep-secret)](https://www.npmjs.com/package/pi-keep-secret)
[![CI](https://github.com/jesset/pi-keep-secret/actions/workflows/ci.yml/badge.svg)](https://github.com/jesset/pi-keep-secret/actions/workflows/ci.yml)

pi 会话的透明出站密钥掩码扩展（LiteLLM `secret-mask` guardrail 移植）：出站请求里的凭据被替换为格式保持的确定性伪值，回程响应再还原，本地 transcript 与工具执行始终拿真值。规格见 GitHub issue jesset/pi-keep-secret#1。

## 脚手架决策（T0，issue #2）

- **包管理器/运行时：bun**（1.4.x）。**测试框架：`bun test`**。理由：TypeScript 原生执行、免编译步骤，与 pi 包（TS ESM）直接互操作；本仓库不引入构建管线。
- **devDependencies**：
  - `@earendil-works/pi-coding-agent@1.4.0` — pi SDK（`createAgentSession`、`DefaultResourceLoader`、扩展 API 类型等）。
  - `@earendil-works/pi-ai@1.4.0`、`@earendil-works/pi-agent-core@1.4.0` — harness 直接引用其类型（`Message`、`JsonObject` 等）与 faux 供应商工具，显式声明为直接依赖以避免传递依赖漂移。
- **命令**：`bun test`（测试）、`bun run typecheck`（类型检查，`tsc --noEmit -p tsconfig.json`，CI 同一命令）。版本与全局安装的 pi 1.4.0 一致。

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
- 遍历（笔记 §2）：user（string/text 块）、toolResult text 块、assistant 的 text/thinking/toolCall.arguments 深遍历、system 的 prose 与 sections 字符串值、bashExecution 的 command/output 与 custom 消息的 content（两者经 pi convertToLlm 投影为 user 文本进模型上下文；custom 的 details 不进上下文不动）；豁免 ImageContent.data、*Signature、id/name/role/type、toolsAdded/toolsRemoved、nestedCalls、argumentsError、toolResult.details。
- 内置默认检测器：openai-key（`sk-`，排除 `sk-ant-`）、github-pat（`ghp_`）、aws-access-key-id（`AKIA`+16）、google-api-key（`AIza`+35）、slack-bot-token（`xoxb-`）；PEM/JWT 已由 T4 补入默认集（见 T4 节）。
- Placeholder registry (`createPlaceholderRegistry`, session-scoped closure state shared by T3/T5): `issue(secret, template)` is idempotent and **first-issuer-wins** (T20, #21) — the first template to issue a secret pins its placeholder form for the session and later `template` arguments are only suggestions (one secret, one form); writes refresh LRU, hash collisions fall back to an "x" suffix, and eviction cleans both the placeholder→secret and secret→placeholder indexes. `has`/`get` (idempotent filtering / restoration lookup), `snapshot()` (T3 restoration token copy), `size`/`clear`.

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

## 检测器 JSON 配置 + clean cache（T4，issue #6）

代码：`src/config/`（loader/extension）+ `src/cache/`（clean-cache）；验收用例：`test/config-cache.test.ts`（接缝 1）、`src/config/loader.test.ts`、`src/cache/clean-cache.test.ts`、`src/masking/detectors.test.ts`（接缝 2）。

### 配置 schema 与路径解析

配置文件是 JSON 对象，未知键（含拼写错误）一律报错，防 typo 静默失效：

```json
{
  "detectors": [
    { "name": "corp-api-key", "pattern": "corp-[A-Za-z0-9]{20,}",
      "redactTemplate": "corp-{hash}" }
  ],
  "detectorsMode": "merge",
  "hashLength": 20,
  "cleanCache": { "limit": 20000, "ttlMs": 86400000 }
}
```

- `detectors`：检测器列表（`name`/`pattern`/`redactTemplate`，模板缺省 `{hash}`；`{hash}` 可多次出现保持形状，如 JWT `"eyJ{hash}.{hash}.{hash}"`）。装配语义由 `detectorsMode` 决定（见下）；空列表非法（防止意外关掉全部本地检测）。
- `detectorsMode`（T13，#13）：检测器装配策略，`replace`（默认）/`merge`——replace：`detectors` **整体替换**内置默认集（对齐参考实现 secret_detectors 语义，现行为）；merge：内置默认集 + 用户 `detectors` 合并，**同名用户项原位覆盖对应内置项**（可微调 pattern/redactTemplate，如收紧 sk- 的排除规则），非同名项追加在内置之后（内置序保持在前）；`detectors` 未配置时两模式等价纯内置集。非法值 → 整体回退内置默认集 + 错误可见（沿既有全有或全无语义）。模式与生效集均纳入配置指纹：`/keep-secret reload` 热应用（状态面展示模式与生效检测器数）。
- `hashLength`：伪值哈希段长度，整数 1..52（base32(sha256) 长度），缺省 12。
- `cleanCache`：`limit`/`ttlMs` 调参，缺省 20000 / 24h。
- 路径解析优先级：显式参数 > 环境变量 `PI_KEEP_SECRET_CONFIG` > 默认 `~/.pi/agent/extensions/pi-keep-secret/config.json`。
- 文件不存在 → 内置默认集、无错误；任何非法（读失败/JSON 解析/schema/regex 编译）→ `ResolvedConfig.errors` 可见 + **整体回退**内置默认集（全有或全无）。配置错误的 pi 侧可见性：首个请求起经 `ctx.ui.notify(..., "error")` 逐条上报（TUI 可见；print/RPC 无 UI 时错误仍可从 `loader.get().errors` 读出，T7 status 展示）。

### 加载与热重载接口（load/reload/订阅）

```ts
import { createConfigLoader, createConfiguredMaskingExtension } from "./src/config/index.ts";

// 纯 loader：load（创建即加载）/ reload（重读磁盘，内容变更才通知订阅者）
const loader = createConfigLoader({ path?: string });
loader.get();          // ResolvedConfig { path, exists, detectors, detectorsMode, hashLength?, cleanCache?, errors }
loader.reload();       // 重读并返回；指纹变更时同步通知订阅者
loader.subscribe(fn);  // 订阅变更，返回解绑（订阅不回放当前值）

// 配置化组合（正式入口 extension/index.ts 的装配方式；合并 T3/T6 后与回程还原、掩码压缩
// 共享同一管线：const { factory, loader, pipeline } = createConfiguredMaskingExtension(...)
const { factory, loader, pipeline } = createConfiguredMaskingExtension({ configPath?, cleanCache?, registry? });
```

- 热重载语义：`reload()` 后检测器集变更**即时生效**（重编译 + 清空 clean cache——检测器集变更后旧的干净判定不再可信，验收用例锚定防泄漏）；`hashLength`/`cleanCache` 变更仅新会话生效（伪值注册表与缓存参数在工厂创建时定格）。T7 的 `/keep-secret reload` 直接调 `loader.reload()`。
- 配置解析出的 `detectors` 即引擎 `RegexDetectorSpec[]`（`redactTemplate` 映射为 `template`），可直接喂 `createEgressMaskingExtension`。

### clean cache

- `createCleanCache({ limit=20000, ttlMs=24h, now })`：sha256(文本) → 过期时刻，写时刷新 LRU 位序、命中不续期（对齐参考实现 OrderedDict 语义）；`isClean`/`remember({ hasSecret })`/`stats()/clear()`。
- 挂接在掩码管线检测入口（`createMaskingPipeline` 的 maskText，出站钩子与掩码压缩共用）：`isClean` 未命中才执行检测，干净结论入缓存——第二轮请求同历史消息不再重复检测（每轮成本 O(新增消息)），含 secret 的文本永不缓存、每轮重扫；`stats().misses` 即实际检测次数（验收「检测计数」断言口径，`hits` 为缓存短路次数）。热应用入口 `pipeline.applyDetectors(specs)`（重编译 + 清空缓存）。
- `ScanOutcome.hasSecret` 是语义位预留：T5 judge gate 命中同样置 true（不缓存、每轮重扫）。

### 内置默认检测器集（T4 补全）

- 新增 `pem-private-key`（多行 `-----BEGIN [A-Z]+ )?PRIVATE KEY-----` 块，含 RSA/EC/DSA/OPENSSH/ENCRYPTED 变体，伪值仍是合法形状的 PEM 块）与 `jwt`（`eyJ` 三段 base64url，每段 ≥10 字符，两段截断不命中；伪值 `eyJ{hash}.{hash}.{hash}` 三段保持 JWT 形状）。
- 引擎 `makePlaceholder` 改为 `replaceAll("{hash}")`：模板中多个 `{hash}` 均替换为同一哈希段（单段模板行为不变）。

### T4 事实发现（后续 ticket 注意）

- 同会话内 system 消息文本叶跨轮字节稳定（实测锚定）——clean cache 的检测计数断言因此可精确到「第二轮只检测新增文本」（system + 历史 user 各叶全部命中缓存）。
- 正式入口的默认导出从 `createEgressMaskingExtension()` 求值改为传函数本身：环境变量在每次扩展装配时读取（模块缓存不影响按会话指向不同配置文件）。
- `test/egress-masking.test.ts` 钉扎 `PI_KEEP_SECRET_CONFIG` 指向确定不存在的路径，保证默认集用例不受机器上真实 `~/.pi` 配置影响（测试一律不触真实 `~/.pi` 路径）。
- `ctx.ui.notify` 在无 UI 模式（print/RPC）是 no-op：配置错误在无 UI 环境只经 `loader.get().errors` 可见，T7 status 负责展示。
## 掩码压缩（T6，issue #8）

代码：`src/compaction/`（extension/prompts）；验收用例：`test/compaction.test.ts`（接缝 1）。

- `session_before_compact` 处理器返回完整 `CompactionResult`，整体替换 pi 自带压缩（manual `/compact`、阈值、overflow 三路径都走此钩子）：preparation 的 messagesToSummarize + turnPrefixMessages → `convertToLlm`（含 branchSummary/compactionSummary 投影）→ 与出站同一掩码管线掩码文本叶 → `serializeConversation` 入摘要提示词 → `ctx.modelRegistry.complete`（当前会话模型）摘要 → 摘要文本按注册表还原 → `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage } }`。
- 摘要提示词对齐 pi 默认（pi 1.4.0 未公开导出提示词常量，按原文复制于 `src/compaction/prompts.ts`，升级时需同步校对）；previousSummary / customInstructions 掩码后入摘要上下文，结果还原。
- `session_before_tree` 同模式返回 `{ summary: { summary: 还原后文本, usage } }`（entriesToSummarize 经 `prepareBranchEntries` 投影）。
- 故障策略（spec 故事 24：零泄漏）：摘要调用带重试（2 次重试、短退避；用户中止不重试不算失败）；重试仍失败 → 返回 `{ cancel: true }` 取消本次压缩（会话继续不压缩）+ `ctx.ui.notify` 告警与重试建议 + 状态栏标记 + `MaskedCompactionStatus` 计数（无 UI 模式仅计数）。**不存在「回退 pi 默认压缩」路径**——默认压缩不掩码，回退即泄漏。
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
- pi 默认压缩自带重试（`retryAssistantCall`）；掩码压缩的摘要调用同样带重试（2 次重试、短退避），瞬时故障被吸收；重试仍失败则取消本次压缩（会话继续不压缩），绝不回退不掩码的默认压缩。
- 压缩后 `firstKeptEntryId` 之前的历史由 compaction 条目替换，投影生成 `compactionSummary` 角色消息（`summary` 字段携带真值），`convertToLlm` 展开为 user 文本——若遍历器不覆盖该角色，压缩后每一轮出站都会泄漏真值（T6 已补，用例锚定）。
- `SettingsManager.inMemory(partial)` 可注入 `compaction.keepRecentTokens`/`reserveTokens`，harness 以此驱动手动/阈值压缩；keepRecentTokens 必须小于会话尾部 token 量，否则 `prepareCompaction` 返回 undefined（"Nothing to compact"）。
- `bashExecution`/`custom` 自定义消息（`!命令`、sendMessage 注入）经 pi `convertToLlm` 投影为 user 文本进 LLM 上下文（`bashExecutionToText` 含 command+output；custom 的 content 直投影）——已在出站遍历器覆盖（T2 补齐，用例锚定；`!!` 前缀的 excludeFromContext 消息不投影，掩码对其无副作用）。

## 入站预检通知 + /keep-secret 命令面（T7，issue #9）

代码：`src/commands/`（extension）；验收用例：`test/commands.test.ts`（接缝 1 + 命令 handler 直测）。

### input 预检

- `pi.on("input")` 对提交文本按**内置默认 regex 集**快扫（与配置无关的固定提示层：掩码执法始终以当前配置检测器集为准），命中即 `ctx.ui.notify(..., "warning")` 列出检测器名；返回 `undefined`（不改写、不阻断）。无 UI（print/json）模式 notify 为 no-op，静默。

### /keep-secret 命令面（三子命令）

- `/keep-secret`（状态）：检测器配置摘要（来源/模式（replace|merge，T13）/条数/名列表，含非法配置的错误行与回退标记）、伪值注册表条数、clean cache 条数与命中率（命中 x / 检测 y）、各检测器命中计数（`name=N`）、judge 计数（T8 已接入：配置 judge 段后展示已判定/截断/fail-closed/降级计数与生效的模型缺失策略，未配置显示「未接入」；T16 起模型解析后附线缆段：跟随注册 / 覆盖 systemone|decisions / 插件自定义名（judge.api 偏好未生效标记））、掩码压缩取消计数与最近原因。
- `/keep-secret test`：合成样本（sk- 假 key、URL 藏 key、假密码、干净订单号）逐项过会话链路（T8 起 judge 启用时经 judge→regex 全链评估，与出站链同序），报告已掩码/未掩码与期望比对；与期望一致为通过，全部通过 info、有未通过 warning。假密码项期望随 judge 是否启用动态化：启用→期望掩码（regex_only 降级时如实报未通过——降级可见信号）；未启用→期望未掩码（regex 层不命中属预期）。当前配置未覆盖某样本时如实报告未通过。模型缺失 + fail_closed（默认）生效时全部样本期望掩码（未验证候选一律兑底掩码，含干净订单号）并附说明行。
- `/keep-secret reload`：调 `loader.reload()`（变更时同步热应用：applyDetectors + 清空缓存）；变更判定与 loader 同口径（`configFingerprint`），结果经 notify 报告（检测器集变更→已热应用 / 检测器集未变但其他段变更（judge/hashLength/cleanCache）→ 已重读且仅新会话生效 / 无变更 / 配置错误回退）。
- 未知子命令 → 用法提示。

### 三模式安全降级

输出一律经 `ctx.ui.notify`（TUI 直接可见；RPC 经 extension_ui_request 转发，fire-and-forget 不阻塞；print/json 为 no-op 静默，命令动作照常执行），无任何交互原语（select/confirm/custom）。命令 handler 只依赖 `(args, ctx)` 签名，可直接测试。

### 数据来源与最小增量

- 状态面统一走各模块既有接口：`loader.get()`（配置摘要）、`pipeline.registry.size`、`MaskedCompactionStatus`（组合根 `extension/index.ts` 持有并传给压缩扩展与命令面）。
- 管线最小增量：`pipeline.detectorHitCounts()`（合并后 span 按检测器名累计；缓存短路不计；applyDetectors 清零）与 `pipeline.cacheStats()`（misses = 实际检测次数）。检测器命中计数在注册表幂等过滤**之前**累计（含每轮重扫的含 secret 文本，随会话事件递增）。

### T7 事实发现（后续 ticket 注意）

- pi 的 `prompt()` 对 `/` 开头文本**先**尝试扩展命令分发（`_tryExecuteExtensionCommand`），命中即返回——input 钩子不会看到 `/keep-secret` 自身；接缝 1 验证命令注册需预置假供应商脚本（未识别的命令会作为 prompt 发给模型并记录请求，requests().length 即信号；**无脚本时 faux 在记录前就报错，零请求不能证明命令被执行**）。
- harness（SDK 会话）的 `ctx.ui` 是 `noOpUIContext`（mode "print"）：notify 不可观察，命令面断言用 stub pi 提取注册的 handler + 注入记录型 ctx.ui 直调（与 pi 同一调用面，ticket 认可的「命令 handler 直测」）。
- T5 接入点（已在 T8 落地）：`createKeepSecretCommandsExtension({ judge })` 传组合根的 `JudgeTextMasker`（同一实例/状态）即点亮状态面 judge 行；自测假密码项期望随 judge 启用变为掩码。

## System One judge（T5，issue #7）

- 适配器 `createSystemOneJudge`（`src/judge/system-one.ts`）：classify 通道注入（`ClassifyFn`）——扩展层绑 `ctx.modelRegistry.classify`，纯逻辑测试注入进程内假函数。两阶段：gate 单 bool 问（阈值 0.5）低短路 → 候选批量逐个 bool 问（阈值 0.7）；128 问/批拆批全覆盖，仅超 8 批才截断保最长——丢弃的候选按未验证一律掩码（未验证定义上不该出站）+ `truncatedCandidates` 计数；超长文本 24000/块、重叠 min(2000, maxChars/4)；全部 classify 调用走会话级共享 FIFO 信号量（默认 8 路，消息级并发安全）。
- fail_closed：`classify` never-rejects，错误在 `stopReason`。gate 故障 → 该块候选全掩且不追加注定失败的候选批；候选批故障 → 该批全掩、其余批判定结论照常采纳；stop 结果缺应答的候选视为未验证一并掩（≠「判定非凭据」丢弃）。真值由共享注册表保留，本地可恢复。
- 出站扩展 `createJudgeEgressExtension`（`src/judge/extension.ts`）：注册 `context_with_system`，必须先于 regex 出站扩展（判定需要原文；regex 层幂等跳过已签发伪值）。Hit spans are masked through the same registry as every other path: `redactTemplate` (default `key-{hash}`) shapes the placeholder only when this judge is the first issuer for that secret — a regex detector that issued the same secret earlier keeps its form, and vice versa (first-issuer-wins, T20 #21; see Behavioral notes).
- classifier 模型解析：配置引用 `{provider, modelId}`（T8 起由 config.json 的 judge 段驱动正式组合接线）→ `ctx.modelRegistry.findOfType("classifier", ...)`。模型缺失（含解析通道异常）→ 按 `judge.onMissing` 策略处理（spec 故事 19「down judge never means an unmasked request」）：**fail_closed（默认）**——与 classify 故障同路径，该消息未验证候选（engine 抽取）一律掩码（真值注册表本地保留）+ failClosed 计数 + notify/状态栏；**regex_only（显式知情选择）**——降级放行仅 regex 层 + `degradedTexts` 按文本叶计数（无 UI 模式仅计数）。两策略的降级叶都记 clean cache 墓碑（T8：防 judge 恢复后被缓存短路漏判，见 T8 节）。
- 与 T4 clean cache 协同（已实现）：judge 层 gate 前查询 `pipeline.cleanCache.isClean` 短路（已判干净不再发起 gate）；非 clean 结论（命中/gate 命中/fail_closed）以 `hasSecret=true` 记**墓碑**——同一文本后续的干净结论（后置 regex 层零命中）不得覆写，每轮重判。干净条目仍由 regex 层零命中时写入（clean = 两层都过）；墓碑随 `clear()`（检测器集热更新）失效。

### 假 classifier 方案（三层验证）

1. **适配器纯替身**（`src/judge/system-one.test.ts`）：进程内假 classify 按问题 id 应答，概率脚本锚定真实网关实测校准数字（密码 0.96 / 订单号 0.04 / gate 0.98），同时记录全部调用锚定两阶段形态。
2. **harness 注入点**（`test/judge-egress.test.ts`，接缝 1）：扩展工厂的 `resolveModel`/`classify` 选项挂进程内替身，驱动完整钩子链（judge → regex 串联、降级、fail_closed 全链路）；模型缺失用例走缺省 `findOfType` 路径（harness 注册表无该模型）。
3. **真实网关验证**（`research/systemone-gateway.test.ts`）：默认跳过，三个环境变量齐备才启用（`PI_KEEP_SECRET_JUDGE_BASE_URL`/`_MODEL`/`_API_KEY`；凭据仅环境变量，严禁入库；可选第四变量 `PI_KEEP_SECRET_JUDGE_API=decisions` 切 OpenAI Decisions 线缆，缺省 systemone——T14）；直接 POST 线缆级问题（noul / predicate）断言校准锚点区间。

## 安装（用户级扩展目录）

npm 包安装（首选，发布后可用；CI 见 [ci.yml](.github/workflows/ci.yml)，发布流水线 [publish.yml](.github/workflows/publish.yml)——GitHub Release `v*` 触发、npm OIDC trusted publishing 免令牌发布）：

```bash
pi install npm:pi-keep-secret
```

手动拷贝（未发布/离线环境的替代方式，效果等同）——用户级安装覆盖当前用户全部 pi 会话（含子代理子进程——子会话在自己的进程里加载同一用户级扩展目录，规格 #1 用户故事 32）。

```bash
# 1) 建安装目录（用户级扩展目录的固定命名位）
mkdir -p ~/.pi/agent/extensions/pi-keep-secret

# 2) 拷贝安装清单（仓库根）：
#    package.json（pi.extensions 清单，目录扩展发现入口）
#    extension/（index.ts 组合入口）
#    src/（引擎与各模块，extension/index.ts 的相对导入目标）
#    LICENSE、README.md（可选，随附文档）
cp -R package.json extension src LICENSE README.md ~/.pi/agent/extensions/pi-keep-secret/

# 3) （可选）放配置文件——文件缺失时用内置默认检测器集（仅 regex 层）
#    按下节「配置」自写 config.json 放入同一目录
```

- 不需要 `node_modules`/安装步骤：运行时仅依赖 pi 内建模块别名（`@earendil-works/*` 由 pi 的 jiti 别名解析到 pi 自身），纯 TypeScript 直读。
- 不装 `test/`、`research/`、`docs/`、`tsconfig.json`（测试与开发资产）。
- 已验证（T8 冒烟）：临时 agent 目录（`PI_CODING_AGENT_DIR`）下该布局被自动发现，`/keep-secret` 命令分发成功、扩展加载无错。

试用（不安装，单次会话）：

```bash
pi --extension /path/to/pi-keep-secret "…"        # 目录（经 package.json pi 清单发现）
pi --extension /path/to/pi-keep-secret/extension/index.ts "…"  # 或直接指入口文件
```

项目级安装（仅当前项目）：把同样的目录内容放到 `<项目>/.pi/extensions/pi-keep-secret/`。

### 卸载

删除安装目录即完全卸载（本扩展无其他落盘状态：伪值注册表与 clean cache 均进程内、随会话消亡；会话 transcript 本就保留真值，不受影响）：

```bash
rm -rf ~/.pi/agent/extensions/pi-keep-secret
```

试用形态无需卸载；项目级安装删 `<项目>/.pi/extensions/pi-keep-secret/`。

## 配置

配置文件路径解析优先级：显式参数（测试用）> 环境变量 `PI_KEEP_SECRET_CONFIG` > `~/.pi/agent/extensions/pi-keep-secret/config.json`。文件不存在 → 内置默认检测器集（仅 regex 层）；任何非法 → 整体回退默认集 + 错误可见（TUI notify + `/keep-secret` 状态面；见 T4 节）。

```json
{
  "detectors": [
    { "name": "corp-api-key", "pattern": "corp-[A-Za-z0-9]{20,}", "redactTemplate": "corp-{hash}" }
  ],
  "detectorsMode": "merge",
  "hashLength": 12,
  "cleanCache": { "limit": 20000, "ttlMs": 86400000 },
  "judge": {
    "provider": "litellm",
    "modelId": "typesafe/jev-latest",
    "api": "systemone",
    "gateThreshold": 0.5,
    "candidateThreshold": 0.7,
    "redactTemplate": "key-{hash}"
  }
}
```

- `detectors`：装配语义由 `detectorsMode`（T13）决定——`replace`（默认）整体替换内置默认集（openai-key/github-pat/aws-access-key-id/google-api-key/slack-bot-token/pem-private-key/jwt）；`merge` 内置集与用户项合并（同名用户项原位覆盖内置，非同名追加在内置之后）；空列表非法。
- `detectorsMode`：`replace` | `merge`（默认 replace，现行为不变）；非法值整体回退默认集 + 错误可见；生效集含模式变更可经 `/keep-secret reload` 热应用（状态面展示模式与生效检测器数）。
- `judge`（T8/T14/T16）：System One 判定检测器。`provider`/`modelId` 必填——指向一个 **classifier 类型**的模型（models.json 注册或扩展 `pi.registerProvider`；端点须兼容 System One 协议，如 LiteLLM 网关 `/v1/systemone` 或 `/v1/decisions`，插件自定义 api 亦可——线缆由该实现决定）。`api`（可选**线缆偏好**：`systemone` / `decisions`，非法值 judge 段整体回退；缺省跟随模型注册条目的 `api` 字段；填写后三分支应用（T16）：模型注册为 pi-ai 内置 classifier api → 覆盖分发线缆（classify 收到仅改 api 字段的浅拷贝模型）；插件自定义 api（如 `litellm-decisions`）→ 尊重插件实现、正常装配，偏好未生效（一次性 info 通知 + 状态面标记）。不存在「不一致 → 不装配」的硬校验，见 T14/T16 节）。阈值（`gateThreshold` 默认 0.5 / `candidateThreshold` 默认 0.7）、批参（`batchSize` 128 / `maxBatches` 8 / `maxChars` 24000 / `minCandidateLength` 6）、`concurrency`（8）、`redactTemplate`（`key-{hash}`）、`onMissing`（模型缺失策略：`fail_closed` 默认 / `regex_only` 显式知情降级，见 T5/T8 节）可调；未知键报错。未配置该段即不接入 judge（仅 regex 层）。
- judge 段变更与 `hashLength`/`cleanCache` 同语义：仅新会话生效（会话内装配在工厂创建时定格）；`detectors` 变更可经 `/keep-secret reload` 热应用。

## Behavioral notes (T20, #21)

Findings from live behavioral testing (7 outbound requests, zero plaintext leaks), documented so the reasoning and the accepted trade-offs stay visible.

1. **Placeholder form unification.** One secret always leaves the session in exactly one placeholder form. The registry keeps a secret→placeholder reverse index and reuses the first-issued form wherever the same secret reappears, so a judge-hit leaf and a regex-hit leaf of the same request can no longer produce `key-<hash>` and `sk-<hash>` side by side (observed pre-T20: the model compared both forms in one request and reconciled them by its own reasoning — a "same key seen as two values" split-brain risk). The first issuer pins the form for the session; a fail-closed turn can therefore pin the judge template for a secret a regex detector would have shaped differently; after an LRU eviction, re-issuance deterministically follows the current suggestion. **This is a deliberate divergence from the LiteLLM reference implementation**, which keeps per-detector template heterogeneity (the same secret may take a different shape per detector); unification trades detector-template fidelity for model-side coherence — an intentional improvement. Known costs, accepted by the user: reduced detector template fidelity (executing tools always receive the restored real value anyway) and the first-issuer form freeze.
2. **Model awareness.** The model may notice the masking layer and comment on it; this carries no leak risk — the provider only ever sees placeholders. Awareness triggers observed in testing: placeholder salience; cross-leaf form inconsistency (eliminated by item 1); other security layers in the ecosystem intercepting messages (e.g. pi-verdict — outside this project's scope).
3. **Restoration illusion.** The model only ever sees placeholders. When the terminal shows the assistant "quoting the real key", that text is the ingress restoration layer's product — transparency by design: the local transcript and tool execution always hold real values.
4. **Ecosystem layering.** Tool-approval style extensions operate on the restored (real-value) layer, which is the correct complementary position. Configuration guidance: if model attention to placeholders matters in your environment, configure `judge.redactTemplate` (and detector `redactTemplate`s) close to the real key shapes of your environment.

## 已知限制汇总（0.1.0）

各票实现过程中的发现与接受的取舍，集中列出：

1. **流式期间短暂显示伪值**：`message_update` 为纯通知（不可改写），TUI 流式渲染期间助手输出短暂显示伪值，消息完成（`message_end` 还原）后转为真值（规格 #1 用户故事 18 已接受；T3）。
2. **judge.onMissing=regex_only 降级期间 regex 不可见的 secret 会出站**：classifier 模型缺失/不可解析时默认 fail_closed（未验证候选一律掩码，零泄漏）；显式配置 `onMissing: "regex_only"` 才会降级仅 regex 层（可见：notify 一次 + 状态栏 + `/keep-secret` 降级计数 + 自测假密码项未通过）——低熵密码等 regex 不可见的 secret 在该模式下会出站，属知情取舍（T5/T8）。
3. **judge 供应商需可信**：judge 判定会把消息文本发给判定模型（System One 端点）；该供应商必须与主会话供应商同级别的可信边界（规格 #1；T5）。
4. **transcript 本地保留真值**：会话文件按设计保留真值（本地磁盘保护是独立关注点，规格外）；仅出站请求恒伪值（T2 起，各票锚定）。
5. **`before_agent_start` 强制 systemPrompt 绕过掩码**：pi 在 context 钩子之后投影强制 systemPrompt，不经 `context_with_system` 掩码；本扩展自身不强制 prompt 不受影响，但其他扩展若把密钥写进强制 prompt 则是泄漏路径（T2 发现，规格外）。
6. **input 预检固定内置默认集**：提交提示的非阻塞警告按内置默认 regex 集快扫（与配置无关的固定提示层；掩码执法始终以当前配置为准）（T7）。
7. **掩码压缩失败时本次不压缩**：摘要调用带重试（2 次重试、短退避）；重试仍失败 → 取消本次压缩并告警（会话继续不压缩、上下文持续增长，用户可稍后重试 `/compact`）。这是零泄漏的取舍——不存在回退 pi 默认压缩的路径（默认路径不掩码，回退即泄漏）（T6，spec 故事 24）。
8. **judge 截断护栏**：候选超 `batchSize × maxBatches` 截断保最长，丢弃的候选按未验证一律掩码（零未验证出站；截断计数入 `/keep-secret` 状态）——代价是病态大块下掩码偏保守（短低熵串可能被一并掩为伪值）（T5，故事 19）。

## T8：端到端加固 + 文档 + 打包（issue #10）

代码：`extension/index.ts`（`createKeepSecretExtension` 组合装配 + 默认导出）、`src/config/loader.ts`（judge 段）、`src/config/extension.ts`（judge 接线）、`src/judge/extension.ts`（`createJudgeTextMasker`）、`src/commands/extension.ts`（judge 计数与自测动态期望）；验收用例：`test/e2e-convergence.test.ts`（接缝 1）、`test/helpers.ts`（假 classifier 共享替身）。

### 正式组合接线（judge 接入）

- **装配**：`createConfiguredMaskingExtension` 读取 config.json 的 `judge` 段（provider/modelId/阈值/批参/并发/模板）创建 `JudgeTextMasker`，出站工厂按「judge 先于 regex」顺序注册（judge 判定需要原文；regex 层对已签发伪值幂等跳过，两层串联安全）；`extension/index.ts` 的 `createKeepSecretExtension` 把同一掩码器实例交给 `/keep-secret` 命令面（状态计数与自测共用），并与回程还原、掩码压缩共享同一管线（同一注册表 + clean cache）。
- **降级路径**：未配置 judge 段 → 完全不装配 judge 扩展（仅 regex 层，状态面「未接入」）；配置了但 classifier 模型缺失/解析通道异常 → 按 `judge.onMissing` 策略（spec 故事 19）：默认 **fail_closed**——该消息未验证候选（engine 抽取）一律掩码（真值注册表本地保留）+ `failClosed` 计数 + notify/状态栏 + 自测全部样本期望掩码；显式 `regex_only`——降级放行仅 regex 层 + `degradedTexts` 按文本叶计数 + 自测假密码项如实报未通过。两策略的降级叶都在 clean cache 记**墓碑**——regex 层的零命中结论不得把降级处理过的文本写成干净，否则 judge（模型后来注册）恢复后会被 clean cache 短路而漏判（clean = 两层都过的不变量；用例锚定「恢复后重判」）。
- **classify 通道故障与模型缺失同则**：模型在位但 classify 返回错误（judge 不可达）→ fail_closed（未验证候选一律掩码，真值注册表本地可恢复）；两者都计入 `/keep-secret` 状态（failClosed / degradedTexts）与生效策略展示（模型缺失策略：fail_closed|regex_only）。
- **注入点**：`createKeepSecretExtension({ configPath, resolveModel, classify })`——测试替身经 judge 扩展既有注入点进入正式装配；默认导出（目录扩展加载）读 `PI_KEEP_SECRET_CONFIG`。
- **打包**：`package.json` 增加 `"pi": { "extensions": ["extension/index.ts"] }` 清单——pi 对目录扩展先读 package.json 的 pi 清单再找 index.ts，`--extension <repo>` 与用户级目录发现共用该入口；`extension/index.ts` 的 `../src/...` 相对导入在安装布局（清单所在目录为根）下保持成立。

### 端到端收敛用例（接缝 1，正式组合入口）

`test/e2e-convergence.test.ts`：① 多轮对话掩码-还原-再掩码确定性（供应商视角恒同一伪值、本地恒真值、助手回显还原后再掩码）；② judge 故障 fail_closed 全链路（正式入口形态：密码与订单号一并掩码、零未验证出站、每轮重判、状态面 fail-closed 计数）；③ 压缩后对话继续且伪值一致（掩码摘要→还原落盘→保留区/摘要投影重掩码同一伪值）；④ 图片内容字节不变（工具结果图片出站逐字节一致、同消息文本照常掩码）；⑤ 组合接线四态（judge 可用/阈值短路/未配置/降级）。

### 冷启动冒烟（真实 pi 1.4.0 二进制，记录于本票）

- `pi -p --extension <repo> "<无害 prompt>"` → 模型正常应答、无扩展错误；
- `/keep-secret`、`/keep-secret test`、`/keep-secret reload` → 均被分发执行（print 模式零输出、零模型请求、退出 0；对照：故意抛错的扩展会打印 `Error: Failed to load extension …` 并给出 `-ne` 提示）。
- config.json 含 judge 段 + 模型不可用 → 降级路径加载无错、会话正常；
- 非法配置 → 回退默认集加载无错、会话正常；
- 用户级安装布局（`PI_CODING_AGENT_DIR` 临时 agent 目录 + `extensions/pi-keep-secret/{package.json, extension/, src/}`）→ 自动发现并加载成功（命令分发证明）；「No API key found」属模型不可用，不算扩展加载失败（票面口径）。
- 真实模型冒烟（可选验收项，已执行）：`pi -p --extension <repo> --extension <出站探针>`（探针注册在后，看到的是掩码后、发供应商前的消息）提交假 key prompt → 出站只见伪值 `sk-<hash>`、真值零出站、模型正常应答。

## T14：judge 双协议（/v1/systemone 与 /v1/decisions，issue #14）

LiteLLM 网关的 `/v1/systemone` 与 `/v1/decisions` 是同一后端路由的两种线缆协议：前者对应 pi-ai `typesafe-system-one` 传输（POST `<baseUrl>/systemone`，bool 问题映射为线缆级 noul），后者对应 `openai-decisions` 传输（POST `<baseUrl>/decisions`，`{model,input,questions}`、bool→predicate、criteria 折进 instructions、state 作 JSON 文本放 input）。两种协议的 baseUrl 都配 `https://<host>/v1`（线缆路径由传输层拼接）。

- **适配器零改动**：judge 适配器走 `modelRegistry.classify()`，传输协议由模型注册条目的 `api` 字段决定——config.json 的 `judge.api` 键是线缆偏好（T16 语义），不改变请求路径的合法性。
- **两处分工**：loader（`src/config/loader.ts`）校验 `judge.api` 合法值（`systemone`|`decisions`，非法 → judge 段整体回退）；装配处（`src/judge/extension.ts`）在模型解析后应用偏好。T14 原始语义为「与模型注册 api 不一致 → 配置错误不装配」；**T16 已改为线缆偏好三分支**（见下节）——硬校验会误杀插件注册的自定义 api 模型（`modelRegistry.classify` 本身按 model.api 正确分发，名称检查只带来误杀）。
- **网关验证脚本**（`research/systemone-gateway.test.ts`）：默认跳过；三变量齐备启用，可选 `PI_KEEP_SECRET_JUDGE_API=decisions` 切 OpenAI 线缆（缺省 systemone）跑同一组校准区间断言（decisions 协议概率可能与 systemone 略有差异，断言用区间）。

### models.json 双协议注册样例

同一 LiteLLM 网关两个 classifier 条目（按需其一；`judge.provider`/`modelId` 指向其中一条）：

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "litellm": {
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$LITELLM_API_KEY",
      "models": [
        {
          "type": "classifier",
          "id": "typesafe/jev-latest",
          "name": "Jev (System One)",
          "api": "typesafe-system-one",
          "input": ["text"],
          "contextWindow": 128000
        },
        {
          "type": "classifier",
          "id": "openai/gpt-6-luna",
          "name": "GPT-6 Luna (Decisions)",
          "api": "openai-decisions",
          "input": ["text"],
          "contextWindow": 128000
        }
      ]
    }
  }
}
```

### config.json 双协议样例

`api` 为线缆偏好（缺省 `api` 则跟随注册条目；插件自定义 api 模型正常装配，偏好未生效可见）：

```json
{
  "judge": {
    "provider": "litellm",
    "modelId": "openai/gpt-6-luna",
    "api": "decisions",
    "gateThreshold": 0.5,
    "candidateThreshold": 0.7
  }
}
```

代码：`src/config/loader.ts`（judge.api 合法值）、`src/judge/extension.ts`（MODEL_API_BY_JUDGE_API 偏好映射）、`src/config/extension.ts`（透传）、`research/systemone-gateway.test.ts`（双线缆网关实测）；验收用例：`src/config/loader.test.ts`、`test/judge-egress.test.ts`、`test/e2e-convergence.test.ts`（T16 describe）。

## T16：judge.api 线缆偏好（issue #16）

T14 的名称硬校验在插件注册的 classifier 模型上误杀：用户 provider 由 pi-provider-litellm-oidc 插件提供，模型 api 为自定义名 `litellm-decisions`（实现是 System One 线缆，调 `/systemone`），映射表只认 pi-ai 内置名 → 误报不一致 → 拒绝装配 judge。`modelRegistry.classify()` 本身按 model.api 正确分发（内置 api → pi-ai 传输；自定义 api → 插件 ProviderClassifier），扩展无需知道线缆细节；LiteLLM 对 `/v1/systemone` 与 `/v1/decisions` 双向翻译，线缆选择不影响可用性。

- **三分支装配**（彻底移除「不一致 → 不装配」硬校验）：
  1. `judge.api` 未设置 → 跟随模型注册条目的 api（现状默认）；
  2. 设置 + 模型 api 是 pi-ai 已知 classifier api（`typesafe-system-one`/`openai-decisions`）→ 分发覆盖：classify 调用传 `{...model, api: MODEL_API_BY_JUDGE_API[options.api]}`（浅拷贝仅改 api 字段；baseUrl/provider/headers 不变，认证按 provider 解析不受影响）——配置选择线缆生效；
  3. 设置 + 模型 api 是插件自定义名（如 `litellm-decisions`）→ 尊重插件实现（插件作者已选定线缆），正常装配；偏好记为未生效 + 一次性 info 通知（非错误、非降级：不减分、不占状态栏）+ 状态面标记。
- **状态面**（`/keep-secret`）：judge 行在模型解析后附线缆段——跟随注册（<注册 api>）/ 覆盖 systemone|decisions（<生效 api>）/ 插件自定义 <api>（judge.api 偏好 <值> 未生效）；解析前不展示。
- **运行期 classify 异常语义不动**：fail_closed + 可见计数（强于 warn，spec 故事 19）。
- loader 合法值校验保留（`systemone`|`decisions`，非法仍 judge 段整体回退）——键语义改为线缆偏好。

代码：`src/judge/extension.ts`（三分支装配与 `JudgeWire`）、`src/commands/extension.ts`（线缆展示）、`src/config/loader.ts`（注释语义）；验收用例：`test/judge-egress.test.ts`（T16 三分支）、`test/commands.test.ts`（线缆展示）、`test/e2e-convergence.test.ts`（T16 用户现场场景）。

## 约定

- Conventional Commits；分支 `ticket/<n>-<slug>`（每张 ticket 在自己的 worktree 基于 `feat/secret-masking`）。合并到 main 需用户明示许可。
- 回复与文档使用简体中文。Issue 跟踪见 `docs/agents/issue-tracker.md`。
