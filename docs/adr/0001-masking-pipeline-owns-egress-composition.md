# 掩码管线独占出站掩码组合与 Clean Verdict 协议

会话级双层掩码（judge 层 → regex 层）的串联顺序与 Clean Verdict 协议（clean = 两层都判干净；墓碑阻止后续写入干净判定）曾散落在装配层、压缩、命令自测与测试四个调用方手中，靠 hook 注册顺序契约维持，并已造成压缩路径漏接 judge 的真实泄漏事故（test/compaction-judge.test.ts 头部注释）。决定：深化现有 `MaskingPipeline`（src/masking/pipeline.ts）为唯一出站掩码 module——judge 创建内聚进管线构造、clean cache 读写收敛为完整链入口的一次查一次写、出站收缩为单个 extension 单次遍历；`ctx` 形参原样保留（judge 实际只依赖 modelRegistry 与 UI 通知能力）。

## Considered Options

- **新建包裹 module（SessionMasking 组合 pipeline + judge）**：拒绝。多出一个浅转发层，删除测试不通过；pipeline 本就是「会话级掩码」的语义载体。
- **统一 async interface**：拒绝。regex-only 配置不该为不存在的 judge 层承担每文本叶的 Promise 成本；保留「无 judge 同步 maskText / 有 judge 异步 mask」双形状，有 judge 时同步入口退为内部阶段。
- **纳入回程还原（unmask/ingress）**：拒绝。伪值一致性由共享 registry 实例保证，合并不增加 depth；ingress 是健康区域。
- **hook 层维持 judge/regex 两个 extension**：拒绝。pipeline 拥有完整掩码后双 hook 只剩历史形状，且同一消息树被遍历两次。

## Consequences

- 状态面与自测改从管线的只读状态快照读取，不再持有 judge 引用。
- 测试注入（`classify`/`resolveModel`/judge 替身）平移到管线 options；Clean Verdict 断言改为行为面（classify 调用次数、命中计数、重判行为），cache 内部仅保留自身单测。
- `applyDetectors` 的 reload 语义本次原样保留（变更分类见后续单独决策）。
