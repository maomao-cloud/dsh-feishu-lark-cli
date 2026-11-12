/**
 * feishu-lark-cli 设置页客户端。
 *
 * 通过 DSH 网关的 `ctx.remote` 调用 Host 的 FeishuAccountService，
 * 不使用自定义 /api 路由。
 */
import * as React from 'react';

export const name = 'dsh-feishu-lark-cli-client';
export const inject = ['slots', 'remote'];

const c = React.createElement;

/** Host 侧 FeishuAccountService 注册的 wire namespace。 */
export const ACCOUNT_NAMESPACE = 'feishuLarkCli';

export interface AccountItem {
  id: string;
  name: string;
  tenantName?: string;
  isDefault: boolean;
  receiveEnabled: boolean;
  authStatus: string;
  openId: string;
}

type AccountsMethod = (signal?: AbortSignal) => Promise<{ ok: boolean; value?: { accounts: AccountItem[] }; error?: { message?: string } }>;

interface AccountRemote {
  accounts: AccountsMethod;
  addAccount: (profile?: string, signal?: AbortSignal) => Promise<any>;
  setDefault: (id: string, signal?: AbortSignal) => Promise<any>;
  setReceive: (id: string, enabled: boolean, signal?: AbortSignal) => Promise<any>;
  remove: (id: string, signal?: AbortSignal) => Promise<any>;
}

/** 账号展示名：姓名 · 机构，机构缺失时只显示姓名。 */
export function accountLabel(account: AccountItem): string {
  return account.tenantName ? `${account.name} · ${account.tenantName}` : account.name;
}

/** 接收状态文案：MVP 只有定时接收与已暂停两种。 */
export function receiveLabel(account: AccountItem): string {
  if (account.authStatus === 'expired') return '授权已过期';
  return account.receiveEnabled ? '定时接收' : '已暂停';
}

/** 从 ctx.remote 取账号命名空间；缺失时返回 undefined 由界面提示。 */
export function accountRemote(ctx: any): AccountRemote | undefined {
  try {
    return ctx?.remote?.feishuLarkCli;
  } catch {
    return undefined;
  }
}

type Call = (method: keyof AccountRemote, ...args: unknown[]) => Promise<{ accounts?: AccountItem[]; error?: string }>;

export function createAccountCaller(remote: AccountRemote | undefined): Call {
  return async (method, ...args) => {
    if (!remote || typeof (remote as any)[method] !== 'function') {
      return { error: '飞书账号服务未就绪，请重启 DSH 后再试' };
    }
    try {
      const result = await (remote as any)[method](...args);
      if (result?.ok === false) {
        return { error: result.error?.message ?? '操作失败' };
      }
      return { accounts: result?.value?.accounts };
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
  const run = async (method: keyof AccountRemote, ...args: unknown[]) => {
    const result = await call(method, ...args);
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
    onClick: () => void run('setDefault', account.id),
  }, '设为默认'),
  c('button', {
    type: 'button',
    disabled: busy,
    onClick: () => void run('setReceive', account.id, !account.receiveEnabled),
  }, account.receiveEnabled ? '暂停接收' : '开启接收'),
  c('button', {
    type: 'button',
    disabled: busy,
    onClick: () => void run('remove', account.id),
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
    const result = await call('addAccount', 'default');
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
  const remote = accountRemote(ctx);
  const call = createAccountCaller(remote);
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (fn: () => () => void) => {
    const dispose = fn();
    return () => dispose?.();
  };
  effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-feishu-lark-cli',
    order: 22,
    label: () => 'feishu-lark-cli',
    inject: () => ['remote'],
  }, () => AccountsSection({ call }))), 'dsh-feishu-lark-cli: settings section');
}

export function install() {
  return { name, title: 'feishu-lark-cli' };
}
