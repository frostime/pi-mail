# Pi Mail

[English](./README.md)

**为彼此独立的 Pi Coding Session 提供本地邮箱通信。**

Pi Mail 给 Pi 补上一层轻量的通信基础设施。每个 Pi session 都会自动获得稳定的邮箱身份；同一项目中的 session 可以互相发现并异步收发消息；即使收件 session 已经退出，邮件仍然可以持久保存。用户也可以通过本地 Web UI 查看整个项目的邮箱状态，并直接给指定 session 发消息。

Pi Mail 的边界刻意停留在“通信”。它**不负责**创建 team、分配任务、启动 agent、安排执行顺序，也不决定多个 session 应该如何协作。

```text
Pi Session A ─┐
Pi Session B ─┼── 项目本地邮件存储 ── Human Web UI
Pi Session C ─┘
```

## Pi Mail 提供什么

| Agent 侧 | User 侧 |
| --- | --- |
| 一个紧凑的复合型 `mail` 工具，用于发现、发送/回复、收件箱、thread、等待与邮箱设置 | `/mail-ui` 用于查看邮箱、阅读项目邮件和主动发信 |
| 支持多个 `To` / `Cc` 收件人，并能向已经下线的历史 session 持久投递 | 可以给一个、多个或全部当前活跃 session 发消息 |
| 默认静默投递；只有明确使用 `notify: true` 时才要求立即提醒直接收件人 | Web UI 可直观看到待处理邮箱状态，Pi 底部也会显示紧凑的 `mail N` 状态 |
| 支持 thread 回复、短消息 ID 引用和有限时长的 inbox wait | 可选的长期未处理邮件提醒，以及对 inactive mailbox 的人工删除管理 |

运行时不依赖第三方 NPM 包。邮件数据只使用 Node 文件系统能力，存放在项目自己的 `.pi/mails/` 中。

## Agent 怎么使用

Pi 只向模型暴露一个复合型工具：`mail`。更详细的用法约定放在随包安装的 `pi-mail` skill 中，因此常驻 tool schema 可以保持很小。

Agent 可以先发现当前项目中活跃、允许被发现的其他 session：

```text
mail { action: "discover" }
```

随后可以向一个或多个对象发信：

```text
mail {
  action: "send",
  to: ["reviewer"],
  cc: ["frontend"],
  subject: "API review",
  body: "The response shape changed in commit abc123."
}
```

普通 peer mail 默认静默进入对方邮箱，不会因为每一封信都强行打断对方。只有在确实需要直接提醒 `To` 收件人时，发送者才显式开启：

```text
mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review needed now",
  body: "Please check the compatibility regression.",
  notify: true
}
```

平时的邮箱处理保持异步。`inbox` 列表和 thread 只显示有界的正文预览，需要时再打开某一封完整邮件。若 Agent 明确正在等待回复，可以使用有限时长、且不会消费邮件的 `wait`：

```text
mail { action: "inbox", unpresented_only: true }
mail { action: "wait", timeout_seconds: 60 }
```

如果收件 session 当前已经退出，只要它的 mailbox 仍然存在，发送仍会成功。发送结果会明确告诉 Agent 对方目前 inactive，邮件则保留在收件箱里，等该 session 以后 resume 时继续读取。

来自其他 Pi session 的邮件始终保持 peer-session 身份，不会被伪装成人类授权。反过来，用户从 Web UI 主动发送的邮件会以真实 user message 的身份进入目标 Pi session。

## User 怎么使用

Pi Mail 同时给用户提供一个项目级的监督视图。

```text
/mail-ui
/mail-ui close

/mail-reminder 30
/mail-reminder off
```

运行 `/mail-ui` 后，Pi Mail 会在 `127.0.0.1` 上启动带随机 token 的本地服务并打开 Web UI。界面支持中英文、亮色/暗色主题，并展示每个邮箱对应的 Pi session name、alias、短 ID、在线状态、待处理 `To` / `Cc` 数量，以及最早一封待处理直接邮件已经等待了多久。

用户可以在 Web UI 中阅读项目邮件，也可以给一个 session、多个 session，或者全部当前活跃 session 发消息。对于已经退出且确认不再需要的历史 mailbox，用户可以直接手动删除。删除只清理这个 session 自己的收件状态，不会重写仍然属于其他参与者的共享历史消息。

Web UI 只是一个管理客户端，邮件通信本身并不依赖它持续运行。拥有该 Web UI 的 Pi session 关闭时，本地 Web 服务会自动关闭；用户也可以使用 `/mail-ui close` 或网页中的关闭动作主动停止它。

当当前 session 存在尚未呈现的收件邮件时，Pi 底部会显示类似 `mail 2` 的紧凑状态。用户还可以按需使用 `/mail-reminder <minutes>` 为当前邮箱开启“长时间未处理邮件”提醒；该能力默认关闭。

## 项目范围与持久化

Pi Mail 默认只在当前项目范围内发现和存储邮箱，不会让所有 Pi session 在全局互相暴露。对于 Git 项目，主 checkout 与 linked worktree 会共享同一个 canonical project root，因此位于不同 worktree 的 Pi session 仍然可以互相发现和通信。

运行时数据位于：

```text
.pi/mails/
├── .gitignore
├── peers/
├── presence/
├── messages/
└── mailboxes/
```

`.pi/mails/.gitignore` 会让这些运行数据保持未跟踪状态，同时不会修改项目根目录已有的 `.gitignore`。

Pi session UUID 是不可变的邮箱身份。resume 同一个 Pi session 会继续使用原邮箱；fork 或 clone 如果产生了新的 Pi session UUID，就自然得到一个新的邮箱。历史 mailbox 会一直保留并可寻址，直到用户明确删除。

每一封 canonical message 使用一个不可变 JSON 文件保存，recipient 自己的投递状态单独维护。Pi Mail 不设置自动历史上限，也不会在后台静默清理旧邮件。

## 安装

发布后：

```bash
pi install npm:pi-mail
```

本地开发或测试：

```bash
pi install /absolute/path/to/pi-mail
```

Pi package 会以用户本机权限运行，因此安装第三方 extension 前应先检查源码。

## 开发与详细参考

```bash
npm test
npm run pack:check
```

随包提供的 [`pi-mail` skill](./skills/pi-mail/SKILL.md) 记录模型需要了解的详细使用约定；[`extensions/pi-mail/SPEC.md`](./extensions/pi-mail/SPEC.md) 则记录未来实现演进时必须维持的兼容性与模块契约。

## License

GPL-3.0-only. Copyright (c) frostime.
