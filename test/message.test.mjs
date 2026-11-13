import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountDirectory,
  normalizeMessage,
  persistReceivedMessage,
  resolveMention,
  defaultAccount,
} from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-core-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function directoryWithAccount() {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc','ou_me','刘珂','','default',1,1,'polling','authorized','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z','2026-11-12T00:00:00.000Z')`).run();
  return directory;
}

const rawMessage = {
  message_id: 'om_1',
  chat_id: 'oc_1',
  chat_type: 'p2p',
  sender: { id: 'ou_peer', tenant_key: 'tk' },
  msg_type: 'text',
  content: '会议改到三点',
  create_time: '2026-11-12 10:00',
};

test('消息标准化保留账号隔离与来源标记', () => {
  const message = normalizeMessage('acc', rawMessage);
  assert.equal(message.accountId, 'acc');
  assert.equal(message.messageId, 'om_1');
  assert.equal(message.chatType, 'p2p');
  assert.equal(message.senderOpenId, 'ou_peer');
  assert.equal(message.content, '会议改到三点');
  assert.equal(message.source, 'polling');
});

test('群消息被识别为 group 类型', () => {
  const message = normalizeMessage('acc', { ...rawMessage, chat_type: 'group' });
  assert.equal(message.chatType, 'group');
});

test('重复消息只落库一次且只发一次事件', () => {
  const { db } = directoryWithAccount();
  const events = [];
  const message = normalizeMessage('acc', rawMessage);

  assert.equal(persistReceivedMessage(db, message, (event) => events.push(event)), true);
  assert.equal(persistReceivedMessage(db, message, (event) => events.push(event)), false);

  const rows = db.prepare('SELECT COUNT(*) AS count FROM message').get();
  assert.equal(rows.count, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'feishu.message.received');
  assert.equal(events[0].payload.messageId, 'om_1');
});

test('不同账号的相同 message_id 互不冲突', () => {
  const { db } = directoryWithAccount();
  const events = [];
  persistReceivedMessage(db, normalizeMessage('acc', rawMessage), (event) => events.push(event));
  persistReceivedMessage(db, normalizeMessage('other', rawMessage), (event) => events.push(event));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message').get().count, 2);
  assert.equal(events.length, 2);
});

test('默认账号按 is_default 解析', () => {
  const directory = directoryWithAccount();
  assert.equal(defaultAccount(directory.db).name, '刘珂');
});

test('@ 解析只返回当前账号可见的关系', () => {
  const directory = directoryWithAccount();
  const now = '2026-11-12T00:00:00.000Z';
  directory.db.prepare(`INSERT INTO contact(id, account_id, open_id, name, target_type, last_synced_at)
    VALUES('c1','acc','ou_1','张三','user',@now),('c2','other','ou_2','张三','user',@now)`).run({ now });
  directory.db.prepare(`INSERT INTO chat(id, account_id, chat_id, name, chat_type, target_type, last_synced_at)
    VALUES('h1','acc','oc_9','研发群','group','group',@now)`).run({ now });

  const matched = resolveMention(directory.db, 'acc', '张三');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].type, 'user');
  assert.equal(matched[0].id, 'ou_1');

  const group = resolveMention(directory.db, 'acc', '研发');
  assert.equal(group.length, 1);
  assert.equal(group[0].type, 'chat');
  assert.equal(group[0].id, 'oc_9');

  assert.deepEqual(resolveMention(directory.db, 'other', '研发'), []);
});

test('PollingReceiver.stop 后不再拉取，start 幂等', async () => {
  const { PollingReceiver } = await import('../lib/index.js');
  const directory = directoryWithAccount();
  const account = {
    id: 'acc', name: '刘珂', openId: 'ou_me', tenantKey: '', profile: 'nope',
    isDefault: true, receiveEnabled: true, receiveMode: 'polling', authStatus: 'authorized',
  };
  const receiver = new PollingReceiver(directory.db, account, { intervalMs: 10_000 }, () => {});
  receiver.start();
  receiver.start();
  assert.equal(receiver.isRunning, true);
  receiver.stop();
  assert.equal(receiver.isRunning, false);
  // 停止后单轮拉取立即返回，不产生任何写入。
  const result = await receiver.tick();
  assert.deepEqual(result, { chats: 0, inserted: 0, failed: 0 });
  assert.equal(directory.db.prepare('SELECT COUNT(*) AS count FROM message').get().count, 0);
});

test('接收游标可写入并按账号与会话隔离读取', async () => {
  const { openDatabase, advanceReceiveCursor, getReceiveCursor } = await import('../lib/index.js');
  const db = openDatabase(':memory:');
  advanceReceiveCursor(db, 'accA', 'oc_1', '2026-11-13T00:00:00Z');
  assert.equal(getReceiveCursor(db, 'accA', 'oc_1'), '2026-11-13T00:00:00Z');
  assert.equal(getReceiveCursor(db, 'accB', 'oc_1'), undefined);
});

test('PollingReceiver 在 CLI 不可用时静默跳过而不抛出', async () => {
  const { PollingReceiver } = await import('../lib/index.js');
  const directory = directoryWithAccount();
  const account = {
    id: 'acc', name: '刘珂', openId: 'ou_me', tenantKey: '', profile: 'missing-profile',
    isDefault: true, receiveEnabled: true, receiveMode: 'polling', authStatus: 'authorized',
  };
  const previous = process.env.LARK_CLI_PATH;
  process.env.LARK_CLI_PATH = '/definitely/missing/lark-cli';
  try {
    const receiver = new PollingReceiver(directory.db, account, { intervalMs: 10_000 }, () => {});
    receiver.start();
    const result = await receiver.tick();
    receiver.stop();
    assert.deepEqual(result, { chats: 0, inserted: 0, failed: 0 });
  } finally {
    if (previous === undefined) delete process.env.LARK_CLI_PATH;
    else process.env.LARK_CLI_PATH = previous;
  }
});
