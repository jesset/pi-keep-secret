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
- 内置默认检测器：openai-key（`sk-`，排除 `sk-ant-`）、github-pat（`ghp_`）、aws-access-key-id（`AKIA`+16）、google-api-key（`AIza`+35）、slack-bot-token（`xoxb-`）；PEM/JWT 已由 T4 补入默认集（见 T4 节）。
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
  "hashLength": 20,
  "cleanCache": { "limit": 20000, "ttlMs": 86400000 }
}
```

- `detectors`：检测器列表（`name`/`pattern`/`redactTemplate`，模板缺省 `{hash}`；`{hash}` 可多次出现保持形状，如 JWT `"eyJ{hash}.{hash}.{hash}"`）。**整体替换**内置默认集（对齐参考实现 secret_detectors 语义）；空列表非法（防止意外关掉全部本地检测）。
- `hashLength`：伪值哈希段长度，整数 1..52（base32(sha256) 长度），缺省 12。
- `cleanCache`：`limit`/`ttlMs` 调参，缺省 20000 / 24h。
- 路径解析优先级：显式参数 > 环境变量 `PI_KEEP_SECRET_CONFIG` > 默认 `~/.pi/agent/extensions/pi-keep-secret/config.json`。
- 文件不存在 → 内置默认集、无错误；任何非法（读失败/JSON 解析/schema/regex 编译）→ `ResolvedConfig.errors` 可见 + **整体回退**内置默认集（全有或全无）。配置错误的 pi 侧可见性：首个请求起经 `ctx.ui.notify(..., "error")` 逐条上报（TUI 可见；print/RPC 无 UI 时错误仍可从 `loader.get().errors` 读出，T7 status 展示）。

### 加载与热重载接口（load/reload/订阅）

```ts
import { createConfigLoader, createConfiguredMaskingExtension } from "./src/config/index.ts";

// 纯 loader：load（创建即加载）/ reload（重读磁盘，内容变更才通知订阅者）
const loader = createConfigLoader({ path?: string });
loader.get();          // ResolvedConfig { path, exists, detectors, hashLength?, cleanCache?, errors }
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

## 入站预检通知 + /keep-secret 命令面（T7，issue #9）

代码：`src/commands/`（extension）；验收用例：`test/commands.test.ts`（接缝 1 + 命令 handler 直测）。

### input 预检

- `pi.on("input")` 对提交文本按**内置默认 regex 集**快扫（与配置无关的固定提示层：掩码执法始终以当前配置检测器集为准），命中即 `ctx.ui.notify(..., "warning")` 列出检测器名；返回 `undefined`（不改写、不阻断）。无 UI（print/json）模式 notify 为 no-op，静默。

### /keep-secret 命令面（三子命令）

- `/keep-secret`（状态）：检测器配置摘要（来源/条数/名列表，含非法配置的错误行与回退标记）、伪值注册表条数、clean cache 条数与命中率（命中 x / 检测 y）、各检测器命中计数（`name=N`）、judge 预留位（未接入/T5 合入后接计数）、掩码压缩回退计数与最近原因。
- `/keep-secret test`：合成样本（sk- 假 key、URL 藏 key、假密码、干净订单号）逐项过**会话管线**，报告已掩码/未掩码与期望比对；与期望一致为通过，全部通过 info、有未通过 warning。期望针对 regex 层：假密码不命中属 judge 职责（T5 合入后改判）；当前配置未覆盖某样本时如实报告未通过。
- `/keep-secret reload`：调 `loader.reload()`（变更时同步热应用：applyDetectors + 清空缓存）；检测结果经 notify 报告（已热应用/无变更/配置错误回退）。
- 未知子命令 → 用法提示。

### 三模式安全降级

输出一律经 `ctx.ui.notify`（TUI 直接可见；RPC 经 extension_ui_request 转发，fire-and-forget 不阻塞；print/json 为 no-op 静默，命令动作照常执行），无任何交互原语（select/confirm/custom）。命令 handler 只依赖 `(args, ctx)` 签名，可直接测试。

### 数据来源与最小增量

- 状态面统一走各模块既有接口：`loader.get()`（配置摘要）、`pipeline.registry.size`、`MaskedCompactionStatus`（组合根 `extension/index.ts` 持有并传给压缩扩展与命令面）。
- 管线最小增量：`pipeline.detectorHitCounts()`（合并后 span 按检测器名累计；缓存短路不计；applyDetectors 清零）与 `pipeline.cacheStats()`（misses = 实际检测次数）。检测器命中计数在注册表幂等过滤**之前**累计（含每轮重扫的含 secret 文本，随会话事件递增）。

### T7 事实发现（后续 ticket 注意）

- pi 的 `prompt()` 对 `/` 开头文本**先**尝试扩展命令分发（`_tryExecuteExtensionCommand`），命中即返回——input 钩子不会看到 `/keep-secret` 自身；接缝 1 验证命令注册需预置假供应商脚本（未识别的命令会作为 prompt 发给模型并记录请求，requests().length 即信号；**无脚本时 faux 在记录前就报错，零请求不能证明命令被执行**）。
- harness（SDK 会话）的 `ctx.ui` 是 `noOpUIContext`（mode "print"）：notify 不可观察，命令面断言用 stub pi 提取注册的 handler + 注入记录型 ctx.ui 直调（与 pi 同一调用面，ticket 认可的「命令 handler 直测」）。
- T5 接入点：`createKeepSecretCommandsExtension({ judge })` 传 `JudgeStats { truncations, fallbacks }` 即点亮状态面 judge 行；自测假密码项的期望届时改为掩码。

## 约定

- Conventional Commits；分支 `ticket/<n>-<slug>`（每张 ticket 在自己的 worktree 基于 `feat/secret-masking`）。合并到 main 需用户明示许可。
- 回复与文档使用简体中文。Issue 跟踪见 `docs/agents/issue-tracker.md`。
