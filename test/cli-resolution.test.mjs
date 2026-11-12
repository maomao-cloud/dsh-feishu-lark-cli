import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, resolveCliPath } from '../lib/index.js';

function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-lark-cli-spawn-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withCliPath(value, run) {
  const previous = process.env.LARK_CLI_PATH;
  if (value === undefined) delete process.env.LARK_CLI_PATH;
  else process.env.LARK_CLI_PATH = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.LARK_CLI_PATH;
      else process.env.LARK_CLI_PATH = previous;
    });
}

test('lark-cli 不存在时返回 spawn 错误而不是抛出未捕获异常', async () => {
  await withCliPath('/definitely/missing/lark-cli', async () => {
    const result = await runCli(['whoami']);
    assert.equal(result.ok, false);
    assert.equal(result.error.type, 'spawn');
    assert.match(result.error.message, /无法启动 lark-cli/);
  });
});

test('未显式指定路径时解析到插件自带的 @larksuite/cli', async () => {
  await withCliPath(undefined, async () => {
    const resolved = resolveCliPath();
    assert.ok(resolved.endsWith(join('scripts', 'run.js')), `unexpected path: ${resolved}`);
  });
});

test('解析出的自带 CLI 可正常返回 JSON 信封', async () => {
  await withCliPath(undefined, async () => {
    const before = process.cwd();
    const dir = temporaryDirectory();
    process.chdir(dir);
    try {
      // 未授权时 whoami 会返回错误信封，但进程本身必须可执行并产出 JSON。
      const result = await runCli(['whoami'], { timeoutMs: 60000 });
      assert.equal(typeof result.ok, 'boolean');
    } finally {
      process.chdir(before);
    }
  });
});

test('脚本形式的 CLI 通过 node 执行', async () => {
  const dir = temporaryDirectory();
  const cli = join(dir, 'lark-cli.js');
  writeFileSync(cli, `process.stdout.write(JSON.stringify({ok:true,data:{via:'node'}}));`, 'utf8');
  chmodSync(cli, 0o755);
  await withCliPath(cli, async () => {
    const result = await runCli(['whoami']);
    assert.equal(result.ok, true);
    assert.equal(result.data.via, 'node');
  });
});

test('只有支持 --format 的命令域才追加 --format json', async () => {
  const { supportsJsonFormat } = await import('../lib/index.js');
  assert.equal(supportsJsonFormat(['whoami']), false);
  assert.equal(supportsJsonFormat(['auth', 'list']), false);
  assert.equal(supportsJsonFormat(['profile', 'list']), false);
  assert.equal(supportsJsonFormat(['im', '+chat-list']), true);
  assert.equal(supportsJsonFormat(['docs', '+fetch']), true);
  assert.equal(supportsJsonFormat(['contact', '+search-user']), true);
});

test('whoami 不携带 --format，且返回 JSON 信封', async () => {
  const dir = temporaryDirectory();
  const cli = join(dir, 'lark-cli.js');
  writeFileSync(cli, `
const args = process.argv.slice(2);
if (args.includes('--format')) {
  process.stderr.write(JSON.stringify({ok:false,error:{type:'validation',message:'unknown flag "--format"'}}));
  process.exit(2);
}
process.stdout.write(JSON.stringify({ok:true,data:{profile:'p',onBehalfOf:{userName:'刘珂',openId:'ou_x'}}}));`, 'utf8');
  chmodSync(cli, 0o755);
  await withCliPath(cli, async () => {
    const result = await runCli(['whoami']);
    assert.equal(result.ok, true);
    assert.equal(result.data.onBehalfOf.userName, '刘珂');
  });
});
