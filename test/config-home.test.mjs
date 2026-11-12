import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { larkConfigHome, larkCliEnv } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-env-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('配置根默认落在 DSH_HOME 下的持久化目录', (t) => {
  const dir = temporaryDirectory();
  const previousHome = process.env.DSH_HOME;
  const previousConfig = process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
  process.env.DSH_HOME = dir;
  delete process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousConfig !== undefined) process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME = previousConfig;
  });

  assert.equal(larkConfigHome(), join(dir, 'integrations', 'lark-cli-home'));
});

test('显式配置根优先', (t) => {
  const dir = temporaryDirectory();
  const previous = process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
  process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
    else process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME = previous;
  });

  assert.equal(larkConfigHome(), dir);
});

test('子进程环境注入 HOME 并创建目录', () => {
  const dir = temporaryDirectory();
  const target = join(dir, 'nested', 'config');
  const previous = process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
  process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME = target;
  try {
    const env = larkCliEnv();
    // lark-cli 以 $HOME/.lark-cli 为配置根，必须重定向 HOME。
    assert.equal(env.HOME, target);
    assert.equal(env.XDG_CONFIG_HOME, join(target, '.config'));
    assert.ok(existsSync(target), '配置目录应被自动创建');
  } finally {
    if (previous === undefined) delete process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
    else process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME = previous;
  }
});

test('注入环境不污染调用方传入的其它变量', () => {
  const env = larkCliEnv({ FOO: 'bar' });
  assert.equal(env.FOO, 'bar');
  assert.equal(typeof env.HOME, 'string');
});
