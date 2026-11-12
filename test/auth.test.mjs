import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountDirectory,
  createAccountRpc,
  parseCliJson,
  startLogin,
  completeLogin,
  resolveActiveProfile,
  AuthRegistry,
} from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-auth-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 写一个假的 lark-cli，按参数返回固定 JSON。 */
function fakeCli(dir, script) {
  const path = join(dir, 'lark-cli.js');
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function withCli(path, t) {
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = path;
  t.after(() => {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  });
}

test('parseCliJson 能从纯 JSON 与带前缀输出中解析', () => {
  assert.deepEqual(parseCliJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseCliJson('some log\n{"a":2}'), { a: 2 });
  assert.equal(parseCliJson('not json'), undefined);
});

test('startLogin 返回授权链接与 device code', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
process.stdout.write(JSON.stringify({
  device_code: 'dev-1',
  verification_url: 'https://example.com/verify?code=X',
  expires_in: 600,
}));`), t);

  const started = await startLogin('default');
  assert.equal(started.deviceCode, 'dev-1');
  assert.equal(started.verificationUrl, 'https://example.com/verify?code=X');
  assert.equal(started.expiresIn, 600);
});

test('startLogin 在缺少授权链接时抛出可读错误', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
process.stdout.write(JSON.stringify({ ok: false, hint: 'lark-cli 未就绪' }));`), t);

  await assert.rejects(() => startLogin('default'), /lark-cli 未就绪/);
});

test('completeLogin 识别 authorization_complete 并返回身份', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
process.stdout.write(JSON.stringify({
  event: 'authorization_complete',
  user_name: '刘珂',
  user_open_id: 'ou_abc',
}));`), t);

  const result = await completeLogin('default', 'dev-1');
  assert.equal(result.ok, true);
  assert.equal(result.userName, '刘珂');
  assert.equal(result.openId, 'ou_abc');
});

test('completeLogin 在未完成授权时返回失败原因', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
process.stdout.write(JSON.stringify({ ok: false, error: { message: '用户未完成授权' } }));`), t);

  const result = await completeLogin('default', 'dev-1');
  assert.equal(result.ok, false);
  assert.match(result.error, /未完成授权/);
});

test('resolveActiveProfile 从 profile list 解析当前生效 profile', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
process.stdout.write(JSON.stringify([
  { name: 'cli_aaa', active: false, effective: false },
  { name: 'cli_bbb', active: true, effective: true, appId: 'cli_bbb' },
]));`), t);
  const active = await resolveActiveProfile();
  assert.equal(active.name, 'cli_bbb');
  assert.equal(active.appId, 'cli_bbb');
});

test('未配置时 resolveActiveProfile 返回 undefined', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, 'process.stdout.write("not configured");'), t);
  assert.equal(await resolveActiveProfile(), undefined);
});

test('AuthRegistry 过期后不再返回尝试记录', () => {
  const registry = new AuthRegistry();
  const id = registry.register({
    deviceCode: 'd',
    verificationUrl: 'u',
    phase: 'pending',
    startedAt: Date.now() - 11 * 60 * 1000,
    expiresAt: Date.now(),
    profile: 'default',
  });
  assert.equal(registry.get(id), undefined);
});

test('auth.start 不上发 device code，只返回授权链接', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
const args = process.argv.slice(2).join(' ');
if (args.includes('profile list')) {
  process.stdout.write(JSON.stringify([{ name: 'cli_test', active: true, effective: true }]));
} else {
  process.stdout.write(JSON.stringify({
    device_code: 'secret-device-code',
    verification_url: 'https://example.com/verify',
    expires_in: 600,
  }));
}`), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  const handler = createAccountRpc(directory);
  const result = await handler('auth.start', { profile: 'default' });

  assert.equal(result.ok, true);
  assert.equal(result.value.verificationUrl, 'https://example.com/verify');
  assert.equal(typeof result.value.attemptId, 'string');
  assert.equal(JSON.stringify(result).includes('secret-device-code'), false);
});

test('auth.complete 用授权身份登记账号并触发同步回调', async (t) => {
  const dir = temporaryDirectory();
  // 同一个假 CLI 同时服务 auth login 与 whoami
  withCli(fakeCli(dir, `
const args = process.argv.slice(2).join(' ');
if (args.includes('profile list')) {
  process.stdout.write(JSON.stringify([{ name: 'cli_test', active: true, effective: true }]));
} else if (args.includes('--no-wait')) {
  process.stdout.write(JSON.stringify({ device_code: 'd1', verification_url: 'https://e/v', expires_in: 600 }));
} else if (args.includes('--device-code')) {
  process.stdout.write(JSON.stringify({ event: 'authorization_complete', user_name: '刘珂', user_open_id: 'ou_xyz' }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { onBehalfOf: { userName: '刘珂', openId: 'ou_xyz' } } }));
}`), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  let synced = 0;
  const handler = createAccountRpc({ directory, onAccountsChanged: () => { synced += 1; } });

  const started = await handler('auth.start', { profile: 'default' });
  assert.equal(started.ok, true);

  const completed = await handler('auth.complete', { attemptId: started.value.attemptId });
  assert.equal(completed.ok, true);
  assert.equal(completed.value.added.name, '刘珂');
  assert.equal(completed.value.accounts.length, 1);
  assert.equal(completed.value.accounts[0].isDefault, true);
  assert.equal(synced, 1);
});

test('auth.complete 使用无效 attemptId 时返回可读错误', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, 'process.stdout.write("{}");'), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  const handler = createAccountRpc(directory);
  const result = await handler('auth.complete', { attemptId: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /授权会话不存在/);
});

test('auth.complete 在授权未完成时保留错误信息', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeCli(dir, `
const args = process.argv.slice(2).join(' ');
if (args.includes('profile list')) {
  process.stdout.write(JSON.stringify([{ name: 'cli_test', active: true, effective: true }]));
} else if (args.includes('--no-wait')) {
  process.stdout.write(JSON.stringify({ device_code: 'd1', verification_url: 'https://e/v' }));
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: '用户拒绝授权' } }));
}`), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  const handler = createAccountRpc(directory);
  const started = await handler('auth.start', { profile: 'default' });
  const completed = await handler('auth.complete', { attemptId: started.value.attemptId });
  assert.equal(completed.ok, false);
  assert.match(completed.error.message, /用户拒绝授权/);
});
