import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountDirectory, createAccountRpc, ACCOUNT_METHODS } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-rpc-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seeded() {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc','ou_me','刘珂','','default',1,1,'polling','authorized','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z')`).run();
  return directory;
}

test('account.list 返回结构化账号视图', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.list', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.accounts.length, 1);
  const [account] = result.value.accounts;
  assert.equal(account.name, '刘珂');
  assert.equal(account.isDefault, true);
  assert.equal(account.receiveEnabled, true);
});

test('account.setDefault 切换到目标账号', async () => {
  const directory = seeded();
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc2','ou_2','李四','','p2',0,1,'polling','authorized','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z')`).run();
  const handler = createAccountRpc(directory);
  const result = await handler('account.setDefault', { id: 'acc2' });
  assert.equal(result.ok, true);
  assert.equal(result.value.accounts.filter((item) => item.isDefault).length, 1);
  assert.equal(result.value.accounts.find((item) => item.isDefault).id, 'acc2');
});

test('account.setReceive 关闭接收', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.setReceive', { id: 'acc', enabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.value.accounts[0].receiveEnabled, false);
});

test('account.remove 清空后列表为空', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.remove', { id: 'acc' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.accounts, []);
});

test('缺少必填参数时返回可读错误而不是抛出', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.setDefault', {});
  assert.equal(result.ok, false);
  assert.match(result.error.message, /id 不能为空/);
});

test('未知方法返回 unknown-method', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.explode', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown-method');
});

test('参数不是对象时返回错误', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.list', 'not-an-object');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'account-operation-failed');
});

test('暴露的 RPC 方法列表与实现一致', () => {
  assert.deepEqual([...ACCOUNT_METHODS], [
    'account.list',
    'account.add',
    'account.setDefault',
    'account.setReceive',
    'account.remove',
  ]);
});
