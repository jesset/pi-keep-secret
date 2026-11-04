# Changelog

本项目的全部显著变更记录于此。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵守[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **架构（ADR-0001）：出站掩码组合与 Clean Verdict 协议内聚进掩码管线。**
  `createMaskingPipeline` 成为唯一出站掩码所有者：未配置 judge 公开同步
  `maskText`（regex 快路径）；配置 judge 后唯一出站入口为异步 `mask`
  （judge 层先行 → regex 阶段兑底 → clean cache 一次查一次写；同步 regex
  阶段退为内部实现，不再存在绕过 judge 的出站通道）。出站收缩为单扩展
  单次遍历（原 judge/regex 双 hook 的注册顺序契约移除）；judge 创建内聚
  进管线构造（`judge` 配置段或掩码器替身经管线 options 传入），掩码压缩
  与自测改消费统一入口——新增出站路径结构上不可能漏接 judge（ticket #12
  压缩漏掩码事故的根治）。`cleanCache` 不再作为管线公开成员（协议触点
  7 → 2）；命令面 judge 状态改经 `pipeline.judgeInfo()` 只读快照读取，
  状态面 `on missing` 改读会话生效策略（原先读 reload 后的磁盘新配置，
  可能展示未生效策略）。叶间消息级并发下「judge 模板必先签发」不再确定
  ——同一 secret 单一形态不变量由注册表 first-issuer-wins 保证（测试已
  改锚该不变量）。测试侧：judge/压缩/命令用例改走统一入口与正式组合装
  配，`classify`/`resolveModel`/judge 替身注入点原样平移至管线 options，
  clean 协议断言改行为面（classify 调用次数/计数递增/重判行为），
  `test/helpers.ts` 共享 classifier 替身取代 `judge-egress` 本地副本。
  程序化接口变更：`MaskingPipeline` 拆分为 `MaskingPipeline`（无 judge，
  同步 `maskText`）/ `JudgedMaskingPipeline`（有 judge，异步 `mask`）双形
  态；`createConfiguredMaskingExtension` 不再返回 `judge`；`src/judge/
  extension.ts` 拆入 `src/judge/masker.ts`（judge 出站扩展工厂移除）。

- **reload 变更分类收口（架构评审候选 2）**：`loader.reload()` 返回按段变更分
  类（`ReloadOutcome`：`config` / `changed` / 逐字段 `changes`），作为订阅通
  知与 `/keep-secret reload` 文案的唯一口径；`configFingerprint` 不再导出。
  仅检测器集实质变更触发热应用——judge/hashLength/cleanCache 段变更不再误清
  clean cache 与检测器命中统计（此前任意字段变更都会清空运行统计，而状态面
  显示 "detectors unchanged"）；`applyDetectors` 幂等化（相同检测器集
  no-op）；reload 通知文案改由分类驱动，列出实际变更的仅新会话生效段名；
  订阅回调签名追加第二参数 `outcome`。

## [0.2.0] - 2026-11-03

### Added

- 报告排版层 `src/ui/`（`formatReport` / `formatTable` / `formatBullets` / `formatBlockReport`）：East Asian Width 感知的可见宽度计算、72 列预算内预折行（超宽路径优先在 `/` 处断行）、键值列全局对齐、悬挂缩进、分组键值块与表格；输出纯文本 + 结构字符，不注入 ANSI（主题色由 pi 施加：`info` 走 dim，`warning` / `error` 仅首行加前缀）。配 19 例单元测试覆盖宽度、折行、对齐、悬挂缩进与输出卫生。
- UI 语言守卫测试：静态扫描 `ctx.ui.notify` / `ctx.ui.setStatus` / `pi.registerCommand` 调用点内的字符串字面量禁止 CJK；行为面遍历状态/自测/reload/未知子命令，以及无 judge、judge 降级、模型缺失、非法配置、入站预检等分支的输出。

### Changed

- 用户可见 UI 文案统一英文（源码注释与 `docs/` 保持中文）：`/keep-secret` 命令描述、状态/自测/reload/未知子命令输出、入站预检通知，以及配置错误、judge 模型缺失/故障/线缆偏好未生效、掩码压缩取消的 notify 与状态栏文案。
- 命令输出改由排版层统一合成：状态面板为「标题 + 分隔线 + 分组键值块（Config / Config errors / Session / Judge / Compaction）」，自测为逐样本表格 + 结论收尾，reload 统一 `config` / `detectors` 骨架（hot-applied / unchanged / reload failed + Errors 块）；长值折行后续行对齐值列，兼容 `Warning: ` / `Error: ` 首行前缀。

### Documentation

- README / README.zh-CN 的 Commands 章节补充样例输出与「英文 + 纯文本 + 72 列预算 + 无交互弹窗」不变量说明。

## [0.1.1] - 2026-11-03

No functional changes since 0.1.0 — documentation and npm metadata only.

### Documentation

- Open-source doc face: product-shaped README with full zh-CN mirror, threat model (`docs/threat-model.md`), `SECURITY.md`, `CONTRIBUTING.md`, and migration of the development history to `docs/dev-notes.md`; public docs are provenance-neutral.
- "Recommended topology" section: deploy the judge model locally (localhost/LAN) so secret material never leaves the local domain — three verified channels (native llama.cpp classifier via `llama-cpp-classify`, local LiteLLM gateway, any LAN System One/decisions endpoint), with a boundary diagram and judge-placement comparison table.
- Tagline sharpened: "Model providers see only placeholders. Your tools and transcript keep the real values."

### Maintenance

- `package.json` npm metadata (description, keywords) — effective from this release.

## [0.1.0] - 2026-11-02

首个可用版本：pi 会话的透明出站密钥掩码扩展。出站请求里的凭据替换为格式保持的确定性伪值，回程响应还原真值，本地 transcript 与工具执行不受影响。规格见 GitHub issue jesset/pi-keep-secret#1。

### Added

- 出站掩码：`context_with_system` 钩子上的确定性伪值替换（同真值恒同伪值，格式保持检测器模板形状）；覆盖 user/toolResult/assistant（text/thinking/toolCall.arguments 深遍历）/system（prose 与 sections）/压缩与分支摘要消息；图片字节与签名字段豁免。内置默认检测器集：openai-key、github-pat、aws-access-key-id、google-api-key、slack-bot-token、pem-private-key、jwt（T2，#4）。
- 回程还原：`message_end` 与 `tool_call` 把伪值还原为真值（transcript 落盘与工具执行前生效）；截断前缀兜底（max_tokens 半个伪值）（T3，#5）。
- 检测器 JSON 配置 + clean cache：配置路径解析（参数 > `PI_KEEP_SECRET_CONFIG` > 用户级安装目录）、未知键报错、非法整体回退默认集、`/keep-secret reload` 热应用检测器集；干净文本缓存短路（每轮成本 O(新增消息)），含 secret 文本永不缓存（T4，#6）。
- 掩码压缩：`session_before_compact`/`session_before_tree` 返回完整结果整体替换 pi 自带压缩（manual `/compact`、阈值、overflow 三路径与分支摘要）；摘要输入掩码、摘要结果还原，本地 summary 保留真值；摘要带重试（2 次重试、短退避），重试耗尽取消本次压缩并告警计数（不存在回退 pi 默认压缩的路径，T6，#8）。
- System One judge 判定层：两阶段判定（gate 单问短路 + 候选批量 bool 问）、128 问/批、8 批截断护栏、24000 字符分块、会话级并发信号量；classify 故障 fail_closed（未验证候选一律掩码）；classifier 模型缺失按 onMissing 策略处理——默认 fail_closed 掩码，regex_only 显式降级仅 regex 层（notify + 状态栏 + 计数）（T5，#7）。
- 入站预检与命令面：提交疑似凭据的非阻塞警告；`/keep-secret`（状态）/ `test`（合成样本自测）/ `reload`（配置热重载），三模式（TUI/print/RPC）安全降级（T7，#9）。
- 正式组合接线（judge 接入 `extension/index.ts`）：config.json 的 `judge` 段（provider/modelId/阈值/批参/并发/伪值模板）驱动装配，judge 先于 regex 出站扩展注册；JudgeStatus 接入命令面，自测假密码项期望随 judge 启用动态化；judge 文本掩码器抽为公共入口（出站链与自测共用同一实例）；降级叶记 clean cache 墓碑防「judge 恢复后被缓存短路」漏判（T8，#10）。
- 端到端收敛用例（正式组合入口，接缝 1）：多轮掩码-还原-再掩码确定性、judge 故障 fail_closed 全链路、压缩后对话继续且伪值一致、图片内容字节不变（T8，#10）。
- 目录扩展打包：`package.json` 的 `pi.extensions` 清单（`--extension <repo>` 与用户级目录发现共用）；README 安装/配置/卸载步骤与已知限制汇总（T8，#10）。
- `detectorsMode` 策略开关（`replace` 默认 / `merge`）：merge 下内置默认集与用户 `detectors` 合并——同名用户项原位覆盖内置（可微调 pattern/redactTemplate，如收紧 sk- 排除规则），非同名项追加在内置之后；`detectors` 未配置时两模式等价纯内置集；非法值整体回退默认集 + 错误可见；模式与生效集纳入配置指纹（reload 热应用），`/keep-secret` 状态面展示模式与生效检测器数（T13，#13）。
- judge 双协议（T14，#14）：config.json 的 judge 段新增可选键 `api`（`systemone` / `decisions`，非法值在 loader 整体回退）——缺省跟随模型注册条目的 `api` 字段（适配器协议无关，走 modelRegistry.classify）；`MODEL_API_BY_JUDGE_API` 映射 typesafe-system-one↔systemone、openai-decisions↔decisions（T16 起用作偏好覆盖映射，见 Changed）。网关验证脚本支持 `PI_KEEP_SECRET_JUDGE_API=decisions` 切 OpenAI Decisions 线缆；README 双协议 models.json/config 样例。
- CI 与发布流水线：`.github/workflows/ci.yml`（push/PR：`bun install --frozen-lockfile` → typecheck → `bun test`）；`.github/workflows/publish.yml`（GitHub Release `v*` 发布触发，tag 与 package.json 版本双验证，npm OIDC trusted publishing 免令牌发布 `--provenance --access public`，参照 pi-verdict/czottmann(pi-automode) 模式）。配套：`typecheck` 脚本与 `typescript` devDependency、tsconfig 覆盖 `extension/`、package.json 发布字段（`files` 白名单（extension/src/文档，排除 `*.test.ts`）、`peerDependencies`（pi-coding-agent ≥1.4.0，optional）、repository/keywords/author/license，移除 `private`）与 README badge/npm 安装方式。
- Compaction summary input covered by the judge layer (ticket #12): `createMaskedCompactionExtension` accepts the egress chain's judge masker (the formal composition in `extension/index.ts` passes the same instance), and the summary input — conversation messages, `previousSummary`, `customInstructions`, on both `session_before_compact` and `session_before_tree` — runs judge-first then regex, mirroring the egress chain (judge needs the original text; regex idempotently skips issued placeholders; placeholder forms stay unified by first-issuer-wins through the shared registry/clean cache, and clean leaves are short-circuited by the shared clean cache). Judge classify failures fail closed with unverified candidates masked while compaction continues; the summary retry/cancel semantics are unchanged and still reserved for the summarization call itself. A missing classifier model follows the egress `onMissing` policy (default fail_closed; `regex_only` degrades the summary input to the regex layer — residual gap documented in README known limitations). Without a judge config, compaction stays regex-only. Acceptance cases: `test/compaction-judge.test.ts`.

### Changed

- Placeholder form unification, first-issuer-wins (T20, #21): the placeholder registry now keeps a secret→placeholder reverse index — the same secret always leaves the session in one placeholder form regardless of which detection path issues it (judge leaf or regex leaf); the first issuance pins the form, later detector templates are downgraded to suggestions, and LRU eviction cleans both indexes so post-eviction re-issuance deterministically follows the current suggestion. Deliberate divergence from per-detector template heterogeneity (the pre-T20 behavior baseline), accepted to avoid the model seeing one key as two values in a single request. README gains a "Behavioral notes" section (form unification, model awareness, restoration illusion, ecosystem layering).
- judge.api 语义从名称硬校验改为线缆偏好（T16，#16，修复插件注册 classifier 模型被误杀）：设置后按三分支应用——模型注册为 pi-ai 内置 classifier api 时覆盖分发线缆（classify 调用传浅拷贝仅改 api 字段的模型）；插件自定义 api（如 `litellm-decisions`）时尊重插件实现、正常装配，偏好未生效（一次性 info 通知 + `/keep-secret` 状态面线缆段与未生效标记）；彻底移除「不一致 → 不装配 judge」硬校验路径与错误文案。loader 合法值校验保留；运行期 classify 异常 fail_closed 语义不变。
- 掩码压缩故障语义（spec 故事 24，零泄漏）：摘要调用带重试（2 次重试、短退避，中止感知）；重试仍失败 → 返回 `{ cancel: true }` 取消本次压缩（会话继续不压缩）+ notify 说明与重试建议 + 取消计数；**彻底移除「回退 pi 默认压缩」路径**（默认压缩不掩码，回退即泄漏）。用户中止语义不变（不计失败）。
- judge 模型缺失默认 fail_closed（spec 故事 19「down judge never means an unmasked request」）：新增配置项 `judge.onMissing`（`fail_closed` 默认 / `regex_only` 显式知情降级）；fail_closed 下模型缺失与 classify 故障同路径——该消息未验证候选一律掩码（真值注册表本地保留）/ 命令面状态行展示生效策略 / 自测在模型缺失时全部样本期望掩码并附说明。
- judge 截断护栏（故事 19 精神）：候选超 `batchSize × maxBatches` 截断丢弃的短候选按未验证一律掩码（不再放行；计数保留）。
- 配置指纹统一为 loader 的 `configFingerprint`（reload 变更判定与命令面同口径）；span 掩码尾段（幂等过滤→redact→注册表签发）提取共享函数（judge 与 regex 管线去重）；LRU 逐出循环提取共享工具函数（内部重构，行为不变）。

### Added

- 出站遍历覆盖 bashExecution（`!命令` 的 command/output）与 custom 自定义消息（content）——两者经 pi convertToLlm 投影为 user 文本进模型上下文，此前是掩码缺口；custom 的 details 与 `!!` 前缀 excludeFromContext 消息不进上下文、豁免。

### Security

- Outbound model requests no longer contain credentials: every egress surface — request context and compaction/branch-summary input (the latter double-covered judge+regex since ticket #12) — consistently carries placeholders; the only remaining exception is regex-invisible secrets during an explicit, informed `judge.onMissing="regex_only"` degradation (visible degraded state, see README known limitations).
- 判定通道故障绝不静默放行：未验证候选一律掩码（fail_closed）——覆盖 classify 出错/缺应答、（默认配置下的）模型缺失与 maxBatches 截断丢弃。
- 压缩/分支摘要故障绝不回退不掩码的默认压缩：重试后取消本次压缩（会话继续不压缩），零真值出站。
