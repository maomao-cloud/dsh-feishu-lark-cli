import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Database from 'better-sqlite3';
import {openDatabase, saveMessage} from '../lib/index.js';

test('package builds',()=>assert.ok(true));

test('client bundle registers a DSH ModuleLoader factory', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded;
  globalThis.window = {__ModuleLoader__: {load(value) { loaded = value; }}};
  try {
    new Function(source)();
    assert.equal(loaded?.id, 'dsh-feishu-lark-cli');
    const mod = loaded.factory((id) => {
      assert.equal(id, 'react');
      return {createElement: (...args) => ({args})};
    });
    assert.equal(typeof mod.apply, 'function');
    assert.deepEqual(mod.inject, ['slots', 'remote']);
    assert.equal(typeof mod.install, 'function');
  } finally {
    delete globalThis.window;
  }
});
