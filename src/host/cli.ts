import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliResult } from '../shared/types.js';

export interface CliOptions {
  profile?: string;
  timeoutMs?: number;
}

const require = createRequire(import.meta.url);

/**
 * lark-cli 的持久化配置根目录。
 *
 * 实测结论：lark-cli 把应用配置与 OAuth 凭证写在 `$HOME/.lark-cli`，
 * **不读 `XDG_CONFIG_HOME`**。容器里的 `$HOME`（/home/dsh）不在持久卷内，
 * Pod 重建后授权会全部丢失，因此这里把 HOME 指向 DSH 数据目录下的私有 home，
 * 保证凭证落在持久卷上。
 */
export function larkConfigHome(): string {
  const explicit = process.env.DSH_FEISHU_LARK_CLI_CONFIG_HOME;
  if (explicit) return explicit;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'integrations', 'lark-cli-home');
}

/** 所有 lark-cli 子进程共用的环境变量，确保读到同一份凭证。 */
export function larkCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configHome = larkConfigHome();
  mkdirSync(configHome, { recursive: true });
  // lark-cli 以 $HOME/.lark-cli 为配置根，重定向 HOME 才能改变实际落盘位置。
  return { ...base, HOME: configHome, XDG_CONFIG_HOME: join(configHome, '.config') };
}

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

    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: larkCliEnv() });

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
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // 部分命令（如 whoami、profile list）直接输出裸对象/数组，没有 ok 字段。
        // 这里统一补齐 ok，避免调用方把 undefined 当成结果。
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && !('ok' in parsed)) {
          finish({ ok: true, data: parsed as T });
          return;
        }
        if (Array.isArray(parsed)) {
          finish({ ok: true, data: parsed as unknown as T });
          return;
        }
        finish(parsed as unknown as CliResult<T>);
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
