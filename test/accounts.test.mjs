import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountDirectory } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(directory, rows) {
  for (const row of rows) {
    directory.db.prepare(`INSERT INTO account(id, open_id, name, tenant_key, profile, is_default, receive_enabled, receive_mode, auth_status, authorized_at, created_at, updated_at)
      VALUES(@id, @openId, @name, '', @id, @isDefault, 1, 'polling', 'authorized', @now, @now, @now)`)
      .run({ ...row, now: '2026-11-12T00:00:00.000Z' });
  }
}

test('空库初始化后账号列表为空', () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  assert.deepEqual(directory.list(), []);
});

test('默认账号唯一：设置新默认后旧默认被清除', () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  seed(directory, [
    { id: 'a', openId: 'ou_a', name: '张三', isDefault: 1 },
    { id: 'b', openId: 'ou_b', name: '李四', isDefault: 0 },
  ]);
  const accounts = directory.setDefault('b');
  assert.equal(accounts.filter((item) => item.isDefault).length, 1);
  assert.equal(accounts.find((item) => item.isDefault).id, 'b');
});

test('移除默认账号后自动补选默认账号', () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  seed(directory, [
    { id: 'a', openId: 'ou_a', name: '张三', isDefault: 1 },
    { id: 'b', openId: 'ou_b', name: '李四', isDefault: 0 },
  ]);
  const accounts = directory.remove('a');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].isDefault, true);
});

test('接收开关同时切换 receive_enabled 与 receive_mode', () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  seed(directory, [{ id: 'a', openId: 'ou_a', name: '张三', isDefault: 1 }]);

  directory.setReceive('a', false);
  let row = directory.db.prepare('SELECT receive_enabled, receive_mode FROM account WHERE id = ?').get('a');
  assert.equal(row.receive_enabled, 0);
  assert.equal(row.receive_mode, 'disabled');

  directory.setReceive('a', true);
  row = directory.db.prepare('SELECT receive_enabled, receive_mode FROM account WHERE id = ?').get('a');
  assert.equal(row.receive_enabled, 1);
  assert.equal(row.receive_mode, 'polling');
});

test('设置不存在的账号为默认时抛出错误且不改变现状', () => {
  const directory = new AccountDirectory(join(temporaryDirectory(), 'feishu.db'));
  seed(directory, [{ id: 'a', openId: 'ou_a', name: '张三', isDefault: 1 }]);
  assert.throws(() => directory.setDefault('missing'), /账号不存在/);
  assert.equal(directory.list()[0].isDefault, true);
});

test('重复初始化同一数据库不会破坏已有账号', () => {
  const dir = temporaryDirectory();
  const path = join(dir, 'feishu.db');
  const first = new AccountDirectory(path);
  seed(first, [{ id: 'a', openId: 'ou_a', name: '张三', isDefault: 1 }]);
  const second = new AccountDirectory(path);
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].name, '张三');
});
