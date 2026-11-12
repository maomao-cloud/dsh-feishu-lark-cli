import type Database from 'better-sqlite3';
import type { AccountDirectory } from './accounts.js';
import type { Account } from '../shared/types.js';
import { resolveMention, type MentionTarget } from './relation.js';
import { fetchDocument, searchDocuments, sendMessage, type MessageEvent } from './message.js';
import { parseMentions, sendMentionMessage } from './mention.js';

/** 判断文本里是否包含本插件的 mention 引用。 */
function mentionContainsFeishuRef(text: unknown): boolean {
  return typeof text === 'string' && parseMentions(text).length > 0;
}

export interface ToolDeps {
  directory: AccountDirectory;
  /** 订阅插件内部消息事件，返回取消函数。 */
  subscribe?: (sink: (event: MessageEvent) => void) => () => void;
}

/** 解析本次操作使用的账号：显式指定 > 默认账号。 */
export function pickAccount(directory: AccountDirectory, accountId?: string): Account {
  if (accountId) {
    const account = directory.account(accountId);
    if (account) return account;
    throw new Error(`账号不存在：${accountId}`);
  }
  const fallback = directory.db
    .prepare('SELECT * FROM account WHERE is_default = 1 LIMIT 1')
    .get() as any;
  if (!fallback) throw new Error('尚未添加任何飞书账号，请先在设置中授权');
  return directory.account(fallback.id)!;
}

/** 解析 @ 目标：显式 open_id / chat_id 优先，否则按当前账号可见关系本地匹配。 */
export function resolveTarget(
  db: Database.Database,
  account: Account,
  input: { user?: string; chat?: string; mention?: string },
): MentionTarget {
  if (input.chat) return { type: 'chat', id: input.chat, name: input.chat };
  if (input.user) return { type: 'user', id: input.user, name: input.user };
  if (!input.mention) throw new Error('需要指定 user、chat 或 mention 之一');

  const matches = resolveMention(db, account.id, input.mention);
  if (matches.length === 0) throw new Error(`当前账号下找不到「${input.mention}」`);
  if (matches.length > 1) {
    const listed = matches.map((item) => `${item.name}(${item.id})`).join('、');
    throw new Error(`「${input.mention}」匹配到多个对象：${listed}`);
  }
  return matches[0];
}

/** 文档 token 归一化：直接接受 token 或完整链接。 */
export function normalizeDocumentToken(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/(?:docx|docs|wiki|base|sheets)\/([A-Za-z0-9]+)/);
  return fromUrl ? fromUrl[1] : trimmed;
}

function textResult(text: string) {
  return { schema: { type: 'string' }, render: () => [{ type: 'text', text }] };
}

function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string; type?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? result.error?.type ?? 'lark-cli 调用失败');
  return result.data as T;
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * 注册面向 Agent 的飞书工具。
 *
 * 所有工具都从插件自己的账号表解析账号上下文，Agent 不需要自己管理 profile。
 */
export function registerFeishuTools(ctx: any, deps: ToolDeps) {
  const registry = ctx?.tools;
  if (typeof registry?.register !== 'function') return () => {};

  const disposers: Array<() => void> = [];
  const register = (definition: any) => {
    const dispose = registry.register(definition);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  register({
    name: 'feishu_accounts',
    description: '列出已授权的飞书个人账号及其默认/接收状态。',
    parameters: {},
    output: textResult('account list'),
    async execute() {
      const accounts = deps.directory.list();
      if (accounts.length === 0) return '尚未添加任何飞书账号。';
      return accounts
        .map((item) => `${item.isDefault ? '[默认] ' : ''}${item.name}${item.tenantName ? ` · ${item.tenantName}` : ''} (${item.id}) 接收：${item.receiveEnabled ? '开启' : '关闭'}`)
        .join('\n');
    },
  });

  register({
    name: 'feishu_send_message',
    description: '以飞书个人账号发送消息。可直接传输入框里的 mention 文本（@[名字](dsh-feishu:…)），也可指定 user/chat。',
    parameters: {
      text: { type: 'string', required: true, description: '消息正文；也可包含 @[名字](dsh-feishu:…) 形式的 mention' },
      user: { type: 'string', description: '接收人 open_id' },
      chat: { type: 'string', description: '目标会话 chat_id' },
      mention: { type: 'string', description: '按姓名在本地关系中匹配' },
      accountId: { type: 'string', description: '使用的账号，省略则用默认账号' },
    },
    output: textResult('send result'),
    async execute(args: any) {
      try {
        // 输入框 @ 产生的 mention 自带账号与目标，优先按它发送。
        if (mentionContainsFeishuRef(args.text)) {
          const sent = await sendMentionMessage(
            deps.directory.db,
            args.text,
            (accountId) => pickAccount(deps.directory, accountId),
          );
          return sent
            .map((item) => `已通过「${item.account}」向 ${item.target} 发送消息`)
            .join('\n');
        }

        const account = pickAccount(deps.directory, args.accountId);
        const target = resolveTarget(deps.directory.db, account, args);
        const result = await sendMessage(account, target, args.text, `fsl-${Date.now()}`);
        unwrap(result);
        return `已通过「${account.name}」向 ${target.name} 发送消息`;
      } catch (error) {
        return `发送失败：${describeError(error)}`;
      }
    },
  });

  register({
    name: 'feishu_read_document',
    description: '以飞书个人账号读取云文档内容或大纲。',
    parameters: {
      doc: { type: 'string', required: true, description: '文档链接或 token' },
      scope: { type: 'string', description: 'full 或 outline，默认 full' },
      accountId: { type: 'string', description: '使用的账号，省略则用默认账号' },
    },
    output: textResult('document content'),
    async execute(args: any) {
      try {
        const account = pickAccount(deps.directory, args.accountId);
        const token = normalizeDocumentToken(args.doc);
        const data = unwrap(await fetchDocument(account, token, args.scope === 'outline' ? 'outline' : 'full'));
        return data?.document?.content ?? '文档为空';
      } catch (error) {
        return `读取失败：${describeError(error)}`;
      }
    },
  });

  register({
    name: 'feishu_search_documents',
    description: '以飞书个人账号搜索文档、Wiki 与表格。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      accountId: { type: 'string', description: '使用的账号，省略则用默认账号' },
    },
    output: textResult('search result'),
    async execute(args: any) {
      try {
        const account = pickAccount(deps.directory, args.accountId);
        const data = unwrap(await searchDocuments(account, args.query));
        const results = (data?.results ?? []) as any[];
        if (results.length === 0) return '没有匹配的文档';
        return results
          .map((item) => `${item.title_highlighted ?? item.result_meta?.title ?? '(无标题)'} — ${item.result_meta?.url ?? ''}`)
          .join('\n');
      } catch (error) {
        return `搜索失败：${describeError(error)}`;
      }
    },
  });

  register({
    name: 'feishu_resolve_mention',
    description: '按当前账号可见的用户/群关系解析 @ 目标，返回候选。',
    parameters: {
      mention: { type: 'string', required: true, description: '姓名或群名关键词' },
      accountId: { type: 'string', description: '使用的账号，省略则用默认账号' },
    },
    output: textResult('mention candidates'),
    async execute(args: any) {
      try {
        const account = pickAccount(deps.directory, args.accountId);
        const matches = resolveMention(deps.directory.db, account.id, args.mention);
        if (matches.length === 0) return `「${account.name}」下没有匹配「${args.mention}」的用户或群`;
        return matches
          .map((item) => `${item.type === 'user' ? '用户' : '群'} ${item.name} (${item.id})${item.tenantKey ? ` [${item.tenantKey}]` : ''}`)
          .join('\n');
      } catch (error) {
        return `解析失败：${describeError(error)}`;
      }
    },
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}
