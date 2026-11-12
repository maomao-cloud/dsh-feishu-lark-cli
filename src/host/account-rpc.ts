import type { AccountDirectory, AccountView } from './accounts.js';
import { relationCatalog, relationStats, syncRelations } from './sync.js';
import {
  AuthRegistry,
  fetchAppInfo,
  completeLogin,
  resolveActiveProfile,
  startConfigInit,
  startLogin,
  type AuthAttempt,
} from './auth.js';

export type RpcHandler = (
  method: string,
  payload: unknown,
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;

/**
 * 通道名与注册路径。
 *
 * 对齐 DSH-IM（xmanrui/dsh-im 5.10.0）已验证的多账号实现：
 *   - 通道必须匹配 `/^\/[A-Za-z0-9._~-]+$/`，即只有一个不含斜杠的段；
 *   - 浏览器侧 `connection.rpc.call('/api', endpoint)` 发出的 URL 是
 *     `/api/${endpoint}`，因此 endpoint 必须写全 `${pluginPrefix}${channel}`；
 *   - 宿主注册的 `path` 必须与上面算出的 URL 逐字符相等。
 *
 * 三者共用下面的常量推导，任一处改动都会同步，避免再次出现 404。
 */
export const ACCOUNT_RPC_CHANNEL = '/feishu-lark-cli';

/** 插件前缀，避免与 DSH-IM 的 `dsh-im` 前缀冲突。 */
export const ACCOUNT_RPC_PREFIX = 'dsh-feishu-lark-cli';

/** 客户端 `connection.rpc.call` 的 method 参数。 */
export const ACCOUNT_RPC_ENDPOINT = `${ACCOUNT_RPC_PREFIX}${ACCOUNT_RPC_CHANNEL}`;

/** 宿主注册的完整 HTTP 路径。 */
export const ACCOUNT_RPC_PATH = `/api/${ACCOUNT_RPC_ENDPOINT}`;

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求参数必须是对象');
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 不能为空`);
  return value.trim();
}

export const ACCOUNT_METHODS = [
  'account.list',
  'account.add',
  'auth.status',
  'auth.configure',
  'auth.start',
  'auth.complete',
  'account.setDefault',
  'account.setReceive',
  'account.remove',
  'relation.sync',
  'relation.stats',
  'relation.catalog',
] as const;

export interface AccountRpcDeps {
  directory: AccountDirectory;
  /** 账号列表变化后同步轮询接收器。 */
  onAccountsChanged?: () => void;
}

/**
 * 账号管理 RPC。
 *
 * 授权拆成两步，避免阻塞浏览器请求：
 *   - `auth.start` 发起设备码授权，返回授权链接与 attempt id；
 *   - `auth.complete` 用 attempt id 结束授权并登记账号。
 *
 * device code 只留在服务端内存的 {@link AuthRegistry} 中。
 */
export function createAccountRpc(deps: AccountRpcDeps | AccountDirectory): RpcHandler {
  const { directory, onAccountsChanged } = 'directory' in deps
    ? deps
    : { directory: deps as AccountDirectory, onAccountsChanged: undefined };
  const registry = new AuthRegistry();

  /**
   * 解析本次操作使用的 lark-cli profile。
   *
   * 显式传入且真实存在时优先使用；否则回退到当前生效 profile（通常是 appId）。
   */
  const resolveProfile = async (requested?: unknown): Promise<string> => {
    const active = await resolveActiveProfile();
    if (typeof requested === 'string' && requested.trim() && requested.trim() !== 'default') {
      return requested.trim();
    }
    if (!active) throw new Error('尚未完成飞书应用配置，请先点击「配置飞书应用」');
    return active.name;
  };

  /**
   * 为账号补上所属应用名称。
   *
   * 应用名只能通过应用身份查 OpenAPI 得到，按 profile 缓存，
   * 避免每次列表都发起网络请求；查询失败时静默降级为空。
   */
  const appNameCache = new Map<string, { name?: string; fetchedAt: number }>();
  const appNameOf = async (profile: string): Promise<string | undefined> => {
    const cached = appNameCache.get(profile);
    if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.name;

    const info = await fetchAppInfo(profile);
    appNameCache.set(profile, { name: info?.name, fetchedAt: Date.now() });
    return info?.name;
  };

  const decorateAccounts = async (accounts: AccountView[]) => {
    const enriched: AccountView[] = [];
    for (const account of accounts) {
      const appName = account.profile ? await appNameOf(account.profile) : undefined;
      enriched.push({ ...account, appName });
    }
    return enriched;
  };

  const changed = (accounts: unknown) => {
    onAccountsChanged?.();
    return accounts;
  };

  return async (method, payload) => {
    try {
      const input = asRecord(payload ?? {});
      switch (method) {
        case 'account.list':
          return { ok: true, value: { accounts: await decorateAccounts(directory.list()) } };

        case 'auth.status': {
          const active = await resolveActiveProfile();
          return {
            ok: true,
            value: {
              configured: active !== undefined,
              profile: active?.name,
              appId: active?.appId,
            },
          };
        }

        case 'auth.configure': {
          // 应用配置需要用户在浏览器完成；这里返回链接后由前端轮询 auth.status。
          // 配置阶段还没有 profile，因此不传 --profile，由 lark-cli 新建。
          const profile = typeof input.profile === 'string' ? input.profile.trim() : '';
          let resolveUrl: (url: string) => void = () => {};
          const urlReady = new Promise<string>((resolve) => { resolveUrl = resolve; });
          void startConfigInit(profile, (url) => resolveUrl(url));

          const url = await Promise.race([
            urlReady,
            new Promise<string | undefined>((resolve) => setTimeout(() => resolve(undefined), 20_000)),
          ]);
          if (!url) {
            return { ok: false, error: { code: 'config-link-missing', message: '未能生成应用配置链接，请稍后重试' } };
          }
          return { ok: true, value: { verificationUrl: url } };
        }

        case 'auth.start': {
          let profile: string;
          try {
            profile = await resolveProfile(input.profile);
          } catch (error) {
            return {
              ok: false,
              error: {
                code: 'config-required',
                message: error instanceof Error ? error.message : '尚未完成飞书应用配置',
              },
            };
          }
          const started = await startLogin(profile);
          const attempt: AuthAttempt = {
            deviceCode: started.deviceCode,
            verificationUrl: started.verificationUrl,
            phase: 'pending',
            startedAt: Date.now(),
            expiresAt: Date.now() + (started.expiresIn ?? 600) * 1000,
            profile,
          };
          const attemptId = registry.register(attempt);
          return {
            ok: true,
            value: {
              attemptId,
              verificationUrl: attempt.verificationUrl,
              expiresAt: attempt.expiresAt,
            },
          };
        }

        case 'auth.complete': {
          const attemptId = stringField(input.attemptId, 'attemptId');
          const attempt = registry.get(attemptId);
          if (!attempt) {
            return { ok: false, error: { code: 'auth-attempt-missing', message: '授权会话不存在或已过期，请重新发起授权' } };
          }
          if (registry.isExpired(attempt)) {
            registry.release(attemptId);
            return { ok: false, error: { code: 'auth-attempt-expired', message: '授权链接已过期，请重新发起授权' } };
          }

          const result = await completeLogin(attempt.profile, attempt.deviceCode);
          if (!result.ok) {
            return { ok: false, error: { code: 'auth-incomplete', message: result.error ?? '尚未完成浏览器授权' } };
          }

          const added = await directory.addIdentity({
            profile: attempt.profile,
            openId: result.openId,
            name: result.userName,
          });
          registry.release(attemptId);
          return { ok: true, value: { added, accounts: changed(await decorateAccounts(directory.list())) } };
        }

        case 'account.add': {
          const profile = await resolveProfile(input.profile);
          return {
            ok: true,
            value: { accounts: changed(await decorateAccounts(directory.list())), added: await directory.addFromProfile(profile) },
          };
        }

        case 'account.setDefault':
          return { ok: true, value: { accounts: changed(await decorateAccounts(directory.setDefault(stringField(input.id, 'id')))) } };

        case 'account.setReceive':
          return {
            ok: true,
            value: { accounts: changed(await decorateAccounts(directory.setReceive(stringField(input.id, 'id'), input.enabled === true))) },
          };

        case 'relation.sync': {
          // 同步当前账号可见的用户与群，供 @ 解析使用。
          const id = stringField(input.id, 'id');
          const account = directory.account(id);
          if (!account) return { ok: false, error: { code: 'account-missing', message: '账号不存在' } };

          const result = await syncRelations(directory.db, account);
          return { ok: true, value: { ...result, stats: relationStats(directory.db, id) } };
        }

        case 'relation.catalog': {
          // 供输入框 @ 面板使用：按账号返回已同步的关系，默认账号排在最前。
          const accounts = directory.list();
          const catalog = accounts.map((account) => ({
            accountId: account.id,
            accountName: account.name,
            appName: account.appName,
            isCurrent: account.isDefault,
            relations: relationCatalog(directory.db, account.id),
          }));
          // 当前账号置顶，其余按默认顺序。
          catalog.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
          return { ok: true, value: { accounts: catalog } };
        }

        case 'relation.stats': {
          const id = stringField(input.id, 'id');
          return { ok: true, value: { stats: relationStats(directory.db, id) } };
        }

        case 'account.remove':
          return { ok: true, value: { accounts: changed(await decorateAccounts(directory.remove(stringField(input.id, 'id')))) } };

        default:
          return { ok: false, error: { code: 'unknown-method', message: `未知的飞书账号操作：${method}` } };
      }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'account-operation-failed', message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}

function reply(rpcId: string, result: unknown): Response {
  return Response.json({ type: 'server-response', rpcId, result });
}

export function registerAccountRpc(ctx: any, handler: RpcHandler) {
  const registry = ctx?.connection?.fetch;
  if (typeof registry?.register !== 'function') {
    throw new TypeError('需要 DSH Host Connection Fetch 注册能力');
  }

  return registry.register({
    path: ACCOUNT_RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }

      let message: any;
      try {
        message = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }

      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      const call = message?.payload;
      if (
        message?.type !== 'client-request'
        || message?.method !== ACCOUNT_RPC_ENDPOINT
        || call === null
        || typeof call !== 'object'
        || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')
      ) {
        return reply(rpcId, {
          ok: false,
          error: { code: 'gateway/bad-request', message: '无效的飞书账号管理请求' },
        });
      }

      const result = await handler(call.method, call.payload);
      // Connection 的客户端要求失败结果带 details 字段。
      const normalized = result.ok ? result : { ...result, error: { ...result.error, details: {} } };
      return reply(rpcId, normalized);
    },
  });
}
