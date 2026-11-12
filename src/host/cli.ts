import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { CliResult } from '../shared/types.js';

export interface CliOptions {
  profile?: string;
  timeoutMs?: number;
}

const require = createRequire(import.meta.url);

/**
 * 解析固定版本 lark-cli 的可执行入口。
 *
 * 优先级：
 *   1. `LARK_CLI_PATH`（测试或显式覆盖）
 *   2. 插件自带依赖 `@larksuite/cli` 的 bin
 *   3. PATH 中的 `lark-cli`
 *
 * 插件声明了固定版本依赖，因此正常情况下会命中第 2 条，不依赖宿主机全局安装。
 */
export function resolveCliPath(): string {
  const explicit = process.env.LARK_CLI_PATH;
  if (explicit) return explicit;

  try {
    const packageJson = require.resolve('@larksuite/cli/package.json');
    const bin = join(dirname(packageJson), 'scripts', 'run.js');
    if (existsSync(bin)) return bin;
  } catch {
    // 未随插件安装时继续回退到 PATH。
  }

  return 'lark-cli';
}

function spawnCommand(command: string): { file: string; args: string[] } {
  return command.endsWith('.js')
    ? { file: process.execPath, args: [command] }
    : { file: command, args: [] };
}

/**
 * 只有部分 lark-cli 命令支持 `--format`（快捷命令与 API 资源命令），
 * 而 `whoami`、`auth`、`profile` 等命令不支持，强行附加会直接报
 * `unknown flag "--format"`。这里按域白名单决定是否追加。
 */
const FORMAT_SUPPORTED_DOMAINS = new Set([
  'api',
  'base',
  'calendar',
  'contact',
  'docs',
  'drive',
  'event',
  'im',
  'mail',
  'markdown',
  'minutes',
  'sheets',
  'slides',
  'task',
  'vc',
  'wiki',
]);

export function supportsJsonFormat(args: string[]): boolean {
  const domain = args.find((arg) => !arg.startsWith('-'));
  return domain !== undefined && FORMAT_SUPPORTED_DOMAINS.has(domain);
}

export function runCli<T = unknown>(args: string[], options: CliOptions = {}): Promise<CliResult<T>> {
  const resolved = resolveCliPath();
  const { file, args: prefix } = spawnCommand(resolved);
  const formatArgs = supportsJsonFormat(args) ? ['--format', 'json'] : [];
  const argv = [...prefix, ...(options.profile ? ['--profile', options.profile] : []), ...args, ...formatArgs];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CliResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, error: { type: 'timeout', message: `lark-cli 超时：${args[0] ?? 'command'}` } });
    }, options.timeoutMs ?? 30000);

    // spawn 失败（命令不存在、权限不足）必须转成错误信封，不能抛出未捕获异常。
    child.on('error', (error) => {
      finish({ ok: false, error: { type: 'spawn', message: `无法启动 lark-cli：${error.message}` } });
    });

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      const text = stdout.trim() || stderr.trim();
      try {
        const parsed = JSON.parse(text) as CliResult<T>;
        finish(parsed);
      } catch {
        finish({
          ok: false,
          error: {
            type: 'process',
            message: text || `lark-cli 退出码 ${code}`,
          },
        });
      }
    });
  });
}
