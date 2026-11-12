import type Database from 'better-sqlite3';
import type { Account } from '../shared/types.js';
import { listChats } from './message.js';

export interface SyncResult {
  /** 本次写入的联系人数量。 */
  contacts: number;
  /** 本次写入的群数量。 */
  chats: number;
  /** 同步失败的会话数（权限不足或不可见），不影响其它会话。 */
  skipped: number;
}

/**
 * 把当前账号可见的会话同步到本地关系表。
 *
 * 数据来源是 `im +chat-list`：单聊会话提供对方用户，群会话提供群本身。
 * 这些是「当前账号可见的关系」，也是 `@姓名` 解析的唯一依据。
 */
export async function syncRelations(db: Database.Database, account: Account): Promise<SyncResult> {
  const listed = await listChats(account);
  if (!listed.ok) {
    throw new Error(listed.error?.message ?? '读取会话列表失败');
  }

  const chats = listed.data?.chats ?? [];
  const now = new Date().toISOString();
  let contacts = 0;
  let chatCount = 0;
  let skipped = 0;

  const upsertContact = db.prepare(`INSERT INTO contact(id, account_id, open_id, name, tenant_key, p2p_chat_id, target_type, last_synced_at)
    VALUES(@id, @accountId, @openId, @name, @tenantKey, @p2pChatId, @targetType, @now)
    ON CONFLICT(account_id, open_id) DO UPDATE SET
      name = @name, tenant_key = @tenantKey, p2p_chat_id = @p2pChatId,
      target_type = @targetType, last_synced_at = @now`);

  const upsertChat = db.prepare(`INSERT INTO chat(id, account_id, chat_id, name, chat_type, tenant_key, target_open_id, target_type, last_synced_at)
    VALUES(@id, @accountId, @chatId, @name, @chatType, @tenantKey, @targetOpenId, @targetType, @now)
    ON CONFLICT(account_id, chat_id) DO UPDATE SET
      name = @name, chat_type = @chatType, tenant_key = @tenantKey,
      target_open_id = @targetOpenId, target_type = @targetType, last_synced_at = @now`);

  for (const chat of chats) {
    const chatId = chat.chat_id;
    if (!chatId) {
      skipped += 1;
      continue;
    }
    const isGroup = chat.chat_mode === 'group' || chat.chat_type === 'group';

    if (isGroup) {
      upsertChat.run({
        id: `${account.id}:${chatId}`,
        accountId: account.id,
        chatId,
        name: chat.name || chatId,
        chatType: 'group',
        tenantKey: chat.tenant_key ?? null,
        targetOpenId: null,
        targetType: 'group',
        now,
      });
      chatCount += 1;
      continue;
    }

    // 单聊：对方是用户或机器人，机器人不作为可 @ 的联系人。
    const targetId = chat.p2p_target_id;
    const targetType = chat.p2p_target_type ?? 'user';
    if (!targetId || targetType !== 'user') {
      skipped += 1;
      continue;
    }

    upsertContact.run({
      id: `${account.id}:${targetId}`,
      accountId: account.id,
      openId: targetId,
      name: chat.name || targetId,
      tenantKey: chat.tenant_key ?? null,
      p2pChatId: chatId,
      targetType: 'user',
      now,
    });
    contacts += 1;
  }

  return { contacts, chats: chatCount, skipped };
}

/** 读取本地已同步的关系统计。 */
export function relationStats(db: Database.Database, accountId: string): { contacts: number; chats: number } {
  const contacts = db.prepare('SELECT COUNT(*) AS c FROM contact WHERE account_id = ?').get(accountId) as any;
  const chats = db.prepare('SELECT COUNT(*) AS c FROM chat WHERE account_id = ?').get(accountId) as any;
  return { contacts: contacts?.c ?? 0, chats: chats?.c ?? 0 };
}

/** 读取某账号已同步的关系，供输入框 @ 面板使用。 */
export function relationCatalog(
  db: Database.Database,
  accountId: string,
): Array<{ type: 'user' | 'chat'; id: string; name: string; tenantKey?: string }> {
  const users = db
    .prepare('SELECT open_id AS id, name, tenant_key FROM contact WHERE account_id = ? ORDER BY name ASC')
    .all(accountId) as Array<{ id: string; name: string; tenant_key: string | null }>;
  const chats = db
    .prepare('SELECT chat_id AS id, name, tenant_key FROM chat WHERE account_id = ? ORDER BY name ASC')
    .all(accountId) as Array<{ id: string; name: string; tenant_key: string | null }>;

  return [
    ...users.map((row) => ({ type: 'user' as const, id: row.id, name: row.name, tenantKey: row.tenant_key ?? undefined })),
    ...chats.map((row) => ({ type: 'chat' as const, id: row.id, name: row.name, tenantKey: row.tenant_key ?? undefined })),
  ];
}
