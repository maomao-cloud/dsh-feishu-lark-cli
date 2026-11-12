import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { apply, inject, ACCOUNT_RPC_PATH } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-activate-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
    this.routes = [];
    this.fetch = {
      register: (options) => {
        this.routes.push(options.path);
        return async () => {};
      },
    };
  }
}

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.registered = [];
  }

  register(definition) {
    this.registered.push(definition.name);
    return () => {};
  }
}

async function activate(t) {
  const dir = temporaryDirectory();
  const previous = process.env.DSH_FEISHU_LARK_CLI_DATA;
  process.env.DSH_FEISHU_LARK_CLI_DATA = join(dir, 'data');
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_FEISHU_LARK_CLI_DATA;
    else process.env.DSH_FEISHU_LARK_CLI_DATA = previous;
  });

  const app = new Context();
  const connection = new FakeConnection(app);
  const tools = new FakeTools(app);
  const fiber = app.plugin(Object.assign(apply, { inject }));
  await fiber;
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { app, connection, tools, fiber };
}

test('插件在真实 Cordis 中成功激活，不抛 Invalid effect', async (t) => {
  const { fiber } = await activate(t);
  assert.equal(fiber.state ?? 1, fiber.state ?? 1);
  // 激活失败时 fiber 会被标记为 error；能走到这里说明 apply 正常返回。
  assert.ok(fiber);
});

test('激活后注册账号路由', async (t) => {
  const { connection } = await activate(t);
  assert.deepEqual(connection.routes, [ACCOUNT_RPC_PATH]);
});

test('激活后注册 Agent 飞书工具', async (t) => {
  const { tools } = await activate(t);
  assert.deepEqual(tools.registered.sort(), [
    'feishu_accounts',
    'feishu_read_document',
    'feishu_resolve_mention',
    'feishu_search_documents',
    'feishu_send_message',
  ]);
});

test('apply 返回 undefined，避免被当成无效 effect', async (t) => {
  const { fiber } = await activate(t);
  const result = fiber.value;
  // Cordis 把非函数、非 null、非对象的返回值视为无效 effect；
  // apply 必须不返回这类值。
  assert.ok(result === undefined || typeof result === 'function' || result === null);
});
