import type { AccountDirectory } from './accounts.js';

export type RpcHandler = (method: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;

const ENDPOINT = 'feishu-lark-cli';

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数必须是对象');
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 不能为空`);
  return value;
}

export const ACCOUNT_METHODS = [
  'account.list',
  'account.add',
  'account.setDefault',
  'account.setReceive',
  'account.remove',
] as const;

export function createAccountRpc(directory: AccountDirectory): RpcHandler {
  return async (method, payload) => {
    try {
      const input = asRecord(payload ?? {});
      switch (method) {
        case 'account.list':
          return { ok: true, value: { accounts: directory.list() } };
        case 'account.add':
          return { ok: true, value: { accounts: directory.list(), added: await directory.addFromProfile(stringField(input.profile, 'profile')) } };
        case 'account.setDefault':
          return { ok: true, value: { accounts: directory.setDefault(stringField(input.id, 'id')) } };
        case 'account.setReceive':
          return { ok: true, value: { accounts: directory.setReceive(stringField(input.id, 'id'), input.enabled === true) } };
        case 'account.remove':
          return { ok: true, value: { accounts: directory.remove(stringField(input.id, 'id')) } };
        default:
          return { ok: false, error: { code: 'unknown-method', message: `未知的飞书账号操作：${method}` } };
      }
    } catch (error) {
      return { ok: false, error: { code: 'account-operation-failed', message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

const RPC_PREFIX = 'dsh-feishu-lark-cli';

function reply(rpcId: string, result: unknown): Response {
  return Response.json({ type: 'server-response', rpcId, result });
}

export function registerAccountRpc(ctx: any, handler: RpcHandler) {
  const registry = ctx?.connection?.fetch;
  if (typeof registry?.register !== 'function') throw new TypeError('需要 DSH Host Connection Fetch 注册能力');
  return registry.register({
    path: `/api/${RPC_PREFIX}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let message: any;
      try { message = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      const call = message?.payload;
      if (message?.type !== 'client-request' || message?.method !== RPC_PREFIX
        || call === null || typeof call !== 'object' || typeof call.method !== 'string' || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: '无效的飞书账号管理请求' } });
      }
      const result = await handler(call.method, call.payload);
      const normalized = result.ok ? result : { ...result, error: { ...result.error, details: {} } };
      return reply(rpcId, normalized);
    },
  });
}

export const ACCOUNT_RPC_ENDPOINT = RPC_PREFIX;
