# Pi Mail

[English](./README.md)

**为彼此独立的 Pi Coding Session 提供本地邮箱通信。**

Pi Mail 为 Pi session 提供项目内的本地邮箱。每个 session 都有稳定的身份，可以发现同一项目中的其他 session；即使收件方暂时离线，邮件也能异步送达并保留下来。用户可以通过本地 Web UI 查看这些邮箱并发送消息。

Pi Mail 的职责是通信。它**不负责**创建 team、分配任务、启动 agent、安排执行顺序，也不决定多个 session 应该如何协作。

下面用一个 API 兼容性评审的例子说明典型流程：

```mermaid
sequenceDiagram
    participant A as Session A
    participant B as Session B
    participant U as User

    A->>B: 发送静默邮件：请评审 API 迁移
    Note right of A: “请确认新响应格式兼容旧客户端。”
    Note over A,B: 普通 peer mail 以异步方式投递，不会打断 B
    B->>B: Pi 底部显示 mail 1
    B->>B: 调用 mail 执行 inbox
    B-->>A: 回复兼容性评审结果

    U->>B: 从 /mail-ui 向 B 发起提问
    Note right of B: Pi 将其作为真实 user message 接收
    B-->>U: 回复到预留的 user 地址

    A->>B: 使用 notify: true 发送紧急邮件
    B->>B: Pi 在进程内插入一条 pi-mail custom message
    B->>B: 以 steer 方式投递并触发一轮 turn
    Note right of B: Agent 会立即收到提醒；邮件身份仍然是 peer-session
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

Pi 只向模型暴露一个统一的 `mail` 工具。更详细的用法约定放在随包安装的 `pi-mail` skill 中，因此工具定义可以保持精简。

如果不知道收件人，Agent 可以先发现当前项目中活跃、允许被发现的其他 session：

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

普通 peer mail 默认静默。设置 `notify: true` 后，收件方的 Pi 进程会插入一条 `pi-mail` custom message，以 `steer` 方式投递并触发一轮 turn。这样会立即提醒直接 `To` 收件人；`Cc` 收件人仍然保持静默。

```text
mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review needed now",
  body: "Please check the compatibility regression.",
  notify: true
}
```

邮箱操作通常是异步的。`inbox` 列表和 thread 只显示有界的正文预览，需要时再打开某一封完整邮件。若 Agent 正在等待回复，可以使用有限时长、且不会消费邮件的 `wait`：

```text
mail { action: "inbox", unpresented_only: true }
mail { action: "wait", timeout_seconds: 60 }
```

如果收件 session 当前已经退出，只要它的 mailbox 仍然存在，发送仍会成功。发送结果会明确告诉 Agent 对方目前 inactive，邮件则保留在收件箱里，等该 session 以后 resume 时继续读取。

来自其他 Pi session 的邮件会明确标记为 peer-session mail，不能当作用户授权。用户通过 Web UI 发送的邮件则会以真实 user message 身份进入目标 Pi session。

## User 怎么使用

Pi Mail 也为用户提供项目级的邮箱视图。

```text
/mail-ui
/mail-ui close

/mail-reminder 30
/mail-reminder off
```

运行 `/mail-ui` 后，Pi Mail 会在 `127.0.0.1` 上启动带有随机 token 的本地服务并打开 Web UI。界面支持中英文、亮色/暗色主题，并展示每个邮箱对应的 Pi session name、alias、短 ID、在线状态、待处理 `To` / `Cc` 数量，以及最早一封待处理直接邮件已经等待了多久。

用户可以在 Web UI 中阅读项目邮件，也可以给一个 session、多个 session，或者全部当前活跃 session 发送消息。对于已经退出且确认不再需要的历史 mailbox，用户可以直接手动删除。删除只清理这个 session 自己的收件状态，不会重写仍然属于其他参与者的共享历史消息。

Web UI 是可选的，关闭它不会影响邮件投递。运行它的 Pi session 关闭时，本地服务会自动停止；用户也可以使用 `/mail-ui close` 或网页中的关闭动作手动停止服务。

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

现在可以直接从公开的 GitHub 仓库安装：

```bash
pi install git:github.com/frostime/pi-mail
```

npm 包发布后，也可以使用更短的 registry 来源：

```bash
pi install npm:pi-mail
```

本地开发或测试：

```bash
pi install /absolute/path/to/pi-mail
```

Pi package 会以用户本机权限运行，因此安装第三方 extension 前应先检查源码。

## 运行时展示

一个最小的双 session 流程如下。下面的 alias 只是示例；实际使用时请以项目中 `discover` 返回的名称为准。

Session A 先发现 Session B，再发送一封普通的静默 peer mail：

```text
mail { action: "discover" }
# 1 session:
# - reviewer (8ea109ceb705) · active

mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review request",
  body: "Please review the storage changes."
}
# Sent [2ece9830] "Review request" to reviewer (8ea109ceb705).
```

Session B 收到邮件时不会被强制打断。Pi 底部会显示待处理数量，session 可以检查收件箱并回复：

```text
# Pi footer: mail 1
mail { action: "inbox", unpresented_only: true }
# 1 inbox message:
# [2ece9830] Review request · session-... (8ea109ceb705) · TO
# Please review the storage changes.

mail {
  action: "send",
  reply_to: "2ece9830",
  body: "Reviewed. The storage changes look compatible."
}
```

下面的截图来自一次实际运行。每次运行时，session ID、时间戳和 message ID 都会不同。

![Pi Mail 积压提醒与收件箱](./assets/notice.jpg)

*三封静默直接邮件累积后触发的提醒。提醒只报告数量；使用 `inbox` 查看邮件预览。*

![Pi Mail wait 等待展示](./assets/wait.jpg)

*有限时长的 `wait` 在新邮件到达后返回，但不会消费邮件。需要查看完整正文时，再使用带 `message_id` 的 `inbox`。*

如果要查看用户侧流程，可以在任意一个活跃 Pi session 中运行 `/mail-ui`。页面集中展示项目状态、最近邮件、session 在线状态、待处理 `To` / `Cc` 数量，以及 **Compose as user** 写信表单。通过该表单发送的邮件会以真实 user message 身份进入目标 Pi session；`/mail-ui close` 会停止本地服务。

![Pi Mail Web UI 展示](./assets/web-ui.jpg)

*项目状态、最近邮件、用户发信表单和 session 邮箱集中在同一页面。*

如果要展示立即提醒，再将发送请求改为 `notify: true`：

```text
mail {
  action: "send",
  to: ["reviewer"],
  subject: "Review needed now",
  body: "Please check the compatibility regression.",
  notify: true
}
# Immediate notification requested for direct To recipients.
```

![Pi Mail notify runtime showcase](./assets/notify.jpg)

*设置 `notify: true` 后，收件方的 Pi 进程会插入一条带有 peer 标识的 custom message，以 `steer` 方式投递并触发一轮 turn。*

## 开发与详细参考

```bash
npm test
npm run pack:check
```

随包提供的 [`pi-mail` skill](./skills/pi-mail/SKILL.md) 记录模型需要了解的详细使用约定；[`extensions/pi-mail/SPEC.md`](./extensions/pi-mail/SPEC.md) 则记录未来实现演进时必须维持的兼容性与模块契约。

## License

GPL-3.0-only. Copyright (c) frostime.
