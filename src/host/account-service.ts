import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { AccountDirectory, AccountView } from './accounts.js';
import { resolveMention } from './relation.js';
import { fetchDocument, searchDocuments, sendMessage } from './message.js';
import { pickAccount, resolveTarget, normalizeDocumentToken } from './tools.js';

export interface AccountsResult {
  accounts: AccountView[];
}

export interface AddAccountResult {
  accounts: AccountView[];
  added: AccountView;
}

export interface SimpleResult {
  message: string;
}

/**
 * 飞书账号管理与操作服务。
 *
 * 通过 `@Remote` 暴露给 DSH 网关，由 `ctx.remote` 在 Client 侧调用；
 * 不注册自定义 `/api` 路由，遵循 DSH 的 Typert Remote 约定。
 */
export class FeishuAccountService extends TypertRemoteService {
  private readonly directory: AccountDirectory;

  constructor(ctx: any, directory: AccountDirectory, namespace = 'feishuLarkCli') {
    super(ctx, namespace);
    this.directory = directory;
  }

  @Remote
  async accounts(): Promise<AccountsResult> {
    return { accounts: this.directory.list() };
  }

  /**
   * 读取当前 lark-cli 授权身份并登记为飞书账号。
   * @param profile - lark-cli profile 名，默认为 default
   */
  @Remote
  async addAccount(profile = 'default'): Promise<AddAccountResult> {
    const added = await this.directory.addFromProfile(profile);
    return { accounts: this.directory.list(), added };
  }

  @Remote
  async setDefault(id: string): Promise<AccountsResult> {
    return { accounts: this.directory.setDefault(id) };
  }

  @Remote
  async setReceive(id: string, enabled: boolean): Promise<AccountsResult> {
    return { accounts: this.directory.setReceive(id, enabled) };
  }

  @Remote
  async remove(id: string): Promise<AccountsResult> {
    return { accounts: this.directory.remove(id) };
  }

  /**
   * 以个人身份发送消息。
   * @param text - 消息正文
   * @param user - 接收人 open_id，与 chat/mention 三选一
   * @param chat - 目标会话 chat_id
   * @param mention - 按当前账号可见关系匹配姓名
   * @param accountId - 使用的账号，省略用默认账号
   */
  @Remote
  async send(text: string, user?: string, chat?: string, mention?: string, accountId?: string): Promise<SimpleResult> {
    const account = pickAccount(this.directory, accountId);
    const target = resolveTarget(this.directory.db, account, { user, chat, mention });
    await sendMessage(account, target, text, `fsl-${Date.now()}`);
    return { message: `已通过「${account.name}」向 ${target.name} 发送消息` };
  }

  /**
   * 读取云文档内容。
   * @param doc - 文档链接或 token
   * @param outline - 只读大纲
   * @param accountId - 使用的账号，省略用默认账号
   */
  @Remote
  async readDocument(doc: string, outline = false, accountId?: string): Promise<SimpleResult> {
    const account = pickAccount(this.directory, accountId);
    const result = await fetchDocument(account, normalizeDocumentToken(doc), outline ? 'outline' : 'full');
    return { message: result.data?.document?.content ?? '文档为空' };
  }

  /**
   * 搜索文档 / Wiki / 表格。
   * @param query - 关键词
   * @param accountId - 使用的账号，省略用默认账号
   */
  @Remote
  async searchDocuments(query: string, accountId?: string): Promise<SimpleResult> {
    const account = pickAccount(this.directory, accountId);
    const result = await searchDocuments(account, query);
    const results = (result.data?.results ?? []) as any[];
    if (results.length === 0) return { message: '没有匹配的文档' };
    return {
      message: results
        .map((item) => `${item.title_highlighted ?? item.result_meta?.title ?? '(无标题)'} — ${item.result_meta?.url ?? ''}`)
        .join('\n'),
    };
  }

  /**
   * 按当前账号可见关系解析 @ 目标。
   * @param mention - 姓名或群名关键词
   * @param accountId - 使用的账号，省略用默认账号
   */
  @Remote
  async resolveMention(mention: string, accountId?: string): Promise<SimpleResult> {
    const account = pickAccount(this.directory, accountId);
    const matches = resolveMention(this.directory.db, account.id, mention);
    if (matches.length === 0) return { message: `「${account.name}」下没有匹配「${mention}」的用户或群` };
    return {
      message: matches
        .map((item) => `${item.type === 'user' ? '用户' : '群'} ${item.name} (${item.id})`)
        .join('\n'),
    };
  }
}
