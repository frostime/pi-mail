# Lazy Mail Store Change Specification

状态:需求已对齐,待实现
分支:`feat/lazy-mail-store`

## Problem Statement

当前 Pi Mail 在每次 Pi 会话启动时就创建 `<project>/.pi/mails/`(peers/presence/messages/mailboxes 四个目录加 `.gitignore`),即使该项目从未使用过邮件。用户在项目目录中到处搬移、通过符号链接访问仓库的场景很常见,目录污染与崩溃残留是实际困扰。

启动即创建的根因是"启动即注册"语义:会话必须在其他会话能读到的地方留下痕迹才能被发现和寻址,而目前唯一的共享介质就是项目内目录。两个启动期写操作——presence 心跳(每 5 秒)和 peer 档案落盘——都写进项目目录。

成功标准(用户原话级别的验收):**任何项目在使用 Pi Mail 产生真实邮件数据之前,项目目录中不出现 `.pi/mails/` 或 `.pi/` 目录;同时保持现有产品语义——会话启动即可被其他会话发现和寻址,邮件数据跨重启持久。**

## Approach

按数据生命周期拆分存放位置:

| 数据 | 生命周期 | 位置 | 创建时机 |
|---|---|---|---|
| presence 心跳 | 纯临时(TTL 20s) | `~/.pi/tmp/pi-mail/<项目哈希>/` | 会话启动,首次心跳 |
| peer 档案 / 消息 / 投递记录 | 跨会话、跨重启持久 | `<project>/.pi/mails/` | 首次持久写操作 |

推导链:项目目录懒创建 ⟹ 启动期的所有写操作都不能碰项目目录。presence 心跳不可推迟(活动检测依赖),只能外移;peer 档案可以推迟(发现/寻址由 presence 兜底),推迟后天然发生在 store 创建之时。

否决的替代方案:
- **完全懒注册且 presence 不外移**:未用过 mail 的会话不可发现、不可寻址,冷启动协作失效,伤及产品核心能力。
- **整个 store 搬临时目录**:消息是持久数据,OS 临时目录会被系统清理,邮件可能无声丢失,违背 SPEC 的持久性设计。
- **双模式注册**(老项目启动即注册、新项目懒注册):用户几乎不可感知,却要维护两条代码路径,弃用。

已排除的边界(明确不做):subst 虚拟盘符、映射网络盘等罕见路径别名场景——这类入口不保证收敛,属于明确排除的特殊情况。

## Terminology

- **peer 档案(peer record)**:`peers/<sessionId>.json`,邮箱的开户档案,含别名(S###)、会话名、可发现标志、提醒设置等;寻址解析的现有依据。
- **presence**:会话活动心跳记录,TTL 20 秒,纯临时,进程死即失效。
- **provisional(临时邮箱)**:新注册且未获得持久价值的邮箱,会话正常退出时被清理。
- **持久写操作**:send、收到投递、configure(别名/可发现/提醒)等产生持久数据的写路径;status、discover、inbox、wait 等读操作不算。
- **presence 桶**:临时目录下按项目哈希划分的一个子目录,同一项目的所有会话共享。

## Behavior Contract

### 新项目冷启动(无 store)

1. 会话 A 启动:项目目录无任何变化;presence 桶内出现 A 的心跳。
2. 会话 B 启动并 `discover`:能看到 A(别名来自 presence 扩展字段),寻址到 A 正常。
3. B 给 A 发邮件:store 被创建,消息与投递落盘;A 的 `/mail-status`、收件提醒照常。
4. A 从未用 mail 就退出:项目目录仍无残留(presence 是临时数据)。
5. `/mail-status` 在未注册会话中照常显示别名与 short id——别名是确定性算法从会话 ID 派生,不需要先落盘。

### 老项目(已有 store)

行为与现状一致,仅 presence 读取源换成临时桶;持久 peer 的活跃检测、Web UI 列表、批量删除等语义不变。

### 显式配置

`/mail-rename`、`/mail-reminder` 等持久写当场创建 store(符合触发原则)。

### 崩溃与清理

- 从未产生邮件数据的会话崩溃:项目目录无残留(对比现状:会留空壳)。
- 产生过邮件数据的会话崩溃:残留与现状一致,由既有的 `removeIfEmpty`/下次会话路径处理,不在本次范围。
- Pi home 的 presence 桶不依赖系统清理:TTL 逻辑过滤陈旧数据(现状已有),物理文件由运行中的 runtime 机会式清扫。

### 兼容性

- 已存在的 `.pi/mails/` 数据照常读取,无需迁移。
- 0.4 墓碑、legacy 别名迁移、reminder 覆盖等既有兼容规则不受影响;legacy 别名迁移推迟到首次注册时执行(注册被推迟,迁移随之推迟),期间旧别名仍可寻址。

## Implementation Decisions

1. **统一懒注册**:无论项目是否已有 store,新会话一律不落盘 peer 档案,等首次持久写操作。(实现层一致性选择,由 agent 判断定;用户有异议可推翻。)
2. **presence 记录扩展字段**:别名、可发现标志——支撑 peer 档案存在前的发现与寻址。这是寻址解析现状(只查 peer 档案,`resolveOne`)推导出的必然设计。
3. **寻址解析合并 presence 兜底**:peer 档案不存在时,presence 作为别名/会话 ID 的解析来源;歧义处理沿用现有语义。
4. **临时目录 key 派生**:`resolveProjectRoot()`(git common-dir 收敛)→ `fs.realpathSync.native`(解析符号链接/junction/大小写)→ SHA-256 短哈希作为桶名;桶内放 `project.json` 记录原始路径便于排查。已实测:从 junction 进入时 git 与 realpath 均收敛到同一物理路径。
5. **别名碰撞**:别名生成不再能在开户时对全网去重(presence-only 会话查不到 peer 全集),碰撞概率 1/1000 量级,由现有"别名歧义报错"语义覆盖。
6. **接收者档案**:投递记录本身是消息所有权根,投递给从未注册的会话时无需为其创建 peer 档案;该接收者首次注册时沿用既有的"旧投递使邮箱转持久"检测逻辑。
7. **provisional 生命周期、discardUnusedMailbox、removeIfEmpty 清理 `.pi` 父目录**的既有机制保留,语义不变。

## 连带改动

- SPEC:`Session lifecycle`、`Project scope and persistence` 两节重写;按项目规矩走 CHANGELOG + 兼容性测试。
- Web UI / `mail-status` 等读路径适配 presence 兜底来源(读逻辑,不改语义)。

## Acceptance Criteria

技术检查(自动化测试覆盖):

1. 全新项目启动一个会话、不做任何 mail 操作、退出:项目目录自始至终无 `.pi/`。
2. 全新项目两个会话 A、B:启动后 B `discover` 可见 A;B 给 A 发信后 `<project>/.pi/mails/` 存在且含消息与投递记录。
3. 未注册会话中 `/mail-status` 正常显示别名与 short id。
4. 符号链接场景:经由链接路径启动的会话与物理路径启动的会话落在同一 presence 桶,互相可见、可寻址。
5. presence TTL 过期后,陈旧会话不再出现在 discover;物理清扫不误删活跃文件。
6. 既有测试套件全绿;SPEC 中"Session lifecycle"修订与实现一致。

用户验证:

7. 用户在实际项目(含符号链接访问路径)中启动 Pi,确认项目目录在未用邮件前保持干净;真实使用邮件后功能正常。
