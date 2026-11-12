import type Database from 'better-sqlite3';
import type { OperationContext } from '../shared/types.js';

export type MentionTarget = NonNullable<OperationContext['target']>;

/**
 * 按「当前账号可见的关系」解析 @ 输入。
 *
 * 关系范围严格绑定 account_id：同名用户在不同账号下互不影响，
 * 用户（contact）与群（chat）合并返回，调用方按 type 区分。
 */
export function resolveMention(
  db: Database.Database,
  accountId: string,
  query: string,
): MentionTarget[] {
  const pattern = `%${query}%`;

  const users = db
    .prepare(
      `SELECT open_id AS id, name, tenant_key
         FROM contact
        WHERE account_id = ? AND name LIKE ?
        ORDER BY name ASC`,
    )
    .all(accountId, pattern) as Array<{ id: string; name: string; tenant_key: string | null }>;

  const chats = db
    .prepare(
      `SELECT chat_id AS id, name, tenant_key
         FROM chat
        WHERE account_id = ? AND name LIKE ?
        ORDER BY name ASC`,
    )
    .all(accountId, pattern) as Array<{ id: string; name: string; tenant_key: string | null }>;

  return [
    ...users.map((row) => ({
      type: 'user' as const,
      id: row.id,
      name: row.name,
      tenantKey: row.tenant_key ?? undefined,
    })),
    ...chats.map((row) => ({
      type: 'chat' as const,
      id: row.id,
      name: row.name,
      tenantKey: row.tenant_key ?? undefined,
    })),
  ];
}
