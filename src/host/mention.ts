import type Database from 'better-sqlite3';
import type { Account } from '../shared/types.js';
import { sendMessage } from './message.js';
import { pickAccount } from './tools.js';

/** 从输入文本中解析出的飞书 mention。 */
export interface ParsedMention {
  accountId: string;
  type: 'user' | 'chat';
  id: string;
  /** 原始 mention 文本，用于在正文中剔除。 */
  raw: string;
  label: string;
}

/**
 * 解析输入框写入的飞书 mention。
 *
 * 兼容两种形态：
 *   1. 序列化形式 `@[label](dsh-feishu:<accountId>:<type>:<id>)`（提交给模型的形式）
 *   2. 原始载荷 `dsh-feishu:<accountId>:<type>:<id>`
 */
export function parseMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  const pattern = /@\[([^\]]*)\]\((dsh-feishu:[^)\s]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const [, label, ref] = match;
    const parts = ref.split(':');
    if (parts.length < 4 || parts[0] !== 'dsh-feishu') continue;
    const type = parts.at(-2);
    const id = parts.at(-1);
    const accountId = parts.slice(1, -2).join(':');
    if (!accountId || !id || (type !== 'user' && type !== 'chat')) continue;
    mentions.push({ accountId, type, id, raw: match[0], label });
  }

  return mentions;
}

/** 去掉文本中的 mention 标记，保留正文。 */
export function stripMentions(text: string, mentions: ParsedMention[]): string {
  let result = text;
  for (const mention of mentions) result = result.split(mention.raw).join('');
  return result.trim();
}

export interface SendResult {
  account: string;
  target: string;
  messageId?: string;
}

/**
 * 按 `@张三 会议改到三点` 的语义发送消息。
 *
 * 账号与目标全部来自 mention 载荷，因此跨账号同名不会发错人；
 * 未携带 mention 时回退到默认账号 + 显式收件人。
 */
export async function sendMentionMessage(
  db: Database.Database,
  text: string,
  pickAccountFor: (accountId: string) => Account,
): Promise<SendResult[]> {
  const mentions = parseMentions(text);
  if (mentions.length === 0) throw new Error('未找到飞书 @ 对象，请先通过 @ 选择联系人或群');

  const body = stripMentions(text, mentions);
  if (!body) throw new Error('消息正文为空');

  const results: SendResult[] = [];
  for (const mention of mentions) {
    const account = pickAccountFor(mention.accountId);
    const target = { type: mention.type, id: mention.id };
    const response = await sendMessage(account, target, body, `fsl-${Date.now()}-${results.length}`);
    if (!response.ok) {
      throw new Error(response.error?.message ?? `发送到 ${mention.label} 失败`);
    }
    results.push({
      account: account.name,
      target: mention.label,
      messageId: (response.data as any)?.message_id,
    });
  }

  return results;
}

export { pickAccount };
