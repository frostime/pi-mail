---
create: 2026-09-25
status: backlog
on: a2061ce
recorder: pi
---

# presence 临时存储失败会阻断首次持久写

0.11.0 把 presence 定义为 ephemeral/best-effort（启动失败只告警），但 `init()` 里的 `heartbeat()` 不在 `writeStore` 包裹内（`mail-service.ts` 的 `init` / `heartbeat`），presence 写失败会让会话首次持久写（send / configure / reminder）整个失败。

## 观察到的行为

- 首次 send 不发信，报原始 `ENOTDIR/EACCES`，路径指向 `getAgentDir()/tmp/pi-mail/...`，而非 "Pi Mail disabled"。
- 失败时 durable store 与 `provisional: true` 的 peer 已落盘（部分提交）；reload/崩溃会留下空壳 mailbox。
- 重试因 `ensureRegistered` 早退、绕过 heartbeat 而成功 → "第一次失败、第二次成功"。
- `session_info_changed` 路径（`index.ts`）同样未捕获；心跳定时器每 5s 打一条失败日志。
- 不受影响：读操作、attention、Web UI、human 发送、已有 durable peer 的 resume 会话。

## 触发条件

需同时成立：presence 桶路径不可写，且恰好命中 `init()` 那一次 heartbeat。

- 会话存储被重定向（`PI_CODING_AGENT_SESSION_DIR` / settings `sessionDir`）而 agent 目录只读/受限：容器、企业策略。
- 瞬时抖动：Windows 杀软/同步导致 EPERM/EBUSY，NFS/SSHFS 家目录 EIO/ENOTCONN。
- `tmp` 路径被同名文件、失效 junction、未挂载盘占位，或 root 属主残留。

## 期望状态

presence 失败在所有路径上只降级"发现/寻址"，不阻断 durable 写；若确实要失败，归因应正确且不留下与操作结果不符的部分持久状态。

## 待定

- 触发条件现实性存疑（低频），是否处理未决定；本记录不代表承诺处理。
- presence 锚点固定在 `getAgentDir()`、不跟随会话存储重定向，是相关但独立的问题。
- heartbeat 内部同时包含 durable store 读；若整体 best-effort 可能掩盖数据错误，需要区分。
