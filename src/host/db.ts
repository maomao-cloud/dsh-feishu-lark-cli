import Database from 'better-sqlite3';
import type { Account, ReceivedMessage } from '../shared/types.js';

export function openDatabase(path: string): Database.Database {
  const db = new Database(path); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL); INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
  CREATE TABLE IF NOT EXISTS account(id TEXT PRIMARY KEY, open_id TEXT NOT NULL, name TEXT NOT NULL, tenant_key TEXT NOT NULL, tenant_name TEXT, profile TEXT NOT NULL UNIQUE, is_default INTEGER NOT NULL DEFAULT 0, receive_enabled INTEGER NOT NULL DEFAULT 1, receive_mode TEXT NOT NULL DEFAULT 'polling', auth_status TEXT NOT NULL DEFAULT 'authorized', authorized_at TEXT NOT NULL, synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS account_one_default ON account(is_default) WHERE is_default=1;
  CREATE TABLE IF NOT EXISTS contact(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, open_id TEXT NOT NULL, name TEXT NOT NULL, avatar_url TEXT, tenant_key TEXT, department TEXT, p2p_chat_id TEXT, target_type TEXT NOT NULL DEFAULT 'user', last_synced_at TEXT NOT NULL, UNIQUE(account_id,open_id));
  CREATE TABLE IF NOT EXISTS chat(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL, chat_type TEXT NOT NULL, tenant_key TEXT, target_open_id TEXT, target_type TEXT, last_synced_at TEXT NOT NULL, UNIQUE(account_id,chat_id));
  CREATE TABLE IF NOT EXISTS chat_member(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, open_id TEXT NOT NULL, name TEXT, member_type TEXT, UNIQUE(account_id,chat_id,open_id));
  CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL, sender_open_id TEXT NOT NULL, message_type TEXT NOT NULL, content TEXT NOT NULL, root_id TEXT, parent_id TEXT, thread_id TEXT, create_time TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(account_id,message_id));
  CREATE TABLE IF NOT EXISTS receive_cursor(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, cursor TEXT, last_sync_time TEXT, UNIQUE(account_id,chat_id));`);
  return db;
}
export function saveMessage(db: Database.Database, message: ReceivedMessage): boolean { const s=db.prepare(`INSERT OR IGNORE INTO message(id,account_id,message_id,chat_id,chat_type,sender_open_id,message_type,content,root_id,parent_id,thread_id,create_time,source,created_at) VALUES(@id,@accountId,@messageId,@chatId,@chatType,@senderOpenId,@messageType,@content,@rootId,@parentId,@threadId,@createTime,@source,@createdAt)`); return s.run({rootId: null, parentId: null, threadId: null, ...message, id:`${message.accountId}:${message.messageId}`,createdAt:new Date().toISOString()}).changes===1; }

/** 记录已成功提交的出站消息，复用 message 表保持账号隔离与去重。 */
export function saveSentMessage(db: Database.Database, message: Omit<ReceivedMessage, 'source'> & { source?: 'sent' }): boolean {
  return saveMessage(db, { ...message, source: 'sent' });
}
