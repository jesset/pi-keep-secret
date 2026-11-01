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

- 会话运行在临时目录（cwd/agentDir）、内存 settings、内存 session 中，不触网、不落盘。
- 假供应商记录的 `messages` 即「供应商视角」：`context_with_system` 钩子与 `convertToLlm` 之后的消息（LLM 格式）。
- 脚本化响应按请求顺序逐次消耗；脚本耗尽后再被请求会得到错误消息（`No more faux responses queued`），欠脚本的测试显式失败。

### 主路径与回退决策

- **主路径（已采用，已验证）**：SDK `createAgentSession` + `ModelRuntime.registerNativeProvider(faux.provider)`。pi-ai 自带测试用 [faux 供应商](node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts)：其 stream 函数就是注入的假 streamFn，出站请求走完整 pi 管线（扩展钩子、convertToLlm、认证解析）后由它应答。脚本化响应用 `fauxAssistantMessage`/`fauxToolCall` 构造（含 text/thinking/toolCall 块与流式事件）。
- **决策理由**：无需替换 `Agent.streamFunction` 字段或绕过 pi 内部管线，注入点最贴近真实供应商路径（ModelRuntime 分发、请求选项、缓存预热全走真实代码）；5 个冒烟测试全绿，覆盖出站断言、message_end 文本还原、toolCall 参数还原、跨轮重掩码、扩展文件加载。
- **回退方案（未实现）**：触发条件是「SDK 进程内注入受限」。本次未触发，故未实现。若未来受限：`pi -p --extension <dir>` 子进程 + 扩展内 `pi.registerProvider` 指向本地假 HTTP 供应商（pi 包 `examples/extensions/custom-provider-gitlab-duo/` 有完整模式），断言口径不变、速度更慢。

### T0 事实发现（后续 ticket 注意）

- `context_with_system` 钩子处 user content 已规范化为 text 块数组（非 string），正式掩码实现两种形态都要处理。
- `message_end` 返回替换消息在 transcript 落盘与工具执行之前生效；工具结果（含回显真值）会进入下一轮出站请求，出站掩码必须覆盖 toolResult 文本。
- 助手历史（含还原后的 toolCall 参数）每轮出站重新掩码后，供应商视角始终只见伪值（伪值确定性）。

## 约定

- Conventional Commits；分支 `ticket/<n>-<slug>`（每张 ticket 在自己的 worktree 基于 `feat/secret-masking`）。合并到 main 需用户明示许可。
- 回复与文档使用简体中文。Issue 跟踪见 `docs/agents/issue-tracker.md`。
