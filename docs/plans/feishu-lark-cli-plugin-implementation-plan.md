# dsh-feishu-lark-cli 实施计划

> 依赖文档：`docs/requirements/feishu-lark-cli-plugin-requirements.md`
> 状态：待评审
> 日期：2026-11-11

## 0. 总体策略

原则：

1. **先验证后实现**：第 0 阶段完成能力验证，结论回填文档后才进入编码；
2. **薄封装**：所有飞书调用统一经 `lark-cli`，不自研 API 层；
3. **账号上下文单一入口**：所有能力从 `OperationContext` 取账号，禁止隐式全局状态；
4. **接收模块只做四件事**：接收、标准化、落库、发事件；
5. **每阶段可独立验证**，阶段之间不并行改写同一模块。

分层结构：

```text
plugin/
├── installer/          固定依赖安装与自检
├── cli/                lark-cli 执行层（进程调用、JSON 解析、profile 绑定、错误归一化）
├── db/                 SQLite 连接、迁移、仓储
├── account/            账号服务（授权、列表、默认账号、上下文）
├── relation/           关系同步与 @ 解析
├── message/            发送、接收（定时拉取）、落库、事件
├── doc/                文档读取
├── settings/           配置卡片
├── events/             内部事件总线
└── skills/             官方 Skills + DSH 集成 Skill
```

工程约定（源码 TypeScript，发布产物 ESM JavaScript；与 DSH-IM、官方插件产物形态一致）：

| 项 | 约定 | 证据 |
| --- | --- | --- |
| 源码语言 | TypeScript（`src/host`、`src/client`） | 用户决策；数据模型与契约需类型约束 |
| 构建 | esbuild 打包 ESM + `tsc --emitDeclarationOnly` 产出 `.d.ts` | `@xmanrui/dsh-im` 使用 esbuild 0.25.9 打包 `lib/index.js` |
| 产物 | `lib/index.js`、`lib/client.js`、`lib/types/*.d.ts` | 官方 `dsh-experimental-worktree` 提供 `lib/index.js` + `lib/types` |
| 模块格式 | `"type": "module"`，`main` 指向产物 | 官方插件与 DSH-IM 一致 |
| 双端拆分 | `host/`（宿主）+ `client/`（Web 设置页）+ `cordis.patch.yml` | `@xmanrui/dsh-im` 的 `dsh.bundle.patch` / `dsh.client.inject` |
| 配置卡片 | 走 `@deepseek-ai/dsh-client-ui-settings-plugins` 设置槽 | 同 DSH-IM |
| 测试 | `node --test`（对构建产物 `.test.mjs`），另跑 `tsc --noEmit` | DSH-IM `scripts.test` |
| 静态检查 | `tsc --noEmit` + `node --check lib/*.js` | DSH-IM `scripts.check` |
| 依赖版本 | `dependencies` 写精确版本，`peerDependencies` 才用 `^` | DSH-IM `qrcode: 1.5.4`、`undici: 7.30.1` |
| 打包 | 标准 DSH 插件 tarball，不使用源码 `link:` | 用户既有要求 |

补充约定：

- TypeScript 严格模式开启（`strict: true`），禁止 `any` 逃逸到对外契约；
- 对外契约（`OperationContext`、事件、lark-cli 结果）必须有显式类型导出，供设置页与 Agent 使用；
- 不使用整体命名空间导入，只导入实际使用的导出；
- 构建脚本放在 `scripts/`，`prepack` 触发构建，避免发布未编译源码。

## 阶段 0：能力验证（阻塞后续所有实现）

### 已知结论（2026-11-11 已核查，无需重复验证）

- `im.message.receive_v1` 仅支持 `bot` 身份 → 实时接收入口不实现；
- `im +chat-messages-list` 支持 `user_access_token`（官方文档「Obtain messages as the user」）；
- `im +messages-send` / `+messages-reply` / `docs +fetch` 支持 `--as user`；
- `contact +search-user` / `docs +search` 仅支持用户身份（正好符合本项目）。

### 待验证任务

| 编号 | 内容 | 产出 |
| --- | --- | --- |
| 0.1 | 安装 `@larksuite/cli@1.0.100` 到插件运行目录，确认版本与命令面 | 版本与命令清单 |
| 0.2 | 个人 OAuth 授权一个账号，确认 `auth list` / `whoami` 输出可用于账号识别 | 身份字段清单 |
| 0.3 | `--profile` 与 `im` / `docs` / `contact` 命令组合的多账号隔离是否成立 | profile 映射方案 |
| 0.4 | **用户身份拉取消息**：`im +chat-list --types=p2p,group --as user`、`im +chat-messages-list --as user`；重点确认是否返回 `231204` | 拉取可行性结论 |
| 0.5 | scope 校验：`im:message` 或 `im:message:readonly`、`im:message.p2p_msg:get_as_user`、`im:message.group_msg:get_as_user`、文档与联系人所需 scope | scope 清单 |
| 0.6 | `im +chat-messages-list` 分页与时间过滤实测（page_size 上限 50、时间为秒、sort_type 不可切换） | 拉取参数基线 |
| 0.7 | SQLite 驱动在目标环境（Linux x64 / Node 22）可加载，`sqlite_version()` 可读 | 驱动选型结论 |

### 验收

- 待验证项全部有明确结论（支持 / 不支持 / 降级方案）；
- 若 0.4 返回 `231204`，必须在文档中记录并给出「改用可授权的应用」处置建议，不得静默跳过。

### 风险

- `231204`：应用开启外部共享或关联组织时用户身份无法读消息 → 阻塞级，需更换应用授权；
- `231203`：部分会话（保密模式群）不可读 → 按会话跳过，不中断整轮。

## 阶段 1：工程骨架与依赖安装

| 编号 | 内容 |
| --- | --- |
| 1.1 | 初始化 TS 工程：`package.json`（`type: module`）、`tsconfig.json`（strict）、esbuild 构建脚本 |
| 1.2 | 固定版本依赖：`@larksuite/cli`、SQLite 驱动，写入 lockfile |
| 1.3 | 安装器：按平台准备依赖，失败可回滚 |
| 1.4 | 启动自检：CLI 版本、SQLite 引擎版本、schema 版本 |
| 1.5 | 自检失败态：能力不可用 + 明确原因，不静默运行 |

验收：全新环境安装插件后，自检通过并输出版本信息；人为降级 CLI 版本时自检失败并给出原因。

## 阶段 2：数据层

| 编号 | 内容 |
| --- | --- |
| 2.1 | 迁移框架：`schema_version` 表，顺序迁移，事务包裹，可重复执行 |
| 2.2 | 建表：`account` / `contact` / `chat` / `chat_member` / `message` / `receive_cursor` |
| 2.3 | 仓储层：按 `account_id` 隔离的查询接口 |
| 2.4 | 迁移测试：空库初始化、重复执行幂等、升级不丢数据 |
| 2.5 | 索引与唯一约束：`(account_id, open_id)`、`(account_id, chat_id)`、`(account_id, message_id)` 等按查询路径建立 |
| 2.6 | 字段语义落地：布尔字段固定 `INTEGER NOT NULL DEFAULT 0`，所有字段在迁移脚本中保留与需求文档 6.3 一致的语义注释 |

数据层注意：本项目为 SQLite，需求文档 6.3 已声明 `sql-guidelines.md` 中 InnoDB/utf8mb4/COLLATE、种子数据、跨环境稳定性等条款不适用；不得为「对齐 MySQL 规则」引入引擎声明或字符集声明。

验收：空库可初始化；重复执行迁移无副作用；升级保留账号与消息数据。

## 阶段 3：lark-cli 执行层

| 编号 | 内容 |
| --- | --- |
| 3.1 | 进程调用封装：固定 CLI 路径、超时、取消、并发限制 |
| 3.2 | profile 绑定：每账号映射一个 profile，调用时显式传入，不修改全局 profile |
| 3.3 | JSON 契约：按 `ok` 判定成功，`error` 归一化为内部错误类型 |
| 3.4 | 分页封装：`--page-all` / 游标翻页 |
| 3.5 | 错误分类：权限不足、token 失效、目标不可达、限流、网络失败 |

验收：单元测试覆盖成功/失败/超时/分页；错误分类可映射到用户可读文案。

## 阶段 4：账号服务

| 编号 | 内容 |
| --- | --- |
| 4.1 | 授权流程：启动 `auth login`（qrcode/device flow），等待完成后读取身份 |
| 4.2 | 身份落库：写 `account`，建立 profile 映射，首个账号自动设为默认 |
| 4.3 | 账号列表与状态读取 |
| 4.4 | 默认账号设置（唯一约束，切换为事务内先清后设） |
| 4.5 | 移除账号 / 重新授权 |
| 4.6 | `OperationContext`：操作 > 页面 > 默认的解析规则 |

验收：可添加 ≥2 账号；同名不同机构可区分；默认账号唯一；页面切换不影响默认账号。

## 阶段 5：关系同步与 @ 解析

| 编号 | 内容 |
| --- | --- |
| 5.1 | 授权成功后触发首次同步：联系人、群、群成员 |
| 5.2 | 增量补录：消息中出现未知发送人/群时写 `contact` / `chat` |
| 5.3 | 手动刷新同步入口 |
| 5.4 | @ 解析：按 `account_id` 本地匹配 name / en_name，0/1/多 命中分支 |
| 5.5 | 多命中候选返回：姓名 · 机构 · 类型 |
| 5.6 | 切账号后重新校验可见性，不可见明确提示 |
| 5.7 | 产出 `OperationContext` 结构并落为共享类型 |

验收：@ 解析不发网络请求即可完成；多命中正确展示候选；跨账号不可见时拒绝执行。

## 阶段 6：消息发送

| 编号 | 内容 |
| --- | --- |
| 6.1 | 发送上下文卡片：发送账号（可切）、接收对象（含机构）、内容 |
| 6.2 | 调用 `im +messages-send`，携带 profile 与幂等键 |
| 6.3 | 结果处理：成功回执、失败分类提示 |
| 6.4 | 发送记录写入 `message`（来源标记为 `sent`） |
| 6.5 | 发送状态机：`submitted/sending/sent/failed/unknown`，`unknown` 不得自动重发 |
| 6.6 | 失败语义映射：权限不足 / 目标不可达 / token 失效（标记账号 `auth_status=expired`） |

验收：指定账号可发送单聊消息；切换发送账号仅影响本次；同名接收人展示机构避免误发；超时场景只提示「可能已发送」且不自动重发。

## 阶段 7：消息接收

| 编号 | 内容 |
| --- | --- |
| 7.1 | 接收实现：仅定时拉取（保留接收接口抽象，便于后续扩展） |
| 7.2 | 拉取循环：启动、停止、失败重试、进程内单实例 |
| 7.3 | 定时拉取：`chat-list` 枚举会话 + `chat-messages-list` 增量拉取，按 `receive_cursor` 推进 |
| 7.4 | 标准化：统一为内部消息结构 |
| 7.5 | 落库：`(account_id, message_id)` 去重（重复接收不重复入库、不重复发事件） |
| 7.6 | 内部事件：`feishu.message.received`，仅插件内可订阅；事务提交后发出 |
| 7.7 | 账号级接收开关（定时 / 暂停），关闭前先停拉取任务 |
| 7.8 | 运行态（内存）：`idle/running/failed`，仅用于卡片展示，不落库 |
| 7.9 | 游标单调推进：失败不推进、无新消息不推进、推进与落库同事务 |

验收：定时拉取可落库；重复消息不重复入库且不重复发事件；暂停后不再拉取；事件只在插件内可消费；拉取失败重试且不推进游标；游标回退被拒绝并记录告警。

## 阶段 8：文档读取

| 编号 | 内容 |
| --- | --- |
| 8.1 | 文档 token / URL 解析 |
| 8.2 | `docs +fetch` 调用与内容返回 |
| 8.3 | 文档搜索 |
| 8.4 | 权限错误提示 |

验收：使用指定账号读取与搜索文档成功；无权限时提示明确。

## 阶段 9：配置卡片

| 编号 | 内容 |
| --- | --- |
| 9.1 | 卡片骨架：账号列表 + 接收状态 |
| 9.2 | 添加账号（OAuth 流程状态：等待扫码 / 成功 / 失败） |
| 9.3 | 行内操作：设为默认、接收开关、模式切换、移除、重新授权 |
| 9.4 | 依赖自检异常态展示 |
| 9.5 | 卡片随接收运行态刷新（内存态变更推送） |

验收：首屏仅含账号列表与接收状态；授权完成后列表自动刷新；异常态可操作。

## 阶段 10：Skills 与 Agent 集成

| 编号 | 内容 |
| --- | --- |
| 10.1 | 安装官方 Skills（`lark-shared` / `lark-im` / `lark-doc` / `lark-contact`） |
| 10.2 | 编写 DSH 集成 Skill：账号上下文规则、调用入口、MVP 边界、禁止事项 |
| 10.3 | Agent 调用验证：默认账号发送、@ 上下文发送、指定账号读文档 |

验收：Agent 能按 Skill 规则使用默认账号；不擅自切换默认账号；不越界使用机器人身份。

## 阶段 11：端到端验收与发布

| 编号 | 内容 |
| --- | --- |
| 11.1 | 全量回归：需求文档第 12 章验收标准逐条验证 |
| 11.2 | 版本一致性：pluginVersion / larkCliVersion / sqlite / schema 记录 |
| 11.3 | 打包为标准 DSH 插件（tarball + bundle 声明），不使用源码 `link:` |
| 11.4 | 安装/卸载可逆验证 |
| 11.5 | 文档更新：README、使用说明、故障排查 |
| 11.6 | `npm run check`（`node --check` 覆盖全部入口文件）通过 |
| 11.7 | `git diff --check` 通过，确认无空白/冲突标记；验证阶段不产生提交 |

## 里程碑

| 里程碑 | 阶段 | 可交付 |
| --- | --- | --- |
| M0 | 0 | 能力验证结论（定时拉取接口、scope、SQLite 驱动、profile 隔离） |
| M1 | 1-2 | 可安装、可自检、数据层可用 |
| M2 | 3-4 | 多账号授权与切换可用 |
| M3 | 5-6 | @ 解析可用、可发送消息 |
| M4 | 7 | 可接收消息落库并发事件 |
| M5 | 8-9 | 文档读取、配置卡片完整 |
| M6 | 10-11 | Agent 可用、打包发布 |

## 测试策略

| 层级 | 覆盖 |
| --- | --- |
| 单元测试 | 迁移、仓储、@ 解析规则、上下文优先级、错误归一化 |
| 集成测试 | lark-cli 执行层（mock 进程输出）、接收去重、事件发布 |
| 真实环境测试 | 个人账号授权、发送、接收（定时）、文档读取 |
| 回归测试 | 同名账号区分、跨账号不可见、依赖版本不一致 |

真实环境测试要求：

- 至少两个不同机构的个人账号；
- 接收只验证定时拉取与暂停；
- 消息发送需使用测试会话，不在真实群做刷屏验证。

## 主要风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 定时拉取延迟较高 | 消息非实时 | 客观限制：实时事件仅支持 bot 身份，与个人 OAuth 定位冲突；如未来需要，属于另一种接入形态 |
| native SQLite 驱动在目标环境不可用 | 数据层阻塞 | 改用 WASM 版 SQLite，锁定版本并校验 |
| lark-cli 版本升级导致行为变化 | 命令/输出不一致 | 固定版本 + 自检，升级随插件整体发布 |
| `open_id` 按应用隔离 | 跨账号无法归并同一人 | MVP 不做归并，按账号隔离解析 |
| 多账号并发调用 CLI | 进程与限流问题 | 执行层做并发限制与排队 |
| 定时拉取重复/漏取 | 消息重复或缺失 | 唯一约束去重 + 游标推进持久化 |

## 决策记录（本轮已确认）

1. 走插件体系，不单独做 lark-cli 管理工具；
2. 只使用个人 OAuth 身份，机器人/应用身份为后续扩展；
3. 默认账号优先，页面临时切换不影响默认账号；
4. 添加账号无需别名，以飞书返回数据为准；
5. 配置卡片首屏只展示账号列表与接收状态；
6. 关系数据落 SQLite，@ 解析不依赖每次网络请求；
7. `@` 一个入口完成「选账号 + 选关系人」，产出统一操作上下文；
8. 接收模块只做接收、标准化、落库、发事件；
9. 事件仅插件内部使用；
10. 固定版本整体交付 lark-cli + SQLite + Skills；
11. 源码使用 TypeScript，发布产物为 ESM JavaScript + `.d.ts`；
12. MVP 接收只有定时拉取；实时事件仅支持 bot 身份（事实），不预留 UI 与字段取值；
13. 接收运行态只在内存，不建状态表、不对外建模生命周期。
