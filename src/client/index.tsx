/**
 * feishu-lark-cli 设置页客户端。
 *
 * 对齐 DSH-IM 已验证的多账号实现：通过 `connection.rpc.call('/api', endpoint)`
 * 调用宿主注册的精确路由，不使用需要构建期 Generator 的 Typert Remote。
 */
import * as React from 'react';
import { createFeishuTriggerSource } from './feishu-trigger.js';

export const name = 'dsh-feishu-lark-cli-client';
export const inject = ['slots', 'connection', 'inputTriggers'];

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
  /** 所属 lark-cli profile（飞书 appId）。 */
  profile?: string;
  /** 所属飞书应用名称，用于区分同一应用下的多账号与不同应用。 */
  appName?: string;
}

type RpcResult = { ok: boolean; value?: Record<string, unknown> & { accounts?: AccountItem[] }; error?: { message?: string } };

/** 账号展示名：姓名 · 机构，机构缺失时只显示姓名。 */
export function accountLabel(account: AccountItem): string {
  return account.tenantName ? `${account.name} · ${account.tenantName}` : account.name;
}

/** 账号所属应用的展示文案：优先用应用名，缺失时回退到 profile 标识。 */
export function appLabel(account: AccountItem): string | undefined {
  if (account.appName) return account.appName;
  if (account.profile) return account.profile;
  return undefined;
}

/** 接收状态文案：MVP 只有定时接收与已暂停两种。 */
export function receiveLabel(account: AccountItem): string {
  if (account.authStatus === 'expired') return '授权已过期';
  return account.receiveEnabled ? '定时接收' : '已暂停';
}

const ENDPOINTS = {
  accounts: 'account.list',
  authStatus: 'auth.status',
  authConfigure: 'auth.configure',
  authStart: 'auth.start',
  authComplete: 'auth.complete',
  addAccount: 'account.add',
  setDefault: 'account.setDefault',
  setReceive: 'account.setReceive',
  remove: 'account.remove',
  syncRelations: 'relation.sync',
  relationCatalog: 'relation.catalog',
} as const;

type CallResult = {
  accounts?: AccountItem[];
  error?: string;
  value?: Record<string, unknown>;
};

type Call = (method: keyof typeof ENDPOINTS, payload?: Record<string, unknown>) => Promise<CallResult>;

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
      return { accounts: result.value?.accounts as AccountItem[] | undefined, value: result.value as Record<string, unknown> };
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
  c('span', { style: { flex: 1, display: 'grid', gap: 2 } },
    c('span', null, accountLabel(account)),
    appLabel(account)
      ? c('span', { style: { fontSize: 12, opacity: .6 } }, `应用：${appLabel(account)}`)
      : null),
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
    onClick: () => void run('syncRelations', { id: account.id }),
  }, '同步关系'),
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
  const [authUrl, setAuthUrl] = React.useState<string | null>(null);
  const [configured, setConfigured] = React.useState(false);
  const [profileName, setProfileName] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /** 读取应用配置状态，决定是否还需要显示「配置飞书应用」。 */
  const refreshConfigState = React.useCallback(async () => {
    const status = await call('authStatus');
    setConfigured(status.value?.configured === true);
    setProfileName(typeof status.value?.profile === 'string' ? status.value.profile : null);
  }, [call]);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    await refreshConfigState();
    const result = await call('accounts');
    if (result.accounts) {
      setAccounts(result.accounts);
      setError(null);
    } else {
      setError(result.error ?? '读取账号列表失败');
    }
    setBusy(false);
  }, [call, refreshConfigState]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const openUrl = (url: string) => {
    try {
      globalThis.open?.(url, '_blank', 'noopener,noreferrer');
    } catch {
      // 弹窗被拦截时用户仍可点击页面上的链接。
    }
  };

  /**
   * 轮询直到 predicate 返回 true 或超时。
   *
   * 每轮把已等待秒数回报给界面，避免用户只看到「加载中」而无从判断进度。
   */
  const poll = async (
    probe: () => Promise<boolean>,
    timeoutMs: number,
    onTick?: (elapsedSec: number) => void,
    intervalMs = 3000,
  ) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      onTick?.(elapsed);
      if (await probe()) return true;
    }
    return false;
  };

  /** 第一步：飞书应用配置（每个 profile 只需一次）。 */
  const configureApp = async () => {
    setBusy(true);
    setError(null);
    setNotice('正在生成飞书应用配置链接…');

    const started = await call('authConfigure');
    const url = started.value?.verificationUrl as string | undefined;
    if (!url) {
      setError(started.error ?? '无法生成应用配置链接');
      setNotice(null);
      setBusy(false);
      return;
    }

    setAuthUrl(url);
    setNotice('已打开飞书应用配置页，完成后会自动继续。');
    openUrl(url);

    const configured = await poll(
      async () => {
        const status = await call('authStatus');
        return status.value?.configured === true;
      },
      3 * 60 * 1000,
      (elapsed) => setNotice(`等待飞书应用配置完成…已等待 ${elapsed} 秒（完成后会自动继续）`),
    );

    setAuthUrl(null);
    if (configured) {
      await refreshConfigState();
      await refresh();
      setNotice('应用配置完成，现在点击「添加账号」授权你的飞书账号');
      setError(null);
    } else {
      // 超时不当作失败：可能已完成但状态未及时反映，提示用户手动刷新。
      setError('尚未检测到应用配置完成。若浏览器中已显示成功，请点「刷新」重试。');
    }
    setBusy(false);
  };

  /** 放弃当前等待，立即恢复界面，避免用户被困在「加载中」。 */
  const cancelWait = () => {
    setAuthUrl(null);
    setBusy(false);
    setNotice('已停止等待，可点「刷新」查看当前状态');
  };

  /** 第二步：个人账号授权。 */
  const startAuth = async () => {
    setBusy(true);
    setError(null);

    const status = await call('authStatus');
    if (status.value?.configured !== true) {
      setNotice(null);
      setError('请先完成「配置飞书应用」');
      setBusy(false);
      return;
    }

    setNotice('正在生成飞书授权链接…');
    const started = await call('authStart');
    const attemptId = started.value?.attemptId as string | undefined;
    const verificationUrl = started.value?.verificationUrl as string | undefined;
    if (!attemptId || !verificationUrl) {
      setError(started.error ?? '无法生成授权链接');
      setNotice(null);
      setBusy(false);
      return;
    }

    setAuthUrl(verificationUrl);
    setNotice('已打开飞书授权页，完成授权后会自动继续。请保持本页面打开。');
    openUrl(verificationUrl);

    // 轮询等待用户完成浏览器授权；最长等待 5 分钟。
    const deadline = Date.now() + 5 * 60 * 1000;
    let completed = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = await call('authComplete', { attemptId });
      if (result.accounts) {
        setAccounts(result.accounts);
        setNotice('授权成功，账号已添加');
        setError(null);
        setAuthUrl(null);
        completed = true;
        break;
      }
      if (result.error && !/尚未完成|未完成授权/.test(result.error)) {
        setError(result.error);
        setAuthUrl(null);
        completed = true;
        break;
      }
    }

    if (!completed) {
      setError('授权超时，请重新点击「添加账号」');
      setAuthUrl(null);
    }
    setBusy(false);
  };

  return c('section', { style: { display: 'grid', gap: 12 } },
    c('h2', { style: { margin: 0 } }, 'feishu-lark-cli · 飞书个人账号多账号管理'),
    error ? c('p', { style: { color: '#c0392b', margin: 0 } }, error) : null,
    notice ? c('p', { style: { opacity: .7, margin: 0 } }, notice) : null,
    authUrl ? c('p', { style: { margin: 0, display: 'flex', gap: 12, alignItems: 'center' } },
      c('a', { href: authUrl, target: '_blank', rel: 'noopener noreferrer' }, '重新打开授权页'),
      c('button', { type: 'button', onClick: () => cancelWait() }, '停止等待')) : null,
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
      // 已配置应用后隐藏该按钮，避免用户误以为需要重复配置。
      configured ? null : c('button', { type: 'button', disabled: busy, onClick: () => void configureApp() }, '配置飞书应用'),
      c('button', { type: 'button', disabled: busy, onClick: () => void startAuth() }, '添加账号'),
      c('button', { type: 'button', disabled: busy, onClick: () => void refresh() }, '刷新')),
    profileName
      ? c('p', { style: { opacity: .6, margin: 0, fontSize: 12 } }, `飞书应用：${profileName}`)
      : null);
}

export function apply(ctx: any) {
  const call = createAccountCaller(ctx.connection);

  /** 已注册来源的作用域与对应的回收函数；同一作用域只注册一次。 */
  const registeredScopes = new Map<any, () => void>();
  let disposed = false;

  const source = createFeishuTriggerSource({
    loadAccounts: async () => {
      const result = await call('relationCatalog');
      const accounts = (result.value?.accounts ?? []) as any[];
      return accounts.map((account) => ({
        accountId: account.accountId,
        accountName: account.accountName,
        appName: account.appName,
        isCurrent: account.isCurrent === true,
        relations: account.relations ?? [],
      }));
    },
  });

  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (fn: () => () => void) => {
    const dispose = fn();
    return () => dispose?.();
  };

  /**
   * 挂接输入框 `@` 管线：等 `inputTriggers` 服务就绪后再注册。
   *
   * 服务由 DSH 自带的 `@deepseek-ai/dsh-client-ui-input-trigger` 提供，
   * 与文件/会话引用并列，不覆盖。重复注册会抛错，因此已注册时静默跳过，
   * 保证插件被重新激活后仍能正常工作。
   */
  const registerTrigger = (scope: any) => {
    const registered = registeredScopes.get(scope);
    if (registered !== undefined) return registered;
    if (disposed) return () => {};
    let dispose: () => void;
    try {
      const stop = scope.inputTriggers?.registerSource(source);
      dispose = typeof stop === 'function' ? stop : () => {};
    } catch (error) {
      // 相同时机下全局来源表里已有同名来源（同一页面重复激活），不视为失败。
      if (!String(error instanceof Error ? error.message : error).includes('already registered')) throw error;
      dispose = () => {};
    }
    const release = () => {
      registeredScopes.delete(scope);
      dispose();
    };
    registeredScopes.set(scope, release);
    return release;
  };

  if (typeof ctx.inject === 'function') {
    const scopeFiber = ctx.inject(['inputTriggers'], registerTrigger);
    // 父 fiber 释放时一并回收来源，避免 HMR 重载后仍指向旧闭包。
    effect(() => () => {
      disposed = true;
      for (const [scope, release] of registeredScopes) {
        registeredScopes.delete(scope);
        release();
      }
      void scopeFiber?.dispose?.();
    }, 'dsh-feishu-lark-cli: @ source lifetime');
  }
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
