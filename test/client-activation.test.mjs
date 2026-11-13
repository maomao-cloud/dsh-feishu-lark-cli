import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Context, Service } from '@deepseek-ai/cordis';

/**
 * 在真实 Cordis 里执行打包后的客户端 bundle（factory 形式），
 * 复现 DSH 浏览器端的加载与 `@` 来源注册链路。
 */
function loadClientBundle() {
  const registrations = [];
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) }, open: () => {} };
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  };
  const requireStub = (specifier) => {
    if (specifier === 'react') return React;
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'fragment' };
    throw new Error(`unexpected require(${specifier})`);
  };
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  new Function('window', 'require', code)(window, requireStub);
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.equal(registration.id, 'dsh-feishu-lark-cli');
  return registration.factory(requireStub);
}

class FakeSlots extends Service {
  constructor(ctx) {
    super(ctx, 'slots');
    this.registered = [];
  }

  inject(_name, callback) {
    this.registered.push(callback);
    return () => {};
  }

  register(options) {
    return () => {};
  }
}

class FakeConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
  }

  rpc() {
    return { call: async () => ({ ok: true, value: { accounts: [] } }) };
  }
}

class FakeInputTriggers extends Service {
  constructor(ctx) {
    super(ctx, 'inputTriggers');
    this.sources = [];
  }

  registerSource(source) {
    if (this.sources.some((item) => item.trigger === source.trigger && item.name === source.name)) {
      throw new Error(`slash source "${source.trigger}${source.name}" is already registered`);
    }
    this.sources.push(source);
    return () => {
      const at = this.sources.indexOf(source);
      if (at >= 0) this.sources.splice(at, 1);
    };
  }
}

async function activate({ provideTriggersAfter = true } = {}) {
  const client = loadClientBundle();
  const app = new Context();
  const slots = new FakeSlots(app);
  const connection = new FakeConnection(app);
  const fiber = app.plugin(Object.assign(client.apply, { inject: client.inject }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const triggers = provideTriggersAfter ? new FakeInputTriggers(app) : new FakeInputTriggers(app);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { app, slots, connection, triggers, fiber };
}

test('客户端注入列表只声明真实 Cordis 服务名', () => {
  const client = loadClientBundle();
  assert.deepEqual([...client.inject], ['slots', 'connection', 'inputTriggers']);
});

test('inputTriggers 服务就绪后注册 @ 飞书来源', async () => {
  const { triggers } = await activate();
  assert.equal(triggers.sources.length, 1);
  assert.equal(triggers.sources[0].trigger, '@');
  assert.equal(triggers.sources[0].name, 'feishu');
});

test('重复激活时已注册的来源被跳过，不抛 already registered', async () => {
  const { app, triggers, fiber } = await activate();
  // 模拟 DSH HMR/重启后再次执行 apply：来源已存在，注册不应抛错。
  const client = loadClientBundle();
  const second = app.plugin(Object.assign(client.apply, { inject: client.inject }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(triggers.sources.length, 1);
  assert.equal(second.state === 3, false, 'second activation must not fail');
  assert.equal(fiber.state === 3, false);
});

test('父作用域释放后来源被回收', async () => {
  const { app, triggers, fiber } = await activate();
  assert.equal(triggers.sources.length, 1);
  await fiber.dispose();
  assert.equal(triggers.sources.length, 0);
});
