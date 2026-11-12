import { spawn } from 'node:child_process';
import { resolveCliPath } from './cli.js';

/** 授权尝试在内存中的生命周期状态（不落库）。 */
export type AuthPhase = 'idle' | 'pending' | 'authorized' | 'failed' | 'expired';

export interface AuthAttempt {
  /** 一次性 device code，仅服务端保存，不下发浏览器。 */
  deviceCode: string;
  verificationUrl?: string;
  phase: AuthPhase;
  error?: string;
  startedAt: number;
  expiresAt: number;
  profile: string;
}

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * 执行一次 lark-cli，返回解析后的 JSON 与退出码。
 *
 * 授权命令需要区分「输出 JSON 但退出码非 0」的情形（例如 device flow 成功后
 * 因缺少 refresh token 而以 3 退出），因此这里不把退出码当作失败判据。
 */
function runRaw(args: string[], timeoutMs = 60_000): Promise<{ text: string; code: number | null }> {
  const cli = resolveCliPath();
  const command = cli.endsWith('.js') ? process.execPath : cli;
  const prefix = cli.endsWith('.js') ? [cli] : [];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: { text: string; code: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(command, [...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ text: stderr.trim() || stdout.trim() || 'lark-cli 超时', code: null });
    }, timeoutMs);

    child.on('error', (error) => finish({ text: `无法启动 lark-cli：${error.message}`, code: null }));
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => finish({ text: stdout.trim() || stderr.trim(), code }));
  });
}

/**
 * 解析 lark-cli 的 JSON 输出。
 *
 * 部分命令把 JSON 写到 stderr（例如 device flow 的提示），因此两侧都尝试解析。
 */
export function parseCliJson(text: string): any {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) candidates.push(trimmed.slice(firstBrace));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

/** 从命令输出里提取第一个 https 链接（忽略终端二维码 ANSI）。 */
export function extractUrl(text: string): string | undefined {
  const cleaned = text.replace(/\u001b\[[0-9;]*m/g, '');
  return cleaned.match(/https:\/\/[^\s`'"]+/)?.[0];
}

/** 判断 lark-cli 是否已完成应用配置（config init）。 */
export async function isConfigured(profile: string): Promise<boolean> {
  const args = [...(profile ? ['--profile', profile] : []), 'auth', 'list'];
  const { text } = await runRaw(args, 30_000);
  return !/not configured/.test(text) && !/"subtype"\s*:\s*"not_configured"/.test(text);
}

/**
 * 发起应用配置：lark-cli 会阻塞等待用户在浏览器完成，这里返回配置链接后
 * 由调用方轮询 {@link isConfigured} 判断是否完成。
 *
 * @param onUrl 拿到链接时立即回调，便于前端尽早展示。
 */
export function startConfigInit(profile: string, onUrl: (url: string) => void): Promise<void> {
  const cli = resolveCliPath();
  const command = cli.endsWith('.js') ? process.execPath : cli;
  const prefix = cli.endsWith('.js') ? [cli] : [];
  const args = [...prefix, ...(profile ? ['--profile', profile] : []), 'config', 'init', '--new'];

  return new Promise((resolve) => {
    let buffer = '';
    let emitted = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (emitted) return;
      const url = extractUrl(buffer);
      if (url) {
        emitted = true;
        onUrl(url);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    // config init 在用户完成配置后自行退出；超时则中止，避免悬挂进程。
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    const done = () => { clearTimeout(timer); resolve(); };
    child.on('error', done);
    child.on('close', done);
  });
}

/**
 * 发起设备码授权，返回授权链接与一次性 device code。
 *
 * 使用 `auth login --no-wait --json`，不阻塞进程；用户在浏览器完成授权后
 * 由 {@link completeLogin} 用 device code 结束流程。
 */
export async function startLogin(profile: string): Promise<Omit<AuthAttempt, 'phase' | 'startedAt' | 'expiresAt'> & { expiresIn?: number }> {
  const args = [
    ...(profile ? ['--profile', profile] : []),
    'auth',
    'login',
    '--domain',
    'im,contact,docs,drive',
    '--no-wait',
    '--json',
  ];

  const { text } = await runRaw(args);
  const parsed = parseCliJson(text);
  const deviceCode = parsed?.device_code;
  const verificationUrl = parsed?.verification_url;

  if (typeof deviceCode !== 'string' || typeof verificationUrl !== 'string') {
    throw new Error(parsed?.hint ?? 'lark-cli 未返回授权链接，请确认 lark-cli 已正确安装');
  }

  return {
    deviceCode,
    verificationUrl,
    profile,
    expiresIn: Number(parsed?.expires_in) || 600,
  };
}

/** 用 device code 完成授权并读取最终账号身份。 */
export async function completeLogin(
  profile: string,
  deviceCode: string,
): Promise<{ ok: boolean; userName?: string; openId?: string; error?: string }> {
  const args = [...(profile ? ['--profile', profile] : []), 'auth', 'login', '--device-code', deviceCode, '--json'];
  const { text } = await runRaw(args, 180_000);
  const parsed = parseCliJson(text);

  if (parsed?.event === 'authorization_complete' || parsed?.ok === true) {
    return {
      ok: true,
      userName: parsed?.user_name,
      openId: parsed?.user_open_id,
    };
  }

  return { ok: false, error: parsed?.error?.message ?? parsed?.hint ?? text ?? '授权未完成' };
}

/**
 * 授权尝试登记簿。
 *
 * device code 只保留在服务端内存，浏览器只拿到 verification URL 与 attempt id，
 * 避免把可换取 token 的一次性凭据暴露给页面。
 */
export class AuthRegistry {
  private attempts = new Map<string, AuthAttempt>();

  private prune(now = Date.now()) {
    for (const [id, attempt] of this.attempts) {
      if (now - attempt.startedAt > DEVICE_CODE_TTL_MS) this.attempts.delete(id);
    }
  }

  register(attempt: AuthAttempt): string {
    this.prune();
    const id = `auth_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    this.attempts.set(id, attempt);
    return id;
  }

  get(id: string): AuthAttempt | undefined {
    this.prune();
    return this.attempts.get(id);
  }

  /** 授权成功后清除，device code 不再可用。 */
  release(id: string): void {
    this.attempts.delete(id);
  }

  isExpired(attempt: AuthAttempt, now = Date.now()): boolean {
    return now - attempt.startedAt > DEVICE_CODE_TTL_MS;
  }
}
