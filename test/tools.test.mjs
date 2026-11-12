import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountDirectory,
  pickAccount,
  resolveTarget,
  normalizeDocumentToken,
  registerFeishuTools,
} from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-tools-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seeded() {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  const now = '2026-11-12T00:00:00.000Z';
  directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
    VALUES('acc','ou_me','刘珂','','default',1,1,'polling','authorized',@now,@now,@now),
          ('acc2','ou_2','李四','','p2',0,0,'disabled','authorized',@now,@now,@now)`).run({ now });
  directory.db.prepare(`INSERT INTO contact(id, account_id, open_id, name, target_type, last_synced_at)
    VALUES('c1','acc','ou_zhang','张三','user',@now)`).run({ now });
  directory.db.prepare(`INSERT INTO chat(id, account_id, chat_id, name, chat_type, target_type, last_synced_at)
    VALUES('h1','acc','oc_dev','研发群','group','group',@now)`).run({ now });
  return directory;
}

test('默认账号在未指定时被选中', () => {
  const directory = seeded();
  assert.equal(pickAccount(directory).id, 'acc');
  assert.equal(pickAccount(directory, 'acc2').id, 'acc2');
});

test('未添加账号时给出可读错误', () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  assert.throws(() => pickAccount(directory), /尚未添加任何飞书账号/);
});

test('指定不存在的账号时抛出错误', () => {
  const directory = seeded();
  assert.throws(() => pickAccount(directory, 'missing'), /账号不存在/);
});

test('resolveTarget 支持显式 user/chat 与本地 mention', () => {
  const directory = seeded();
  const account = pickAccount(directory);

  assert.deepEqual(resolveTarget(directory.db, account, { user: 'ou_x' }), {
    type: 'user', id: 'ou_x', name: 'ou_x',
  });
  assert.deepEqual(resolveTarget(directory.db, account, { chat: 'oc_x' }), {
    type: 'chat', id: 'oc_x', name: 'oc_x',
  });
  assert.equal(resolveTarget(directory.db, account, { mention: '张三' }).id, 'ou_zhang');
  assert.equal(resolveTarget(directory.db, account, { mention: '研发' }).type, 'chat');
});

test('mention 无匹配与多匹配分别给出明确错误', () => {
  const directory = seeded();
  const account = pickAccount(directory);

  assert.throws(() => resolveTarget(directory.db, account, { mention: '不存在' }), /找不到/);

  directory.db.prepare(`INSERT INTO contact(id, account_id, open_id, name, target_type, last_synced_at)
    VALUES('c2','acc','ou_zhang2','张三丰','user','2026-11-12T00:00:00.000Z')`).run();
  assert.throws(() => resolveTarget(directory.db, account, { mention: '张' }), /匹配到多个对象/);
});

test('缺少目标参数时抛出错误', () => {
  const directory = seeded();
  assert.throws(() => resolveTarget(directory.db, pickAccount(directory), {}), /需要指定/);
});

test('文档 token 归一化支持链接与裸 token', () => {
  assert.equal(normalizeDocumentToken('https://x.feishu.cn/docx/AbCd123'), 'AbCd123');
  assert.equal(normalizeDocumentToken('https://x.feishu.cn/wiki/Wk123'), 'Wk123');
  assert.equal(normalizeDocumentToken('  doxcnAbCd  '), 'doxcnAbCd');
});

test('工具注册在无 tools 服务时安全降级', () => {
  const directory = seeded();
  const dispose = registerFeishuTools({}, { directory });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});

test('工具注册到 tools 服务并覆盖核心能力', () => {
  const directory = seeded();
  const registered = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        const dispose = () => registered.delete(definition.name);
        disposers.push(dispose);
        return dispose;
      },
    },
  };

  const dispose = registerFeishuTools(ctx, { directory });
  assert.deepEqual([...registered.keys()].sort(), [
    'feishu_accounts',
    'feishu_read_document',
    'feishu_resolve_mention',
    'feishu_search_documents',
    'feishu_send_message',
  ]);

  dispose();
  assert.equal(registered.size, 0);
});

test('feishu_accounts 输出默认账号与接收状态', async () => {
  const directory = seeded();
  const registered = new Map();
  registerFeishuTools({
    tools: { register: (d) => { registered.set(d.name, d); return () => {}; } },
  }, { directory });

  const text = await registered.get('feishu_accounts').execute({});
  assert.match(text, /\[默认\] 刘珂/);
  assert.match(text, /接收：开启/);
  assert.match(text, /接收：关闭/);
});

test('feishu_resolve_mention 返回候选列表', async () => {
  const directory = seeded();
  const registered = new Map();
  registerFeishuTools({
    tools: { register: (d) => { registered.set(d.name, d); return () => {}; } },
  }, { directory });

  const text = await registered.get('feishu_resolve_mention').execute({ mention: '张三' });
  assert.match(text, /用户 张三 \(ou_zhang\)/);
});

test('feishu_send_message 在账号缺失时返回可读失败信息而不是抛出', async () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  const registered = new Map();
  registerFeishuTools({
    tools: { register: (d) => { registered.set(d.name, d); return () => {}; } },
  }, { directory });

  const text = await registered.get('feishu_send_message').execute({ text: 'hi', user: 'ou_x' });
  assert.match(text, /发送失败/);
});
