import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountDirectory, resolveMention, syncRelations, relationStats } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-sync-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ACCOUNT = {
  id: 'acc', name: '刘珂', openId: 'ou_me', tenantKey: '', profile: 'cli_test',
  isDefault: true, receiveEnabled: true, receiveMode: 'polling', authStatus: 'authorized',
};

/** 写一个只响应 +chat-list 的假 lark-cli。 */
function fakeChatList(dir, payload) {
  const path = join(dir, 'lark-cli.js');
  writeFileSync(path, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`, 'utf8');
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

test('同步单聊用户与群，跳过机器人会话', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeChatList(dir, {
    ok: true,
    data: {
      chats: [
        { chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p', p2p_target_id: 'ou_zhang', p2p_target_type: 'user', tenant_key: 'tk1' },
        { chat_id: 'oc_bot', name: '审批', chat_mode: 'p2p', p2p_target_id: 'ou_bot', p2p_target_type: 'bot', tenant_key: 'tk1' },
        { chat_id: 'oc_group', name: '研发群', chat_mode: 'group', tenant_key: 'tk1' },
      ],
    },
  }), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  const result = await syncRelations(directory.db, ACCOUNT);

  assert.equal(result.contacts, 1, '只应写入真实用户');
  assert.equal(result.chats, 1, '应写入群');
  assert.equal(result.skipped, 1, '机器人会话应被跳过');

  const stats = relationStats(directory.db, 'acc');
  assert.deepEqual(stats, { contacts: 1, chats: 1 });
});

test('同步后 @姓名 能解析到用户与群', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeChatList(dir, {
    ok: true,
    data: {
      chats: [
        { chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p', p2p_target_id: 'ou_zhang', p2p_target_type: 'user' },
        { chat_id: 'oc_group', name: '研发群', chat_mode: 'group' },
      ],
    },
  }), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  await syncRelations(directory.db, ACCOUNT);

  const users = resolveMention(directory.db, 'acc', '张三');
  assert.equal(users.length, 1);
  assert.equal(users[0].type, 'user');
  assert.equal(users[0].id, 'ou_zhang');

  const chats = resolveMention(directory.db, 'acc', '研发');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].type, 'chat');
});

test('关系严格按账号隔离', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeChatList(dir, {
    ok: true,
    data: { chats: [{ chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p', p2p_target_id: 'ou_zhang', p2p_target_type: 'user' }] },
  }), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  await syncRelations(directory.db, ACCOUNT);

  assert.equal(resolveMention(directory.db, 'acc', '张三').length, 1);
  assert.equal(resolveMention(directory.db, 'other', '张三').length, 0);
});

test('重复同步不产生重复记录', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeChatList(dir, {
    ok: true,
    data: { chats: [{ chat_id: 'oc_p2p', name: '张三', chat_mode: 'p2p', p2p_target_id: 'ou_zhang', p2p_target_type: 'user' }] },
  }), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  await syncRelations(directory.db, ACCOUNT);
  await syncRelations(directory.db, ACCOUNT);

  assert.deepEqual(relationStats(directory.db, 'acc'), { contacts: 1, chats: 0 });
});

test('会话列表失败时抛出可读错误', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeChatList(dir, { ok: false, error: { message: '权限不足' } }), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  await assert.rejects(() => syncRelations(directory.db, ACCOUNT), /权限不足/);
});

test('缺少 chat_id 的会话被跳过而不中断同步', async (t) => {
  const dir = temporaryDirectory();
  withCli(fakeChatList(dir, {
    ok: true,
    data: { chats: [{ name: '无 ID' }, { chat_id: 'oc_g', name: '群', chat_mode: 'group' }] },
  }), t);

  const directory = new AccountDirectory(join(dir, 'feishu.db'));
  const result = await syncRelations(directory.db, ACCOUNT);
  assert.equal(result.chats, 1);
  assert.equal(result.skipped, 1);
});
