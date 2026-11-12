import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { AccountDirectory, FeishuAccountService } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-service-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seededDirectory() {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  const now = '2026-11-12T00:00:00.000Z';
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc','ou_me','刘珂','','default',1,1,'polling','authorized',@now,@now,@now)`).run({ now });
  return directory;
}

test('账号服务在真实 Context 中绑定 typertRemote，供网关发现', () => {
  const app = new Context();
  const service = new FeishuAccountService(app, seededDirectory(), 'feishuLarkCli');

  assert.equal(service.name, 'feishuLarkCli');
  assert.equal(service.typertRemote.namespace, 'feishuLarkCli');
  assert.equal(service.typertRemote.serviceKey, 'feishuLarkCli');
  // Cordis 通过 ctx.get 暴露服务代理，结构一致即可被网关发现。
  const live = app.get('feishuLarkCli');
  assert.ok(live, '服务应可通过 ctx.get 取得');
  assert.equal(live.name, 'feishuLarkCli');
  assert.ok(remoteMethods(live).length > 0);
});

test('全部账号方法都被 @Remote 标记为 direct 调用', () => {
  const app = new Context();
  const service = new FeishuAccountService(app, seededDirectory(), 'feishuLarkCli');
  const marked = remoteMethods(service).map((item) => item.method).sort();

  assert.deepEqual(marked, [
    'accounts',
    'addAccount',
    'readDocument',
    'remove',
    'resolveMention',
    'searchDocuments',
    'send',
    'setDefault',
    'setReceive',
  ]);
  for (const item of remoteMethods(service)) {
    assert.equal(item.invocation.kind, 'direct');
  }
});

test('accounts 返回结构化账号列表', async () => {
  const app = new Context();
  const service = new FeishuAccountService(app, seededDirectory(), 'feishuLarkCli');
  const result = await service.accounts();
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].name, '刘珂');
  assert.equal(result.accounts[0].isDefault, true);
});

test('setReceive 与 setDefault 通过服务更新状态', async () => {
  const app = new Context();
  const directory = seededDirectory();
  const service = new FeishuAccountService(app, directory, 'feishuLarkCli');

  const paused = await service.setReceive('acc', false);
  assert.equal(paused.accounts[0].receiveEnabled, false);

  const resumed = await service.setReceive('acc', true);
  assert.equal(resumed.accounts[0].receiveEnabled, true);

  const defaults = await service.setDefault('acc');
  assert.equal(defaults.accounts.filter((item) => item.isDefault).length, 1);
});

test('remove 清空后返回空列表', async () => {
  const app = new Context();
  const service = new FeishuAccountService(app, seededDirectory(), 'feishuLarkCli');
  const result = await service.remove('acc');
  assert.deepEqual(result.accounts, []);
});

test('未授权时 addAccount 抛出可读错误', async () => {
  const app = new Context();
  const service = new FeishuAccountService(app, seededDirectory(), 'feishuLarkCli');
  await assert.rejects(() => service.addAccount('default'), /读取飞书账号身份失败|not configured/);
});

test('无账号时 send 抛出可读错误', async () => {
  const app = new Context();
  const empty = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  const service = new FeishuAccountService(app, empty, 'feishuLarkCli');
  await assert.rejects(() => service.send('hi', 'ou_x'), /尚未添加任何飞书账号/);
});
