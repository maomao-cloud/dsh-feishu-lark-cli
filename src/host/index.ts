import { Service } from '@deepseek-ai/cordis';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AccountDirectory } from './accounts.js';
import { registerFeishuTools } from './tools.js';
import { FeishuAccountService } from './account-service.js';
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

/** 依赖 DSH 网关提供 ctx.typertGateway，Client 侧通过 ctx.remote 调用本服务。 */
export const inject = ['typertGateway', 'tools'];

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
 * Client 侧的账号管理调用走 FeishuAccountService（`@Remote` 标注），
 * 由 DSH 网关调度，不注册自定义 `/api` 路由。
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

    // 以独立插件行挂载账号服务，网关才能通过 ctx.reflect.props 发现 typertRemote 绑定。
    const serviceFiber = this.ctx.plugin(
      (serviceCtx: any) => new FeishuAccountService(serviceCtx, directory, 'feishuLarkCli'),
    );

    const disposeTools = registerFeishuTools(this.ctx, { directory });
    this.syncReceivers(directory);
    this.ctx.logger?.info?.('[dsh-feishu-lark-cli] 服务已挂载');

    return () => {
      try { disposeTools(); } catch { /* 单个清理失败不影响其它清理 */ }
      try { void serviceFiber?.dispose?.(); } catch { /* 服务卸载失败不影响接收器清理 */ }
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
export { FeishuAccountService } from './account-service.js';
export { registerFeishuTools, pickAccount, resolveTarget, normalizeDocumentToken } from './tools.js';
export default FeishuLarkCliService;
