# Issue 终稿：docs(pi-mail) — 补充 SPEC/SKILL 中提醒计数、线程可见性、线程延续语义

> 状态：**定稿**（双会话共同产出，双方确认无异议）
> 参与：session-8ea75b7030cf（8ea75b7030cf）+ hongyan（d48da830c546）
> 确认记录：hongyan 复核意见 6f4fbeb9e3a1 + 定稿确认 000886191583
> 范围：文档改动为主；行为改动 2 处列为"可选代码级小改"，需用户点头

## 背景

跨会话实测（投递 / 回复 / notify 即时通知 / 静默投递 + 计数提醒 / human 通道）全部通过，机制工作正常。讨论确认若干设计决策成立，同时发现 **SPEC 语义未定义 3 处、SKILL 缺失 4 处、行为不一致 1 处（P2）**。

## 决策记录（保持现状，不改代码）

- **presentedAt 弱语义 + 列表即呈现，不拆两级**：对 LLM 而言"读过正文"判定天然不可靠，弱语义只回答"内容是否送到模型可见边界"；拆级使状态机翻倍，收件人是 LLM 而非人类。`unpresented_only` 的窄窗口特性是特征不是 bug。
- **桶提醒无时间维度**：靠"pending 降回 ≤2 桶归零 + session_start 重置"兜底；提醒本身已注入上下文，不构成丢消息风险。
- **thread 不加参与校验**：单项目 `.pi/mails` 明文存储的威胁模型下，任何同项目会话本可直读存储；工具层加校验等于在明文仓库上建"礼仪门"，制造虚假安全感。保密的前提是存储层加密，届时再谈校验。

## SPEC.md 改动（3 处）

1. **Delivery/backlog 一节 — pending 计数语义**：提醒计数仅统计"未呈现且未被 notify 注入过上下文的静默消息"（silentPending：排除 senderKind=human、notify 且已排队注入者）；notify 消息已注入，不再计入"等待数"。实测佐证：3 封静默 = 提醒计数 3。
2. **Delivery/backlog 一节 — thread() 可见性边界**：thread 不校验参与关系，任何同项目会话可读线程全量；可达性自然受限（模型仅能引用自己收/发/被 cc 过的 message_id），与明文存储信任模型一致。
3. **Web UI/模型行为一节 — presentedAt 决策记录**：列表即呈现，不拆两级（见上）。

## SKILL.md 改动（4 处）

1. **新增"决策指引"段**：该用 mail（信息/问题/评审/决策需跨会话边界时）/ 不该用（可本地完成、纯闲聊）；notify 仅用于真正需要立即打断的直接收件人，不滥用（滥用侵蚀信号价值）。
2. **新增"线程延续"规则**：延续既有讨论必须 `reply_to` 保持单线；只有新主题才开新线程。明确 reply_all 是"原收件人快照"（原发件人为 to、原 to/cc 减自己为 cc）而非动态线程参与者——中途新加入的会话不会被自动包含，需显式 to/cc。（实测暴露：双方曾各开新线程导致双线跟踪）
3. **新增"排障"段**：收不到消息/提醒时检查 `<project>/.pi/mails` 与对方 discoverable/活跃状态；alias 冲突时 resolveOne 偏好活跃会话、仍歧义则报错列候选。
4. **桶行为一句话 + thread 阅读即呈现**：积压提醒只在进入新桶（每 3 封）时发生；长期停在 3-5 封不重复提醒，除非 pending 降回 2 以下或新会话启动。thread 阅读即呈现（预览同样进入上下文），与 inbox 一致。

## 行为一致性改进（P2 · 已复核，选实现标记）

- **位置**：`mail-service.ts` `thread()`；对照 `listInbox(messageId)`（阅读即 `markPresented`，默认 true）
- **现状（双会话独立验证属实）**：`thread()` 只做 resolveMessageId → 按 threadId 过滤 → decorateMessage，无任何 updateDelivery；模型经线程读完正文后消息仍算"未呈现"，继续计入桶提醒 → 过期提醒；`unpresented_only` 视角状态失真
- **方案**：thread() 阅读时同步标记 presented（与 inbox 行为自洽，弱语义下预览同样进入上下文；文档化差异无解释性收益）
- **实现细节（必须遵守）**：标记时**只标记当前会话有 delivery 记录且未呈现的消息**，绝不写入线程中非本人收件人的 presentedAt——thread 可见性是全量，但投递状态只能动自己的
- **归入**：可选代码级小改，待用户点头

## 可选代码级小改（待用户确认）

- **P9 · 工具 description 指针**：index.ts 注册的 mail 工具 description 追加 "Usage policy and examples: see the bundled pi-mail skill"，为未挂载 skill 的会话裸调留出路（符合 SPEC"工具元数据保持小、策略在 skill"约束；不涉及行为）
- **P2 · thread() 标记 presented**（见上）

## 验收标准

- [ ] SPEC 3 处 + SKILL 4 处全部落文；P2、P9 按用户决策处理
- [ ] 双会话各自重读 SKILL，对新规则的解读一致（已在确认记录中验证）
- [ ] thread() 阅读后，已呈现消息不再计入后续桶提醒计数（若选实现标记）
- [ ] 本讨论线程全程 reply_to 单线延续，规则本身已通过实测验证
