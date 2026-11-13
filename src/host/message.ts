import type Database from 'better-sqlite3';
import { runCli } from './cli.js';
import { advanceReceiveCursor, getReceiveCursor, saveMessage } from './db.js';
import type { Account, CliResult, ReceivedMessage } from '../shared/types.js';

/** 用户身份读取会话列表（单聊 + 群聊）。 */
/** 会话对象的最小字段集；lark-cli 实际返回更多字段，这里保留同步所需的部分。 */
export interface RawChat {
  chat_id: string;
  name?: string;
  chat_mode?: string;
  chat_type?: string;
  tenant_key?: string;
  p2p_target_id?: string;
  p2p_target_type?: string;
}

export function listChats(account: Account): Promise<CliResult<{ chats?: RawChat[] }>> {
  return runCli(['im', '+chat-list', '--types=p2p,group', '--as', 'user', '--page-all'], {
    profile: account.profile,
  });
}

/** 用户身份按会话增量拉取历史消息。 */
export function pullChatMessages(
  account: Account,
  chatId: string,
  start?: string,
  end?: string,
): Promise<CliResult<{ messages?: unknown[] }>> {
  const args = ['im', '+chat-messages-list', '--chat-id', chatId, '--as', 'user', '--order', 'asc', '--page-all'];
  if (start) args.push('--start', start);
  if (end) args.push('--end', end);
  return runCli(args, { profile: account.profile });
}

/** 用户身份发送消息到用户或会话。 */
export function sendMessage(
  account: Account,
  target: { type: 'user' | 'chat'; id: string },
  text: string,
  idempotencyKey: string,
): Promise<CliResult> {
  return runCli([
    'im',
    '+messages-send',
    target.type === 'user' ? '--user-id' : '--chat-id',
    target.id,
    '--text',
    text,
    '--as',
    'user',
    '--idempotency-key',
    idempotencyKey,
  ], { profile: account.profile });
}

/** 用户身份回复消息（可在线程内）。 */
export function replyMessage(
  account: Account,
  messageId: string,
  text: string,
  idempotencyKey: string,
): Promise<CliResult> {
  return runCli([
    'im',
    '+messages-reply',
    '--message-id',
    messageId,
    '--text',
    text,
    '--as',
    'user',
    '--idempotency-key',
    idempotencyKey,
  ], { profile: account.profile });
}

/** 用户身份读取文档正文/大纲。 */
export function fetchDocument(
  account: Account,
  doc: string,
  scope: 'full' | 'outline' = 'full',
): Promise<CliResult<{ document?: { content?: string; document_id?: string } }>> {
  return runCli([
    'docs',
    '+fetch',
    '--doc',
    doc,
    '--as',
    'user',
    '--scope',
    scope,
    '--doc-format',
    'markdown',
  ], { profile: account.profile });
}

/** 用户身份搜索文档 / Wiki / 表格。 */
export function searchDocuments(account: Account, query: string): Promise<CliResult<{ results?: unknown[] }>> {
  return runCli(['docs', '+search', '--query', query, '--as', 'user'], { profile: account.profile });
}

/** 把 lark-cli 原始消息标准化为内部消息结构。 */
export function normalizeMessage(accountId: string, raw: any): ReceivedMessage {
  return {
    accountId,
    messageId: raw.message_id,
    chatId: raw.chat_id,
    chatType: raw.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId: raw.sender?.id ?? raw.sender_id,
    messageType: raw.msg_type ?? raw.message_type ?? 'text',
    content: raw.content ?? '',
    rootId: raw.root_id ?? undefined,
    parentId: raw.parent_id ?? undefined,
    threadId: raw.thread_id ?? undefined,
    createTime: raw.create_time,
    source: 'polling',
  };
}

export interface MessageEvent {
  type: 'feishu.message.received';
  payload: ReceivedMessage;
}

export type MessageEventSink = (event: MessageEvent) => void;

/**
 * 落库并在「首次成功写入」后才发事件。
 *
 * 接收方内部事件只描述「某账号收到一条消息」，不包含任何业务处理。
 */
export function persistReceivedMessage(
  db: Database.Database,
  message: ReceivedMessage,
  onFirstInsert: MessageEventSink,
): boolean {
  const inserted = saveMessage(db, message);
  if (inserted) onFirstInsert({ type: 'feishu.message.received', payload: message });
  return inserted;
}

export interface ReceiverOptions {
  intervalMs?: number;
  /** 单轮最多处理的会话数，避免首轮全量拉取过久。 */
  chatLimit?: number;
  /** 时钟注入，便于测试单轮行为。 */
  now?: () => Date;
}

/**
 * 定时轮询接收器。
 *
 * MVP 不使用实时事件（`im.message.receive_v1` 仅支持 bot 身份），
 * 因此这里以固定间隔枚举会话并拉取历史消息，落库去重后发内部事件。
 */
export class PollingReceiver {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private inflight = false;

  constructor(
    private readonly db: Database.Database,
    private readonly account: Account,
    private readonly options: ReceiverOptions | number,
    private readonly sink: MessageEventSink,
  ) {}

  private get intervalMs(): number {
    return typeof this.options === 'number' ? this.options : this.options.intervalMs ?? 60_000;
  }

  private get chatLimit(): number {
    return typeof this.options === 'number' ? Number.POSITIVE_INFINITY : this.options.chatLimit ?? Number.POSITIVE_INFINITY;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 执行一轮拉取；上一轮未完成时直接跳过，避免任务堆积。 */
  async tick(): Promise<{ chats: number; inserted: number }> {
    if (this.inflight) return { chats: 0, inserted: 0 };
    this.inflight = true;
    let inserted = 0;
    let chats = 0;
    try {
      const listed = await listChats(this.account);
      if (!listed.ok) return { chats: 0, inserted: 0 };
      const items = listed.data?.chats ?? [];
      for (const chat of items.slice(0, this.chatLimit)) {
        if (!this.running) break;
        chats += 1;
        const cursor = getReceiveCursor(this.db, this.account.id, chat.chat_id);
        const result = await pullChatMessages(this.account, chat.chat_id, cursor);
        if (!result.ok) continue;
        let newest: string | undefined;
        for (const raw of result.data?.messages ?? []) {
          const message = normalizeMessage(this.account.id, raw);
          if (!message.messageId) continue;
          if (persistReceivedMessage(this.db, message, this.sink)) inserted += 1;
          if (message.createTime && (!newest || message.createTime > newest)) newest = message.createTime;
        }
        if (newest) advanceReceiveCursor(this.db, this.account.id, chat.chat_id, newest);
      }
    } finally {
      this.inflight = false;
    }
    return { chats, inserted };
  }
}
