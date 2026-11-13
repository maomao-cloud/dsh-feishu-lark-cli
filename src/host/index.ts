import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AccountDirectory } from './accounts.js';
import { registerFeishuTools } from './tools.js';
import { createAccountRpc, registerAccountRpc } from './account-rpc.js';
import { PollingReceiver, type MessageEvent } from './message.js';
import { resolveCliPath } from './cli.js';

export const name = 'dsh-feishu-lark-cli';

/**
 * 注入 Connection（提供 ctx.connection.fetch 路由注册）与 Tools（Agent 工具注册）。
 *
 * 与 DSH-IM 5.10.0 的 Host 入口一致：插件是一个 `apply(ctx)` 函数，
 * 在 apply 内注册路由与工具，而不是导出一个 Service 子类。
 */
export const inject = ['connection', 'tools'];

function hasCommandOnPath(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function dataDirectory(): string {
  return process.env.DSH_FEISHU_LARK_CLI_DATA
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-feishu-lark-cli');
}

/** 插件内消息订阅集合，接收模块只发布，不外泄。 */
function createMessageBus() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    publish(event: MessageEvent) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 订阅者异常不影响接收
        }
      }
    },
    subscribe(sink: (event: MessageEvent) => void) {
      listeners.add(sink);
      return () => listeners.delete(sink);
    },
    clear() {
      listeners.clear();
    },
  };
}

/**
 * 让运行中的轮询接收器与账号表保持一致。
 * @param receivers 当前账号 id 到接收器的映射
 */
function syncReceivers(
  directory: AccountDirectory,
  receivers: Map<string, PollingReceiver>,
  context: { logger?: any; warnedMissingCli: { value: boolean }; publish: (event: MessageEvent) => void },
) {
  const enabled = new Set(directory.list().filter((item) => item.receiveEnabled).map((item) => item.id));

  for (const [id, receiver] of receivers) {
    if (!enabled.has(id)) {
      receiver.stop();
      receivers.delete(id);
    }
  }

  for (const id of enabled) {
    if (receivers.has(id)) continue;
    const account = directory.account(id);
    if (!account) continue;

    if (!context.warnedMissingCli.value) {
      const cli = resolveCliPath();
      if (cli === 'lark-cli' && !hasCommandOnPath('lark-cli')) {
        context.warnedMissingCli.value = true;
        context.logger?.warn?.('[dsh-feishu-lark-cli] 未找到 lark-cli，消息接收已跳过');
      }
    }

    const receiver = new PollingReceiver(directory.db, account, { intervalMs: 60_000 }, context.publish);
    receiver.start();
    receivers.set(id, receiver);
  }
}

/**
 * 飞书个人账号插件 Host 入口。
 *
 * 职责：
 *   - 打开插件私有 SQLite 并暴露账号目录；
 *   - 注册设置页使用的账号管理路由；
 *   - 注册面向 Agent 的飞书工具；
 *   - 为启用了接收的账号启动定时轮询接收器。
 */
export async function apply(ctx: any) {
  const directory = new AccountDirectory(join(dataDirectory(), 'feishu.db'));
  const bus = createMessageBus();
  const receivers = new Map<string, PollingReceiver>();
  const warnedMissingCli = { value: false };
  const logger = ctx.logger ?? console;

  const sync = () => syncReceivers(directory, receivers, {
    logger,
    warnedMissingCli,
    publish: bus.publish,
  });

  // 路由、工具与接收器都注册在 ctx 上，插件卸载时由 Cordis 统一回收。
  // 账号变化后立即同步接收器，使设置页开关即时生效。
  ctx.effect(
    () => registerAccountRpc(ctx, createAccountRpc({ directory, onAccountsChanged: sync })),
    'dsh-feishu-lark-cli: account rpc',
  );
  ctx.effect(() => registerFeishuTools(ctx, { directory }), 'dsh-feishu-lark-cli: tools');

  sync();
  // 账号变化后由账号路由触发同步，这里不额外轮询。
  ctx.effect(() => () => {
    for (const receiver of receivers.values()) receiver.stop();
    receivers.clear();
    bus.clear();
  }, 'dsh-feishu-lark-cli: receivers');

  logger.info?.('[dsh-feishu-lark-cli] 服务已挂载');
}

export { openDatabase, saveMessage, saveSentMessage, getReceiveCursor, advanceReceiveCursor } from './db.js';
export { runCli, resolveCliPath, supportsJsonFormat, larkConfigHome, larkCliEnv } from './cli.js';
export { defaultAccount, resolveContext } from './account.js';
export { resolveMention } from './relation.js';
export {
  listChats,
  pullChatMessages,
  sendMessage,
  replyMessage,
  fetchDocument,
  searchDocuments,
  normalizeMessage,
  persistReceivedMessage,
  PollingReceiver,
} from './message.js';
export { AccountDirectory } from './accounts.js';
export { syncRelations, relationStats, relationCatalog } from './sync.js';
export { parseMentions, stripMentions, sendMentionMessage } from './mention.js';
export {
  startLogin,
  completeLogin,
  parseCliJson,
  extractUrl,
  isConfigured,
  resolveActiveProfile,
  fetchAppInfo,
  startConfigInit,
  AuthRegistry,
} from './auth.js';
export {
  createAccountRpc,
  registerAccountRpc,
  ACCOUNT_METHODS,
  ACCOUNT_RPC_CHANNEL,
  ACCOUNT_RPC_ENDPOINT,
  ACCOUNT_RPC_PATH,
} from './account-rpc.js';
export { registerFeishuTools, pickAccount, resolveTarget, normalizeDocumentToken } from './tools.js';
