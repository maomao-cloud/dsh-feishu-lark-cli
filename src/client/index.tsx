/**
 * feishu-lark-cli 设置页客户端。
 *
 * 对齐 DSH-IM 已验证的多账号实现：通过 `connection.rpc.call('/api', endpoint)`
 * 调用宿主注册的精确路由，不使用需要构建期 Generator 的 Typert Remote。
 */
import * as React from 'react';

export const name = 'dsh-feishu-lark-cli-client';
export const inject = ['slots', 'connection'];

const c = React.createElement;

/** 与宿主 account-rpc.ts 保持一致：通道路径为 /api/dsh-feishu-lark-cli/feishu-lark-cli。 */
export const ACCOUNT_RPC_ENDPOINT = 'dsh-feishu-lark-cli/feishu-lark-cli';

export interface AccountItem {
  id: string;
  name: string;
  tenantName?: string;
  isDefault: boolean;
  receiveEnabled: boolean;
  authStatus: string;
  openId: string;
}

type RpcResult = { ok: boolean; value?: { accounts?: AccountItem[] }; error?: { message?: string } };

/** 账号展示名：姓名 · 机构，机构缺失时只显示姓名。 */
export function accountLabel(account: AccountItem): string {
  return account.tenantName ? `${account.name} · ${account.tenantName}` : account.name;
}

/** 接收状态文案：MVP 只有定时接收与已暂停两种。 */
export function receiveLabel(account: AccountItem): string {
  if (account.authStatus === 'expired') return '授权已过期';
  return account.receiveEnabled ? '定时接收' : '已暂停';
}

const ENDPOINTS = {
  accounts: 'account.list',
  addAccount: 'account.add',
  setDefault: 'account.setDefault',
  setReceive: 'account.setReceive',
  remove: 'account.remove',
} as const;

type Call = (method: keyof typeof ENDPOINTS, payload?: Record<string, unknown>) => Promise<{ accounts?: AccountItem[]; error?: string }>;

/** 通过 Connection 的通用 RPC 通道调用宿主账号接口。 */
export function createAccountCaller(connection: any): Call {
  return async (method, payload = {}) => {
    if (typeof connection?.rpc?.call !== 'function') {
      return { error: 'DSH 连接服务不可用，请刷新页面后再试' };
    }
    try {
      const result = (await connection.rpc.call('/api', ACCOUNT_RPC_ENDPOINT, {
        method: ENDPOINTS[method],
        payload,
      })) as RpcResult;
      if (!result?.ok) {
        return { error: result?.error?.message ?? '操作失败' };
      }
      return { accounts: result.value?.accounts };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

function AccountRow({ account, call, busy, onChange }: {
  account: AccountItem;
  call: Call;
  busy: boolean;
  onChange: (accounts: AccountItem[]) => void;
}) {
  const run = async (method: keyof typeof ENDPOINTS, payload: Record<string, unknown>) => {
    const result = await call(method, payload);
    if (result.accounts) onChange(result.accounts);
  };
  return c('li', {
    style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,.06)' },
  },
  c('span', { style: { flex: 1 } }, accountLabel(account)),
  account.isDefault ? c('span', { style: { fontSize: 12, opacity: .7 } }, '默认账号') : null,
  c('span', { style: { fontSize: 12, opacity: .7 } }, receiveLabel(account)),
  c('button', {
    type: 'button',
    disabled: busy || account.isDefault,
    onClick: () => void run('setDefault', { id: account.id }),
  }, '设为默认'),
  c('button', {
    type: 'button',
    disabled: busy,
    onClick: () => void run('setReceive', { id: account.id, enabled: !account.receiveEnabled }),
  }, account.receiveEnabled ? '暂停接收' : '开启接收'),
  c('button', {
    type: 'button',
    disabled: busy,
    onClick: () => void run('remove', { id: account.id }),
  }, '移除'));
}

export function AccountsSection({ call }: { call: Call }) {
  const [accounts, setAccounts] = React.useState<AccountItem[]>([]);
  const [busy, setBusy] = React.useState(true);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    const result = await call('accounts');
    if (result.accounts) {
      setAccounts(result.accounts);
      setError(null);
    } else {
      setError(result.error ?? '读取账号列表失败');
    }
    setBusy(false);
  }, [call]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const addAccount = async () => {
    setBusy(true);
    setNotice('正在读取 lark-cli 授权身份…');
    const result = await call('addAccount', { profile: 'default' });
    if (result.accounts) {
      setAccounts(result.accounts);
      setError(null);
      setNotice('账号已添加');
    } else {
      setError(result.error ?? '添加账号失败');
      setNotice(null);
    }
    setBusy(false);
  };

  return c('section', { style: { display: 'grid', gap: 12 } },
    c('h2', { style: { margin: 0 } }, 'feishu-lark-cli · 飞书个人账号多账号管理'),
    error ? c('p', { style: { color: '#c0392b', margin: 0 } }, error) : null,
    notice ? c('p', { style: { opacity: .7, margin: 0 } }, notice) : null,
    accounts.length === 0
      ? c('p', { style: { opacity: .7, margin: 0 } }, busy ? '加载中…' : '尚未添加飞书账号')
      : c('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } },
        accounts.map((account) => c(AccountRow, {
          key: account.id,
          account,
          call,
          busy,
          onChange: setAccounts,
        }))),
    c('div', { style: { display: 'flex', gap: 8 } },
      c('button', { type: 'button', disabled: busy, onClick: () => void addAccount() }, '添加账号'),
      c('button', { type: 'button', disabled: busy, onClick: () => void refresh() }, '刷新')));
}

export function apply(ctx: any) {
  const call = createAccountCaller(ctx.connection);
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (fn: () => () => void) => {
    const dispose = fn();
    return () => dispose?.();
  };
  effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-feishu-lark-cli',
    order: 22,
    label: () => 'feishu-lark-cli',
    inject: () => ['connection'],
  }, () => AccountsSection({ call }))), 'dsh-feishu-lark-cli: settings section');
}

export function install() {
  return { name, title: 'feishu-lark-cli' };
}
