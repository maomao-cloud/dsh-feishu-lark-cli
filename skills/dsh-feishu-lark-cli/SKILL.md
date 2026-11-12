---
name: dsh-feishu-lark-cli
description: 使用 DSH 飞书个人账号插件：多账号上下文、收发消息、@ 关系解析与文档读取。
---

# DSH 飞书个人账号（feishu-lark-cli）

本插件是官方 `lark-cli` 的上层包装。它不替代 CLI，负责多账号上下文、本地关系数据与设置页。

## 账号上下文规则

- 未指定账号时一律使用**默认账号**，不要主动切换默认账号。
- 页面临时账号只作用于当前页面/本次操作，不改默认账号。
- 需要强制指定时，向工具传 `accountId`。

## 可用工具

| 工具 | 用途 |
| --- | --- |
| `feishu_accounts` | 列出已授权账号与接收状态 |
| `feishu_resolve_mention` | 按当前账号可见关系解析 @ 目标 |
| `feishu_send_message` | 发送消息（user / chat / mention） |
| `feishu_read_document` | 读取云文档正文或大纲 |
| `feishu_search_documents` | 搜索文档 / Wiki / 表格 |

## 使用顺序

1. 不确定账号时先调 `feishu_accounts`；
2. 只给了姓名时先 `feishu_resolve_mention` 拿 open_id / chat_id；
3. 有多个同名候选时**必须询问用户**，不要自行挑一个；
4. 发送前确认目标与正文，避免误发。

## 边界

- 实时消息事件仅支持机器人身份，本插件**只用用户身份的定时拉取**。
- 接收链路只做「拉取 → 落库 → 发内部事件」，不做自动回复。
- 不做机器人/应用身份调用。
