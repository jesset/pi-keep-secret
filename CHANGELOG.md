# Changelog

本项目的全部显著变更记录于此。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵守[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] 0.1.0

首个可用版本：pi 会话的透明出站密钥掩码扩展（LiteLLM `secret-mask` guardrail 移植）。出站请求里的凭据替换为格式保持的确定性伪值，回程响应还原真值，本地 transcript 与工具执行不受影响。规格见 GitHub issue jesset/pi-keep-secret#1。

### Added

- 出站掩码：`context_with_system` 钩子上的确定性伪值替换（同真值恒同伪值，格式保持检测器模板形状）；覆盖 user/toolResult/assistant（text/thinking/toolCall.arguments 深遍历）/system（prose 与 sections）/压缩与分支摘要消息；图片字节与签名字段豁免。内置默认检测器集：openai-key、github-pat、aws-access-key-id、google-api-key、slack-bot-token、pem-private-key、jwt（T2，#4）。
- 回程还原：`message_end` 与 `tool_call` 把伪值还原为真值（transcript 落盘与工具执行前生效）；截断前缀兜底（max_tokens 半个伪值）（T3，#5）。
- 检测器 JSON 配置 + clean cache：配置路径解析（参数 > `PI_KEEP_SECRET_CONFIG` > 用户级安装目录）、未知键报错、非法整体回退默认集、`/keep-secret reload` 热应用检测器集；干净文本缓存短路（每轮成本 O(新增消息)），含 secret 文本永不缓存（T4，#6）。
- 掩码压缩：`session_before_compact`/`session_before_tree` 返回完整结果整体替换 pi 自带压缩（manual `/compact`、阈值、overflow 三路径与分支摘要）；摘要输入掩码、摘要结果还原，本地 summary 保留真值；不可恢复故障显式回退 pi 默认压缩并告警计数（T6，#8）。
- System One judge 判定层：两阶段判定（gate 单问短路 + 候选批量 bool 问）、128 问/批、8 批截断护栏、24000 字符分块、会话级并发信号量；classify 故障 fail_closed（未验证候选一律掩码）；classifier 模型缺失显式降级仅 regex 层（notify + 状态栏 + 计数）（T5，#7）。
- 入站预检与命令面：提交疑似凭据的非阻塞警告；`/keep-secret`（状态）/ `test`（合成样本自测）/ `reload`（配置热重载），三模式（TUI/print/RPC）安全降级（T7，#9）。
- 正式组合接线（judge 接入 `extension/index.ts`）：config.json 的 `judge` 段（provider/modelId/阈值/批参/并发/伪值模板）驱动装配，judge 先于 regex 出站扩展注册；JudgeStatus 接入命令面，自测假密码项期望随 judge 启用动态化；judge 文本掩码器抽为公共入口（出站链与自测共用同一实例）；降级叶记 clean cache 墓碑防「judge 恢复后被缓存短路」漏判（T8，#10）。
- 端到端收敛用例（正式组合入口，接缝 1）：多轮掩码-还原-再掩码确定性、judge 故障 fail_closed 全链路、压缩后对话继续且伪值一致、图片内容字节不变（T8，#10）。
- 目录扩展打包：`package.json` 的 `pi.extensions` 清单（`--extension <repo>` 与用户级目录发现共用）；README 安装/配置/卸载步骤与已知限制汇总（T8，#10）。

### Security

- 出站模型请求不再包含凭据：全部出站路径（请求上下文、压缩/分支摘要输入）恒伪值；仅「judge 降级期间 regex 不可见的 secret」例外（可见降级状态，见 README 已知限制）。
- 判定通道故障绝不静默放行：未验证候选一律掩码（fail_closed）。
