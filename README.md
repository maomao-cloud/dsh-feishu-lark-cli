# dsh-feishu-lark-cli

基于官方 `@larksuite/cli` 的 DSH 飞书个人账号插件：薄封装官方 CLI，负责多账号上下文、本地关系数据与设置页，不替代 CLI 能力。

## 能力范围（MVP）

- 个人 OAuth 多账号与 profile 隔离
- 默认账号优先；页面/操作临时切换只影响当前上下文
- 本地 SQLite 保存账号、用户、群、群成员、消息与接收游标
- `@` 按「当前账号可见的关系」解析用户/群
- 用户身份定时拉取消息 → 落库去重 → 发插件内部事件
- 用户身份发送/回复消息
- 用户身份读取与搜索文档

**未实现**：实时消息接收。飞书 `im.message.receive_v1` 仅支持应用/机器人身份（`lark-cli event list` 中该事件 AuthTypes 为 `bot`），与「只用个人 OAuth」的定位冲突。

## 面向 Agent 的工具

| 工具 | 用途 |
| --- | --- |
| `feishu_accounts` | 列出账号与默认/接收状态 |
| `feishu_resolve_mention` | 按当前账号可见关系解析 @ 目标 |
| `feishu_send_message` | 发送消息（user / chat / mention） |
| `feishu_read_document` | 读取文档正文或大纲 |
| `feishu_search_documents` | 搜索文档 / Wiki / 表格 |

账号解析优先级：显式 `accountId` > 默认账号。工具不会擅自切换默认账号。

## 设置页

DSH 设置中提供独立入口 **`feishu-lark-cli`**，首屏只有账号列表与接收状态：

- 添加账号 / 刷新
- 设为默认 / 暂停或开启接收 / 移除

## 架构

```text
src/host/
  cli.ts           lark-cli 执行层（自带 CLI 解析、超时、--format 白名单、错误归一化）
  db.ts            SQLite 建表与消息落库
  accounts.ts      账号目录（默认账号、接收开关、移除补选）
  account-rpc.ts   设置页使用的账号管理 RPC
  relation.ts      @ 关系解析（按 account_id 隔离）
  message.ts       会话/消息/文档调用、标准化、去重、事件、轮询接收器
  tools.ts         注册给 Agent 的飞书工具
  index.ts         服务装配
src/client/index.tsx  设置页（DSH settings.section）
```

数据目录：`$DSH_HOME/integrations/dsh-feishu-lark-cli/feishu.db`，可用 `DSH_FEISHU_LARK_CLI_DATA` 覆盖。

## 开发

```bash
npm install
npm run check   # esbuild 构建 + tsc --noEmit + node --check
npm test        # node --test
npm pack
```

发布包包含构建后的 `lib/`、Skills 与 DSH bundle 声明；`@larksuite/cli`、`better-sqlite3`、TypeScript/esbuild 均由 lockfile 固定版本。

## 首次使用

插件自带固定版本 `lark-cli`，但飞书授权需要本人在浏览器完成：

```bash
cd <profile 目录>
node node_modules/@larksuite/cli/scripts/run.js config init --new
node node_modules/@larksuite/cli/scripts/run.js auth login --recommend
```

完成后在设置页点「添加账号」即可读到真实身份。

## 已知限制

- 实时事件不可用（见上）。
- `231204`：应用若开启外部共享或关联组织，用户身份无法读取消息，需要在应用侧调整。
- `231203`：保密模式群等会话不可读，接收器会跳过该会话而不中断整轮。
