import { Service } from '@deepseek-ai/cordis';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AccountDirectory } from './accounts.js';
import { registerFeishuTools } from './tools.js';
import { createAccountRpc, registerAccountRpc } from './account-rpc.js';
import { PollingReceiver, type MessageEvent } from './message.js';
import { resolveCliPath } from './cli.js';

/** 判断命令是否在 PATH 中可执行。 */
function hasCommandOnPath(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const name = 'dsh-feishu-lark-cli';

/** 设置页通过 connection 的通用 RPC 通道调用账号接口。 */
export const inject = ['connection', 'tools'];

function dataDirectory(): string {
  return process.env.DSH_FEISHU_LARK_CLI_DATA
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-feishu-lark-cli');
}

/**
 * 飞书个人账号插件的宿主服务。
 *
 * 职责：
 *   - 打开插件私有 SQLite 并暴露账号目录；
 *   - 注册面向 Agent 的飞书工具；
 *   - 为启用了接收的账号启动定时轮询接收器。
 *
 * Client 侧的账号管理调用走 `connection.fetch.register` 注册的精确路由，
 * 与 DSH-IM 的多账号实现保持同一种机制。
 */
export class FeishuLarkCliService extends Service {
  directory?: AccountDirectory;
  private receivers = new Map<string, PollingReceiver>();
  private listeners = new Set<(event: MessageEvent) => void>();
  private warnedMissingCli = false;

  /** 订阅插件内部消息事件（仅插件内可用）。 */
  onMessage(sink: (event: MessageEvent) => void): () => void {
    this.listeners.add(sink);
    return () => this.listeners.delete(sink);
  }

  private publish(event: MessageEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不影响接收
      }
    }
  }

  [Service.init]() {
    const directory = new AccountDirectory(join(dataDirectory(), 'feishu.db'));
    this.directory = directory;

    const disposeRpc = registerAccountRpc(this.ctx, createAccountRpc(directory));
    const disposeTools = registerFeishuTools(this.ctx, { directory });
    this.syncReceivers(directory);
    this.ctx.logger?.info?.('[dsh-feishu-lark-cli] 服务已挂载');

    return () => {
      try { disposeTools(); } catch { /* 单个清理失败不影响其它清理 */ }
      try { void disposeRpc?.(); } catch { /* 路由卸载失败不影响接收器清理 */ }
      this.stopReceivers();
    };
  }

  /** 让运行中的轮询接收器与账号表保持一致。 */
  syncReceivers(directory: AccountDirectory): void {
    const enabled = new Set(directory.list().filter((item) => item.receiveEnabled).map((item) => item.id));

    for (const [id, receiver] of this.receivers) {
      if (!enabled.has(id)) {
        receiver.stop();
        this.receivers.delete(id);
      }
    }

    for (const id of enabled) {
      if (this.receivers.has(id)) continue;
      const account = directory.account(id);
      if (!account) continue;

      if (!this.warnedMissingCli) {
        const cli = resolveCliPath();
        if (cli === 'lark-cli' && !hasCommandOnPath('lark-cli')) {
          this.warnedMissingCli = true;
          this.ctx.logger?.warn?.('[dsh-feishu-lark-cli] 未找到 lark-cli，消息接收已跳过');
        }
      }

      const receiver = new PollingReceiver(directory.db, account, { intervalMs: 60_000 }, (event) => {
        this.publish(event);
      });
      receiver.start();
      this.receivers.set(id, receiver);
    }
  }

  private stopReceivers(): void {
    for (const receiver of this.receivers.values()) receiver.stop();
    this.receivers.clear();
  }
}

export { openDatabase, saveMessage } from './db.js';
export { runCli, resolveCliPath, supportsJsonFormat } from './cli.js';
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
export {
  createAccountRpc,
  registerAccountRpc,
  ACCOUNT_METHODS,
  ACCOUNT_RPC_CHANNEL,
  ACCOUNT_RPC_ENDPOINT,
  ACCOUNT_RPC_PATH,
} from './account-rpc.js';
export { registerFeishuTools, pickAccount, resolveTarget, normalizeDocumentToken } from './tools.js';
export default FeishuLarkCliService;
