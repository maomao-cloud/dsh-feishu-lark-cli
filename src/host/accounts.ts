import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from './db.js';
import { runCli } from './cli.js';
import { map } from './account.js';

const ERROR_HINTS: Record<string, string> = {
  '231203': '该会话暂不可读取（例如保密模式群）',
  '231204': '当前飞书应用不支持以用户身份读取消息，请更换应用授权',
  '230027': '缺少所需权限，请重新授权该账号',
  '230073': '该会话对当前账号不可见',
};

export interface AccountView {
  id: string;
  name: string;
  tenantName?: string;
  isDefault: boolean;
  receiveEnabled: boolean;
  authStatus: string;
  openId: string;
  /** 该账号所在的 lark-cli profile（通常是飞书 appId）。 */
  profile: string;
  /** 飞书应用名称，同一应用下的多个账号共用；未取到时为空。 */
  appName?: string;
}

function toView(row: any): AccountView {
  return {
    id: row.id,
    name: row.name,
    tenantName: row.tenant_name,
    isDefault: !!row.is_default,
    receiveEnabled: !!row.receive_enabled,
    authStatus: row.auth_status,
    openId: row.open_id,
    profile: row.profile,
    appName: row.app_name ?? undefined,
  };
}

export class AccountDirectory {
  readonly db: Database.Database;

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
  }

  list(): AccountView[] {
    return (this.db.prepare('SELECT * FROM account ORDER BY is_default DESC, name ASC').all() as any[]).map(toView);
  }

  /**
   * 用授权流程返回的身份登记账号。
   *
   * 与 {@link addFromProfile} 的区别：身份直接来自本次授权结果，
   * 不再额外调用 `whoami`，避免授权刚完成时 token 尚未落盘导致读不到。
   */
  addIdentity(input: { profile: string; openId?: string; name?: string }): AccountView {
    if (!input.openId) throw new Error('授权结果缺少用户 open_id，请重新授权');
    return this.upsert({
      profile: input.profile,
      openId: input.openId,
      name: input.name ?? input.openId,
    });
  }

  async addFromProfile(profile: string): Promise<AccountView> {
    const who = await runCli<{ onBehalfOf?: { userName?: string; openId?: string } }>(['whoami'], { profile });
    const user = who.data?.onBehalfOf;
    if (!who.ok || !user?.openId) throw new Error(this.describeError(String((who.error as any)?.code ?? (who.error as any)?.subtype ?? ""), who.error?.message));
    return this.upsert({ profile, openId: user.openId, name: user.userName ?? user.openId });
  }

  private upsert(input: { profile: string; openId: string; name: string }): AccountView {
    const { profile, openId, name } = input;
    const now = new Date().toISOString();
    const exists = this.db.prepare('SELECT id FROM account WHERE open_id = ? AND profile = ?').get(openId, profile) as any;
    const id = exists ? exists.id : `${profile}:${openId.slice(-8)}`;
    const hasDefault = this.db.prepare('SELECT 1 FROM account WHERE is_default = 1').get();
    this.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
      VALUES(@id,@openId,@name,'',@profile,@isDefault,1,'polling','authorized',@now,@now,@now)
      ON CONFLICT(id) DO UPDATE SET name=@name, auth_status='authorized', updated_at=@now`)
      .run({ id, openId, name, profile, isDefault: hasDefault ? 0 : 1, now });
    return toView(this.db.prepare('SELECT * FROM account WHERE id = ?').get(id));
  }

  setDefault(id: string): AccountView[] {
    const tx = this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM account WHERE id = ?').get(id)) throw new Error('账号不存在');
      this.db.prepare('UPDATE account SET is_default = 0 WHERE is_default = 1').run();
      this.db.prepare('UPDATE account SET is_default = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    });
    tx();
    return this.list();
  }

  setReceive(id: string, enabled: boolean): AccountView[] {
    this.db.prepare('UPDATE account SET receive_enabled = ?, receive_mode = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, enabled ? 'polling' : 'disabled', new Date().toISOString(), id);
    return this.list();
  }

  remove(id: string): AccountView[] {
    this.db.prepare('DELETE FROM account WHERE id = ?').run(id);
    if (!this.db.prepare('SELECT 1 FROM account WHERE is_default = 1').get()) {
      const first = this.db.prepare('SELECT id FROM account LIMIT 1').get() as any;
      if (first) this.db.prepare('UPDATE account SET is_default = 1 WHERE id = ?').run(first.id);
    }
    return this.list();
  }

  account(id: string) {
    const row = this.db.prepare('SELECT * FROM account WHERE id = ?').get(id) as any;
    return row ? map(row) : undefined;
  }

  describeError(code?: string, message?: string): string {
    if (code && ERROR_HINTS[code]) return ERROR_HINTS[code];
    return message ? `读取飞书账号身份失败：${message}` : '读取飞书账号身份失败';
  }
}
