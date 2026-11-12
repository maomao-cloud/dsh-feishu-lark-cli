import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountDirectory,
  createAccountRpc,
  registerAccountRpc,
  ACCOUNT_METHODS,
  ACCOUNT_RPC_CHANNEL,
  ACCOUNT_RPC_ENDPOINT,
  ACCOUNT_RPC_PATH,
} from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-rpc-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seeded() {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  const now = '2026-11-12T00:00:00.000Z';
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc','ou_me','刘珂','','default',1,1,'polling','authorized',@now,@now,@now)`).run({ now });
  return directory;
}

test('通道名满足 Connection 的约束：单段且不含斜杠', () => {
  // connection.fetch 要求通道匹配 /^\/[A-Za-z0-9._~-]+$/
  assert.match(ACCOUNT_RPC_CHANNEL, /^\/[A-Za-z0-9._~-]+$/);
  assert.equal(ACCOUNT_RPC_CHANNEL.slice(1).includes('/'), false);
});

test('endpoint 段满足 ENDPOINT_SEGMENT_PATTERN：不含斜杠', () => {
  // 浏览器 rpc.call 会校验 endpoint 每段匹配 /^[A-Za-z0-9_$.-]+$/
  for (const segment of ACCOUNT_RPC_ENDPOINT.split('/')) {
    assert.match(segment, /^[A-Za-z0-9_$.-]+$/);
  }
});

test('注册路径与浏览器实际请求路径逐字符一致', () => {
  // 浏览器发出的是 `${channel}/${endpoint}` 去掉前导斜杠，即 /api/<endpoint>
  const requestPath = `/api/${ACCOUNT_RPC_ENDPOINT}`;
  assert.equal(ACCOUNT_RPC_PATH, requestPath);
  assert.equal(ACCOUNT_RPC_ENDPOINT, `dsh-feishu-lark-cli${ACCOUNT_RPC_CHANNEL}`);
});

test('注册到 Connection 的路由路径与常量一致', () => {
  let registered;
  const ctx = {
    connection: {
      fetch: {
        register(options) {
          registered = options;
          return () => {};
        },
      },
    },
  };
  registerAccountRpc(ctx, createAccountRpc(seeded()));
  assert.equal(registered.path, ACCOUNT_RPC_PATH);
  assert.deepEqual(registered.methods, ['POST']);
});

test('account.list 返回结构化账号视图', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.list', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.accounts[0].name, '刘珂');
  assert.equal(result.value.accounts[0].isDefault, true);
});

test('account.setDefault / setReceive / remove 正确更新列表', async () => {
  const directory = seeded();
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc2','ou_2','李四','','p2',0,1,'polling','authorized','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z')`).run();
  const handler = createAccountRpc(directory);

  const defaults = await handler('account.setDefault', { id: 'acc2' });
  assert.equal(defaults.value.accounts.find((item) => item.isDefault).id, 'acc2');

  const paused = await handler('account.setReceive', { id: 'acc2', enabled: false });
  assert.equal(paused.value.accounts.find((item) => item.id === 'acc2').receiveEnabled, false);

  const removed = await handler('account.remove', { id: 'acc2' });
  assert.equal(removed.value.accounts.length, 1);
});

test('缺少必填参数返回可读错误而不是抛出', async () => {
  const handler = createAccountRpc(seeded());
  const result = await handler('account.setDefault', {});
  assert.equal(result.ok, false);
  assert.match(result.error.message, /id 不能为空/);
});

test('未知方法与非法参数均被拒绝', async () => {
  const handler = createAccountRpc(seeded());
  assert.equal((await handler('account.explode', {})).error.code, 'unknown-method');
  assert.equal((await handler('account.list', 'not-object')).error.code, 'account-operation-failed');
});

test('暴露的方法列表与实现一致', () => {
  assert.deepEqual([...ACCOUNT_METHODS], [
    'account.list',
    'account.add',
    'auth.status',
    'auth.configure',
    'auth.start',
    'auth.complete',
    'account.setDefault',
    'account.setReceive',
    'account.remove',
    'relation.sync',
    'relation.stats',
  ]);
});
