# Changelog

本项目的全部显著变更记录于此。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵守[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

首个可用版本：pi 会话的透明出站密钥掩码扩展（LiteLLM `secret-mask` guardrail 移植）。出站请求里的凭据替换为格式保持的确定性伪值，回程响应还原真值，本地 transcript 与工具执行不受影响。规格见 GitHub issue jesset/pi-keep-secret#1。

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

### Changed

- judge.api 语义从名称硬校验改为线缆偏好（T16，#16，修复插件注册 classifier 模型被误杀）：设置后按三分支应用——模型注册为 pi-ai 内置 classifier api 时覆盖分发线缆（classify 调用传浅拷贝仅改 api 字段的模型）；插件自定义 api（如 `litellm-decisions`）时尊重插件实现、正常装配，偏好未生效（一次性 info 通知 + `/keep-secret` 状态面线缆段与未生效标记）；彻底移除「不一致 → 不装配 judge」硬校验路径与错误文案。loader 合法值校验保留；运行期 classify 异常 fail_closed 语义不变。
- 掩码压缩故障语义（spec 故事 24，零泄漏）：摘要调用带重试（2 次重试、短退避，中止感知）；重试仍失败 → 返回 `{ cancel: true }` 取消本次压缩（会话继续不压缩）+ notify 说明与重试建议 + 取消计数；**彻底移除「回退 pi 默认压缩」路径**（默认压缩不掩码，回退即泄漏）。用户中止语义不变（不计失败）。
- judge 模型缺失默认 fail_closed（spec 故事 19「down judge never means an unmasked request」）：新增配置项 `judge.onMissing`（`fail_closed` 默认 / `regex_only` 显式知情降级）；fail_closed 下模型缺失与 classify 故障同路径——该消息未验证候选一律掩码（真值注册表本地保留）/ 命令面状态行展示生效策略 / 自测在模型缺失时全部样本期望掩码并附说明。
- judge 截断护栏（故事 19 精神）：候选超 `batchSize × maxBatches` 截断丢弃的短候选按未验证一律掩码（不再放行；计数保留）。
- 配置指纹统一为 loader 的 `configFingerprint`（reload 变更判定与命令面同口径）；span 掩码尾段（幂等过滤→redact→注册表签发）提取共享函数（judge 与 regex 管线去重）；LRU 逐出循环提取共享工具函数（内部重构，行为不变）。

### Added

- 出站遍历覆盖 bashExecution（`!命令` 的 command/output）与 custom 自定义消息（content）——两者经 pi convertToLlm 投影为 user 文本进模型上下文，此前是掩码缺口；custom 的 details 与 `!!` 前缀 excludeFromContext 消息不进上下文、豁免。

### Security

- 出站模型请求不再包含凭据：全部出站路径（请求上下文、压缩/分支摘要输入）恒伪值；例外仅剩显式知情选择 `judge.onMissing="regex_only"` 的降级期间 regex 不可见的 secret（可见降级状态，见 README 已知限制）。
- 判定通道故障绝不静默放行：未验证候选一律掩码（fail_closed）——覆盖 classify 出错/缺应答、（默认配置下的）模型缺失与 maxBatches 截断丢弃。
- 压缩/分支摘要故障绝不回退不掩码的默认压缩：重试后取消本次压缩（会话继续不压缩），零真值出站。
