# dsh-feishu-lark-cli 需求文档

> 状态：需求定稿（待评审）
> 日期：2026-11-11
> 范围：DSH 插件 MVP

## 1. 背景与定位

当前 DSH 没有可直接使用的飞书个人账号插件。已有的 IM 类插件（如 DSH-IM）基于**机器人应用身份**接入，无法代表用户本人收发消息、读取文档。

官方 `@larksuite/cli`（`lark-cli`）提供个人 OAuth 能力，可覆盖消息、文档、事件等官方能力，但目前没有配套的 DSH 插件。

本插件定位：

> **以官方 `lark-cli` 为底层的飞书个人账号多账号管理插件。**
> 它是对 `lark-cli` 的上层包装，而不是覆盖或替代其能力。

因此：

- 插件不实现飞书 OpenAPI、OAuth 与消息协议；
- 插件负责多账号上下文、本地关系数据、配置入口、事件产出；
- Agent 仍可使用完整的官方能力，只是账号上下文由插件统一提供。

## 2. 目标与非目标

### 2.1 目标

1. 安装插件即完整可用，用户不需要单独安装 `lark-cli`、SQLite 依赖或 Agent Skills。
2. 扫码授权即可添加个人飞书账号，多个账号可共存、可区分、可切换。
3. 日常操作默认使用默认账号，需要时在使用处直接切换，且不改变默认账号。
4. @ 一个位置完成「选账号 + 选关系人」，产出统一的操作上下文。
5. 消息接收只做：接收 → 标准化 → 落库 → 发内部事件。
6. 用户/群等关键关系数据本地落库，@ 解析不依赖每次网络请求。
7. 支持以指定账号读取飞书文档。

### 2.2 非目标（MVP 明确不做）

- 机器人身份 / 应用身份接入；
- 机器人事件回调；
- 实时事件订阅（事实：`im.message.receive_v1` 仅支持应用/机器人身份，与个人 OAuth 定位冲突）；
- 自动回复、自动分类、QA 知识库；
- 文档编辑、文档写入；
- 联系人/群关系的全量治理后台；
- 跨账号同一人归并（`union_id` 归并）；
- 对外暴露事件总线（事件仅供本插件内部使用）；
- 多租户、多用户共享的云端管理。
- 接收状态等运行期观测的持久化（仅内存态，不建状态表）。

## 3. 依赖与交付

### 3.1 统一锁定运行栈

插件发布版本绑定完整运行栈，插件升级时整体升级：

| 组件 | 锁定方式 | 校验方式 |
| --- | --- | --- |
| `@larksuite/cli` | 固定 npm 版本（当前 `1.0.100`） | `lark-cli --version` |
| SQLite 驱动 | 固定 npm 版本（与 lockfile 一致，`package.json` 写精确版本并提交 lockfile；不使用 `^`/`~` 范围） | 加载驱动并查询引擎版本 |
| SQLite 引擎 | 随驱动固定 | `SELECT sqlite_version()` |
| 官方 Agent Skills | 随 CLI 版本（`lark-cli skills list/read` 内嵌） | 版本一致性检查 |
| 数据库 schema | 固定 schema 版本 | `schema_version` 表 |
| TypeScript 构建链 | 固定 devDependencies 版本（esbuild + typescript） | 构建产物存在且可加载 |

插件版本信息记录：

```json
{
  "pluginVersion": "0.1.0",
  "larkCliVersion": "1.0.100",
  "sqliteDriver": "<fixed>",
  "sqliteEngine": "<fixed>",
  "schemaVersion": 1
}
```

### 3.2 安装流程

```text
安装插件
  → 安装固定版本 lark-cli
  → 安装固定版本 SQLite 依赖
  → 安装官方 Agent Skills
  → 安装 DSH 集成 Skill
  → 初始化 SQLite（建表 + schema_version）
  → 启动自检（CLI / SQLite / schema）
  → 注册配置卡片
```

约束：

- 不依赖宿主机全局 `lark-cli`，不调用宿主机 `sqlite3` 命令；
- 不在插件安装时强制进入 OAuth 授权（授权与安装解耦）；
- 自检失败时插件进入「能力不可用」状态并给出明确原因，不静默降级。

### 3.3 源码语言与构建产物

| 项 | 约定 |
| --- | --- |
| 源码语言 | TypeScript（`src/`），数据模型、事件契约、lark-cli 结果均使用强类型 |
| 构建 | esbuild 打包为 ESM（与 DSH-IM 一致），`tsc --emitDeclarationOnly` 产出 `.d.ts` |
| 发布产物 | `lib/index.js`（ESM）、`lib/client.js`（设置页）、`lib/types/*.d.ts` |
| 包声明 | `type: module`，`main` 指向 `lib/index.js`，`files` 包含 `lib`、`cordis.patch.yml`、`locale` |
| 类型依赖 | `@larksuiteoapi/node-sdk` 等第三方包按需引入并使用其自带类型，不复制枚举 |
| 测试 | `node --test`（对编译产物）+ 类型检查 `tsc --noEmit` |

理由：官方插件与 DSH-IM 的发布物均为打包后的 ESM JavaScript，TS 只在构建期存在；采用 TS 可获得数据模型与契约的类型安全，且不改变宿主兼容形态。

### 3.4 Agent 能力分层

```text
官方能力层：lark-shared / lark-im / lark-doc / lark-event / lark-contact ...
DSH 集成层：账号上下文规则、固定版本调用入口、MVP 能力边界
```

DSH 集成层必须向 Agent 声明：

- 默认账号优先，未指定时不得擅自切换默认账号；
- 页面临时账号只作用于当前上下文；
- @ 解析范围限定为「所选账号可见的关系」；
- 不用于机器人/应用身份场景。

## 4. 账号模型

### 4.1 添加账号

```text
点击「添加账号」
  → 启动 lark-cli OAuth（qrcode / device flow）
  → 用户扫码确认
  → 读取授权结果
  → 获取个人身份（姓名、头像、机构）
  → 建立 lark-cli profile
  → 写入 account 表
  → 若为第一个账号，自动设为默认账号
  → 触发一次关系同步
```

约束：

- 不要求用户填写别名、租户、用户 ID 或 profile 名；
- 展示信息全部以飞书返回为准；
- 凭证由 `lark-cli` 管理，插件不落库 token。

### 4.2 账号列表

配置卡片首屏仅展示账号列表与接收状态：

```text
头像  张三 · 某某科技      默认    定时接收
头像  张三 · 另一家公司             已暂停
头像  李四 · 某某科技               定时接收
```

行内操作：`设为默认`、`开启/关闭接收`、`移除`、`重新授权`。

接收方式 MVP 只有「定时接收」一种，配置卡片不出现模式切换控件。

不展示：授权 scope、最近消息时间、连接错误详情、账号别名。

### 4.3 账号上下文优先级

```text
本次 @ 面板 / 操作显式选择
  > 当前页面临时账号
  > 全局默认账号
```

- 页面临时切换只作用于当前页面/本次操作；
- 不修改 `account.is_default`；
- 默认账号只能在配置卡片中修改；
- 只有一个账号时自动为默认账号。

## 5. @ 操作上下文

### 5.1 交互模型

`@` 一个入口完成两级选择：

```text
输入 @
  → 候选面板
      ├─ 账号切换行：张三 · 某某科技（当前默认） ▼
      └─ 关系人列表（按所选账号过滤）
           李四 · 某某科技 · 用户
           王五 · 某某科技 · 用户
           研发群 · 某某科技 · 群
```

- 打开面板默认使用「页面账号 → 默认账号」的关系人；
- 在面板中切换账号，关系人列表立即按新账号重新加载；
- 面板中切换账号只影响本次操作，关闭后不保留、不修改默认账号。

### 5.2 解析规则

```text
1. 确定操作账号（操作显式 > 页面 > 默认）
2. 以该账号过滤本地 contact / chat
3. 匹配 @ 输入
     0 个命中：提示无匹配（可选触发一次飞书检索并补录）
     1 个命中：直接使用
     多个命中：展示候选（姓名 · 机构 · 类型）
```

约束：

- `@` 只选择「关系人 / 群」，不承担账号语义；
- 关系范围限定为**该账号可见的关系**，不做全局联系人；
- 换账号后必须重新解析并校验可见性，不可见则明确提示，不得直接发送。

### 5.3 产出的操作上下文

```json
{
  "accountId": "...",
  "accountLabel": "张三 · 某某科技",
  "target": {
    "type": "user",
    "openId": "ou_...",
    "name": "李四",
    "tenantName": "某某科技"
  }
}
```

后续能力（发送消息、查询对话、读取文档）统一消费该上下文，不再重复解析。

执行边界（与操作动作一一对应，避免固定账号语义与动作冲突）：

| 动作 | 使用账号 | 使用 target |
| --- | --- | --- |
| 发送消息 / 查看与关系人的最近对话 | 上下文账号 | 上下文 target |
| 读取文档 | 上下文账号 | 无（文档 token 由用户提供，不使用 @ 目标） |
| 切换账号 | 新选择的账号 | 重新解析，不复用旧 target |

`@李四` 产出的 target 只对「与该关系人交互」的动作有效；需要读取文档时，账号从当前上下文取，目标改为显式文档 token/URL。

### 5.4 面板可提供的动作

```text
@李四 ▾
  ├─ 发送消息
  ├─ 查看最近对话
  ├─ 切换账号 → 重新解析关系人
  └─ 读取文档（目标改为显式文档 token/URL，不再沿用 @ 目标）
```

## 6. 关系数据与同步

### 6.1 落库原则

- 关键关系数据（账号、用户、群、群成员、消息、游标）全部落 SQLite；
- @ 解析、消息展示优先读本地库，不依赖每次网络请求；
- 本地库不是飞书权威数据源，必须支持从飞书重新同步校正；
- 所有关系数据按 `account_id` 隔离。

### 6.2 同步时机

| 时机 | 行为 |
| --- | --- |
| 账号授权成功 | 立即执行一次当前账号关系同步 |
| 接收消息 | 遇到未知发送人 / 群时按需补录 |
| 手动刷新 | 用户触发重新同步 |
| 低频校准 | 可配置的长周期全量校准（默认关闭或长周期） |

同步失败不得影响已有本地数据可用性，仅标记 `last_synced_at` 与同步状态。

### 6.3 数据模型

```sql
account(
  -- 由本项目 SQLite 插件自行建表，不受 sql-guidelines 中「InnoDB/utf8mb4/COMMENT」等 MySQL 条款约束
  id, open_id, union_id, name, avatar_url,
  tenant_key, tenant_name,
  lark_cli_profile,
  is_default, receive_enabled, receive_mode,   -- receive_mode: polling|disabled
  auth_status,                                 -- authorized|expired|revoked
  authorized_at, synced_at,
  created_at, updated_at
)

contact(
  id, account_id, open_id, union_id,
  name, en_name, avatar_url,
  department, tenant_key, tenant_name,
  email, mobile,
  source,            -- sync | message | lookup
  last_synced_at,
  UNIQUE(account_id, open_id)
)

chat(
  id, account_id, chat_id, name, description,
  chat_type, owner_open_id, member_count,
  last_synced_at,
  UNIQUE(account_id, chat_id)
)

chat_member(
  id, account_id, chat_id, open_id, member_type,
  UNIQUE(account_id, chat_id, open_id)
)

message(
  id, account_id, message_id, chat_id, chat_type,
  sender_open_id, message_type, content,        -- content: 已规范化的消息正文，非结构化查询字段
  root_id, parent_id, thread_id,
  create_time,                                  -- 业务时间，飞书消息发生时间
  source,                                       -- 来源标记：polling|sent
  created_at,                                   -- 数据库写入时间
  UNIQUE(account_id, message_id)
)

receive_cursor(
  id, account_id, chat_id,
  cursor,                                       -- 下次拉取的起始位置（已归一化为未来可处理位置）
  last_sync_time,
  UNIQUE(account_id, chat_id)
)

schema_version(version, applied_at)
```

数据层边界（实现时必须遵守，避免照搬 MySQL 项目规则到 SQLite）：

- 本库是 SQLite，`sql-guidelines.md` 中 `sql.table.storage-format`（InnoDB/utf8mb4/COLLATE）、`sql.file.ddl-data-separation`、`sql.seed.*`、`sql.code.cross-environment-stability` 不适用；不得为了「对齐规则」给 SQLite 表加 MySQL 引擎或字符集声明；
- 仍适用的语义类规则：`sql.index.database-uniqueness`、`sql.field.semantic-definition`、`sql.field.nullability-and-index-order`、`sql.field.business-time-semantics`；
- 字段语义以本文档 6.3 的列注释（`--` 行尾说明）作为定义来源，迁移脚本中同步保留同名注释，保证字段含义不靠记忆传递；
- 布尔字段（`is_default`、`receive_enabled`）固定 `INTEGER NOT NULL DEFAULT 0`，取值含义为 0=否、1=是，不允许 NULL；
- 文字主键一律使用飞书返回的字符串 ID，不使用自增整数作为对外标识。

约束：

- 身份统一用 `(account_id, open_id)`，同名不冲突；
- `open_id` 按应用隔离，不得跨账号假设同一人；
- 机构信息仅用于展示与区分。

## 7. 消息接收

### 7.1 职责边界

```text
接收 → 标准化 → 落库 → 发内部事件
```

接收模块**只做这四件事**，不包含任何业务处理。

### 7.2 接收方式（唯一方案：定时拉取）

| 状态 | 说明 |
| --- | --- |
| 定时拉取（默认，唯一实现） | 按 `receive_cursor` 周期拉取消息历史 |
| 已暂停 | 用户关闭接收，不拉取 |

**为什么没有实时接收**（事实依据，非产品取舍）：

- 飞书接收消息事件 `im.message.receive_v1` 是**应用级事件**，官方文档要求「应用需开启机器人能力」并「在应用中配置事件订阅」，接收方是应用/机器人，不是某个扫码授权的个人账号；
- `lark-cli event list` 中该事件声明的 AuthTypes 只有 `bot`，`event consume --help` 明确 `--as` 必须匹配事件声明的身份；
- 与「只使用个人 OAuth 身份、不引入机器人/应用」的定位直接冲突。

因此实时接收在 MVP 及可预见范围内**不实现**，不是预留能力。

约束：

- 配置卡片不出现「实时接收」入口，不出现模式切换控件；
- `account.receive_mode` 只使用 `polling` / `disabled` 两个取值，不预留 `websocket`；
- 定时拉取参数（间隔、回溯窗口）使用固定默认值，不暴露给用户配置；
- 消息只经这一个入口写入 `message` 表，用 `(account_id, message_id)` 唯一约束去重。

### 7.2.0 用户身份拉取接口的官方约束

依据飞书官方 [获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)：

- 接口支持 `user_access_token`（官方明确「Obtain messages as the user」分支）；
- 需要的 scope（全部为用户授权 scope）：
  - `im:message` 或 `im:message:readonly`（任一）
  - 单聊额外：`im:message.p2p_msg:get_as_user`
  - 群聊额外：`im:message.group_msg:get_as_user`
- 分页：`page_size` 上限 50；
- 时间参数 `start_time` / `end_time` 精度为**秒**；
- 分页过程中 `sort_type` 不可切换，拉取固定 `ByCreateTimeAsc`。

必须处理的已知错误码：

| 错误码 | 含义 | 插件处理 |
| --- | --- | --- |
| `231203` | 会话类型不支持（如保密模式群禁止读取） | 跳过该会话并记录，不中断整轮 |
| `231204` | 应用开启外部共享或关联组织时，不支持以用户身份调此接口 | **阻塞级**：安装自检时报错，提示改用其他应用授权 |
| `230027` | 缺少权限 | 提示缺的具体 scope，引导重新授权 |
| `230073` | 会话对当前操作者不可见 | 跳过并记录 |

会话枚举方式：`im +chat-list --types=p2p,group --as user`（`p2p` 明确要求用户身份）。

### 7.2.1 接收运行态（内部实现，不落库、不对外）

配置卡片需要展示每个账号「当前是否在正常拉取」，但这属于运行期观测，不是业务状态：

```text
idle     → 未启用接收（receive_enabled = 0）
running  → 拉取循环正常
failed   → 最近一轮失败且重试次数达到阈值
```

约束：

- 运行态只存在于内存，进程重启后由拉取任务重新计算，**不建状态表、不写数据库**；
- 不为接收引入业务生命周期状态机：MVP 没有「处理中 / 待确认 / 已完成」这类可用于下游消费的中间态；
- 后续业务（自动回复、通知等）需要的生命周期状态由各自业务模块自行建模，不反向污染接收模块。

### 7.2.2 定时拉取游标推进

- `receive_cursor.cursor` 表示**下次拉取的起始位置**，处理完成后推进到已处理消息之后，不保留已过期位置；
- 拉取必须按时间窗口向后推进，并在无新消息时保持游标不动（不得回退到更早位置，避免重复命中）；
- 单轮拉取失败不推进游标，下一轮从同一位置重试；
- 游标推进与消息落库在同一事务内完成，避免「消息已入库但游标未推进」或反之；
- 游标只允许单调向前，出现回退视为数据异常并记录告警，不静默覆盖。

### 7.2.3 接收并发与幂等

- 同一账号同一时刻只允许一个拉取任务实例；
- 写入路径以 `(account_id, message_id)` 唯一约束为准：冲突即为重复投递，跳过写入且**不重复发事件**；
- 事件只在「首次成功写入」后发出，事件发出后不因后续重复投递再次发出。

### 7.3 事件

内部事件（MVP 仅本插件可用，不注册到 DSH 全局总线）：

```json
{
  "event": "feishu.message.received",
  "accountId": "...",
  "messageId": "...",
  "chatId": "...",
  "chatType": "p2p",
  "senderOpenId": "...",
  "messageType": "text",
  "createTime": "...",
  "source": "polling"
}
```

后续自动回复、通知、AI 分类等均作为**内部订阅者**接入，不改动接收模块。

事件契约约束：

- 事件在消息事务提交之后发出，不得在事务内同步派发订阅者，避免订阅者异常回滚接收结果；
- 事件携带的字段为落库后的最终值，订阅者不需要再回查即可定位消息；
- `source` 取值为来源标记：MVP 固定 `polling`（发送产生的记录为 `sent`）；`source` 不参与去重判断。

### 7.4 明确不做

自动回复、AI 分类、消息归并、业务路由、已读状态、通知决策。

## 8. 消息发送

```text
操作上下文（账号 + 目标）
  → 发送上下文卡片确认
       发送账号：张三 · 某某科技  ▼
       接收对象：李四 · 某某科技（用户）
       内容：会议改到三点
  → lark-cli --profile <profile> im +messages-send ...
  → 解析 JSON 结果
  → 返回成功/失败
```

约束：

- 发送账号默认取操作上下文，可在卡片内切换（仅本次）；
- 同名接收人必须展示机构；
- 发送失败需返回可读错误（权限不足、目标不可达、token 失效等）。

### 8.1 发送结果状态

发送链路存在「已提交但结果未知」的中间态（网络中断、超时、CLI 非零退出但服务端已受理），必须显式区分：

```text
submitted → sending → sent / failed / unknown
```

- `sent`：CLI 返回 `ok=true`，记录 `message_id`；
- `failed`：明确失败（权限、目标不可达、参数非法），可安全重试；
- `unknown`：超时或连接中断，**不得自动重发**，只提示用户「可能已发送，请确认」，并由用户决定是否重试；
- 重试一律携带幂等键，同一逻辑发送不得产生重复消息。

### 8.2 发送失败语义

- 权限不足：明确提示缺少的 scope 与需要重新授权的账号；
- 目标不可达（不在当前账号可见关系内）：提示改用其他账号或重新解析 @；
- token 失效：标记该账号 `auth_status=expired`，配置卡片显示需重新授权，不影响其他账号；
- 不得把底层异常原样抛给用户，也不得把「已受理未知」伪装成失败。

## 9. 文档读取

```text
识别文档 token / URL
  → 使用操作上下文账号（无则页面账号、默认账号）
  → lark-cli --profile <profile> docs +fetch ...
  → 返回文档内容
```

MVP 只读：读取文档、搜索文档。不做写入。

## 10. 配置页面

插件在 DSH 设置中提供一个独立卡片（参照 DSH-IM 形态）：

```text
飞书个人账号
├─ 账号列表（姓名 · 机构 | 默认 | 接收状态）
├─ 添加账号
├─ 设为默认 / 开启关闭接收
├─ 移除 / 重新授权
└─ 依赖自检状态（仅在异常时提示）
```

### 10.1 依赖缺失态

```text
飞书个人账号
未检测到官方 lark-cli，暂时无法使用飞书个人账号能力。
[重新安装依赖]
```

正常状态下不展示依赖信息，避免污染首屏。

## 11. 能力核查结论与待验证项

### 11.1 已完成的能力核查（依据 CLI 实机输出 + 飞书官方文档）

| 能力 | 命令 | 用户身份 | 结论 |
| --- | --- | --- | --- |
| 扫码授权 | `auth login` / `auth qrcode` | user | 支持 |
| 多账号隔离 | `--profile` / `profile add,list` | user | 支持 |
| 发送/回复消息 | `im +messages-send` / `+messages-reply` | `--as user` | 支持 |
| 会话列表（含单聊） | `im +chat-list --types=p2p,group` | user（p2p 仅用户） | 支持 |
| 历史消息拉取 | `im +chat-messages-list` | user（官方「Obtain messages as the user」） | 支持 |
| 消息搜索 / 批量取 | `im +messages-search` / `+messages-mget` | user | 支持 |
| 群搜索 | `im +chat-search` | user | 支持 |
| 用户搜索 | `contact +search-user` | user（仅用户） | 支持 |
| 当前用户信息 | `contact +get-user` | user | 支持 |
| 文档读取 | `docs +fetch` | `--as user` | 支持 |
| 文档搜索 | `docs +search` | user（仅用户） | 支持 |
| 实时接收消息事件 | `event consume im.message.receive_v1` | **仅 bot** | **不支持** |

### 11.2 待验证项（阶段 0 实机验证）

MVP 必需（阻塞实现）：

1. **用户身份拉取历史消息是否可用**：`im +chat-list --types=p2p,group --as user`、`im +chat-messages-list --as user`，重点确认是否出现 `231204`（应用开启外部共享/关联组织时用户身份不可用）；
2. 上述两项所需 scope 是否已在授权中：`im:message` 或 `im:message:readonly` + `im:message.p2p_msg:get_as_user` + `im:message.group_msg:get_as_user`；
3. `docs +fetch` 与 `contact +search-user` 所需 scope；
4. SQLite 驱动在 DSH 运行环境（Linux x64 / 当前 Node 版本）的可用性与持久化方式；
5. `--profile` 在 `im` / `docs` / `contact` 命令上的多账号隔离是否成立。

### 11.3 已因事实排除的选项

- 实时事件订阅：不作为「后续扩展」保留，若未来需要，必须引入应用/机器人身份，属于与本项目定位不同的接入形态。

## 12. 验收标准

1. 安装插件后无需任何额外手动安装，配置卡片可用；
2. 扫码可添加 ≥2 个个人账号，列表正确展示姓名与机构；
3. 同名不同机构账号可区分；默认账号可切换；
4. 页面临时切换账号不改变默认账号，且离开页面后恢复默认；
5. @ 面板可按账号过滤关系人，选中后产出正确操作上下文；
6. 使用指定账号发送单聊消息成功，发送前展示发送账号与接收对象；
7. 定时拉取可将消息落库并去重（重复拉取不重复入库、不重复发事件），暂停后不再拉取；
8. 使用指定账号读取飞书文档成功；
9. 依赖版本不一致或自检失败时，插件明确报错且不静默运行。
