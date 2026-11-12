import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, PollingReceiver, AccountDirectory } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-cli-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 写一个假的 lark-cli，按参数返回固定 JSON。 */
function fakeCli(dir, script) {
  const path = join(dir, 'lark-cli');
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

test('runCli 解析成功返回的 JSON 信封', async () => {
  const dir = temporaryDirectory();
  const cli = fakeCli(dir, `process.stdout.write(JSON.stringify({ok:true,data:{v:1}}));`);
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = cli;
  try {
    const result = await runCli(['whoami']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { v: 1 });
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  }
});

test('支持的域命令会透传 --profile 与 --format json', async () => {
  const dir = temporaryDirectory();
  const cli = fakeCli(dir, `process.stdout.write(JSON.stringify({ok:true,data:{argv:process.argv.slice(2)}}));`);
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = cli;
  try {
    const result = await runCli(['im', '+chat-list'], { profile: 'work' });
    assert.deepEqual(result.data.argv, ['--profile', 'work', 'im', '+chat-list', '--format', 'json']);
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  }
});

test('runCli 在非 JSON 输出时不抛出，返回 process 错误', async () => {
  const dir = temporaryDirectory();
  const cli = fakeCli(dir, `process.stderr.write('boom'); process.exit(1);`);
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = cli;
  try {
    const result = await runCli(['whoami']);
    assert.equal(result.ok, false);
    assert.equal(result.error.type, 'process');
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  }
});

test('runCli 超时后返回 timeout 错误', async () => {
  const dir = temporaryDirectory();
  const cli = fakeCli(dir, `setTimeout(() => {}, 5000);`);
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = cli;
  try {
    const result = await runCli(['whoami'], { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.error.type, 'timeout');
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  }
});

test('PollingReceiver 拉取消息落库并发事件，重复轮询不重复发事件', async () => {
  const dir = temporaryDirectory();
  const cli = fakeCli(dir, `
const args = process.argv.slice(2).join(' ');
if (args.includes('+chat-list')) {
  process.stdout.write(JSON.stringify({ok:true,data:{chats:[{chat_id:'oc_1'}]}}));
} else if (args.includes('+chat-messages-list')) {
  process.stdout.write(JSON.stringify({ok:true,data:{messages:[{
    message_id:'om_1', chat_id:'oc_1', chat_type:'p2p',
    sender:{id:'ou_peer'}, msg_type:'text', content:'hi', create_time:'2026-11-12 10:00'
  }]}}));
} else {
  process.stdout.write(JSON.stringify({ok:true,data:{}}));
}`);
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = cli;
  try {
    const directory = new AccountDirectory(join(dir, 'feishu.db'));
    const account = {
      id: 'acc',
      name: '刘珂',
      openId: 'ou_me',
      tenantKey: '',
      profile: 'default',
      isDefault: true,
      receiveEnabled: true,
      receiveMode: 'polling',
      authStatus: 'authorized',
    };
    const events = [];
    const receiver = new PollingReceiver(directory.db, account, 50, (event) => events.push(event));
    receiver.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    receiver.stop();

    const count = directory.db.prepare('SELECT COUNT(*) AS count FROM message').get().count;
    assert.equal(count, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.messageId, 'om_1');
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  }
});
