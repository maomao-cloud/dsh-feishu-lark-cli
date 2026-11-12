import { Service } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AccountDirectory } from './accounts.js';
import { createAccountRpc, registerAccountRpc } from './account-rpc.js';
import { registerFeishuTools } from './tools.js';
import { PollingReceiver, type MessageEvent } from './message.js';
import { resolveCliPath } from './cli.js';
import { execFileSync } from 'node:child_process';

/** 判断命令是否在 PATH 中可执行。 */
function hasCommandOnPath(command: string): boolean {
  try {
    const isWindows = process.platform === 'win32';
    execFileSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const name = 'dsh-feishu-lark-cli';
export const inject = ['connection'];

function dataDirectory(): string {
  return process.env.DSH_FEISHU_LARK_CLI_DATA
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'integrations', 'dsh-feishu-lark-cli');
}

/**
 * 飞书个人账号插件的宿主服务。
 *
 * 职责：
 *   - 打开插件私有 SQLite 并暴露账号目录；
 *   - 挂载设置页使用的账号管理 RPC；
 *   - 注册面向 Agent 的飞书工具；
 *   - 为启用了接收的账号启动定时轮询接收器。
 */
export class FeishuLarkCliService extends Service {
  directory?: AccountDirectory;
  private receivers = new Map<string, PollingReceiver>();
  private listeners = new Set<(event: MessageEvent) => void>();
  private warnedMissingCli = false;

  /** 订阅插件内部消息事件（仅插件内可用，不注册到 DSH 全局事件总线）。 */
  onMessage(sink: (event: MessageEvent) => void): () => void {
    this.listeners.add(sink);
    return () => this.listeners.delete(sink);
  }

  private publish(event: MessageEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* 订阅者异常不影响接收 */ }
    }
  }

  [Service.init]() {
    const directory = new AccountDirectory(join(dataDirectory(), 'feishu.db'));
    this.directory = directory;

    const rpc = createAccountRpc(directory);
    // 账号变化后同步接收器：设置页添加/移除账号或开关接收都必须即时生效。
    const rpcWithSync = async (method: string, payload: unknown) => {
      const result = await rpc(method, payload);
      if (result.ok) this.syncReceivers(directory);
      return result;
    };

    const disposers = [
      registerAccountRpc(this.ctx, rpcWithSync),
      registerFeishuTools(this.ctx, { directory }),
    ];
    this.syncReceivers(directory);

    this.ctx.logger?.info?.('[dsh-feishu-lark-cli] 账号管理接口与工具已挂载');

    return () => {
      for (const dispose of disposers) {
        try { dispose?.(); } catch { /* 单个清理失败不影响其它清理 */ }
      }
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
        // 未安装 lark-cli 时只提示一次，避免每个账号重复告警。
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
