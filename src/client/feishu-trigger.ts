/**
 * DSH 输入框 `@` 的飞书来源。
 *
 * 挂接 `ctx.inputTriggers.registerSource()`：与文件/会话引用并列，
 * 不覆盖、不冲突。候选按账号分组（当前账号在前，其他账号在后），
 * 选中后插入一个可被 Host 识别的飞书 mention token。
 */

export const FEISHU_TRIGGER = '@';
export const FEISHU_SOURCE_NAME = 'feishu';

/** mention token 的协议前缀，Host 侧据此解析账号与目标。 */
export const FEISHU_MENTION_SCHEME = 'dsh-feishu';

export interface FeishuCandidate {
  /** 唯一标识，同时也是 mention token 的载荷。 */
  value: string;
  label: string;
  description?: string;
  /** 分组标题：当前账号 / 其他账号。 */
  section: string;
}

export interface AccountRelationView {
  accountId: string;
  accountName: string;
  appName?: string;
  isCurrent: boolean;
  relations: Array<{ type: 'user' | 'chat'; id: string; name: string; tenantKey?: string }>;
}

/**
 * 把账号关系投影成 `@` 候选。
 *
 * 分组规则：当前账号一组、其他账号各一组，标题带账号名，
 * 便于同一个人在不同账号下拥有不同关系时区分来源。
 */
export function buildFeishuCandidates(
  accounts: AccountRelationView[],
  query: string,
): FeishuCandidate[] {
  const keyword = query.trim().toLowerCase();
  const matched = (name: string) => keyword === '' || name.toLowerCase().includes(keyword);

  const ordered = [...accounts].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  const candidates: FeishuCandidate[] = [];

  for (const account of ordered) {
    const section = account.isCurrent
      ? `当前账号：${account.accountName}${account.appName ? `（${account.appName}）` : ''}`
      : `其他账号：${account.accountName}${account.appName ? `（${account.appName}）` : ''}`;

    for (const relation of account.relations) {
      if (!matched(relation.name)) continue;
      const kind = relation.type === 'user' ? '用户' : '群';
      // 同名用户靠 openId 尾部区分；群靠名称基本已唯一。
      const suffix = relation.type === 'user' ? relation.id.slice(-4) : '';
      candidates.push({
        // 载荷需要同时表达账号与目标，避免跨账号同名混淆。
        value: `${FEISHU_MENTION_SCHEME}:${account.accountId}:${relation.type}:${relation.id}`,
        label: relation.name,
        description: `${kind}${suffix ? ` · ${suffix}` : ''}`,
        section,
      });
    }
  }

  return candidates;
}

/** 解析 mention token 载荷。 */
export function parseMentionValue(value: string): {
  accountId: string;
  type: 'user' | 'chat';
  id: string;
} | undefined {
  const parts = value.split(':');
  // accountId 由 profile 与 open_id 组成，本身可能包含 `:`；协议的最后
  // 两段才是 target type 与 target id，不能再按固定 4 段解构。
  if (parts.length < 4 || parts[0] !== FEISHU_MENTION_SCHEME) return undefined;
  const type = parts.at(-2);
  const id = parts.at(-1);
  const accountId = parts.slice(1, -2).join(':');
  if (!accountId || !id || (type !== 'user' && type !== 'chat')) return undefined;
  return { accountId, type, id };
}

/**
 * 解析规范 mention 文本 `@[label](dsh-feishu:<accountId>:<type>:<id>)`。
 *
 * 候选的 name/value 与插入后的 ref 都使用这种形式，因此两个方向都要能解析。
 */
export function parseMentionRef(ref: string): {
  accountId: string;
  type: 'user' | 'chat';
  id: string;
} | undefined {
  const match = ref.match(/\(([^)]+)\)$/);
  if (!match) return undefined;
  return parseMentionValue(match[1]);
}

/** 把内部载荷转成提交给模型的规范 mention 文本。 */
export function toMentionRef(parsed: { accountId: string; type: 'user' | 'chat'; id: string } | undefined): string {
  // RPC/旧缓存中的异常候选不能让整个 @ 来源崩溃；调用方会过滤空 ref。
  if (!parsed?.accountId || !parsed.id || (parsed.type !== 'user' && parsed.type !== 'chat')) return '';
  return `@[${parsed.accountId}:${parsed.type}:${parsed.id}](dsh-feishu:${parsed.accountId}:${parsed.type}:${parsed.id})`;
}

/** 创建可注册到 DSH 触发管线的来源定义。 */
export function createFeishuTriggerSource(deps: {
  loadAccounts: () => Promise<AccountRelationView[]> | AccountRelationView[];
}) {
  return {
    trigger: FEISHU_TRIGGER,
    name: FEISHU_SOURCE_NAME,
    order: 10,
    showGroupTitle: false,
    async candidates(_session: unknown, req: { query: string }) {
      const accounts = await deps.loadAccounts();
      const candidates = buildFeishuCandidates(accounts, req.query ?? '');
      // 同名候选同时出现在多个账号时，用分组标题区分。
      return candidates.flatMap((item) => {
        // Host/RPC 数据可能在旧版本或空数据库期间缺少 value；不要让单条脏数据
        // 让整个 `@` 来源失败。规范 ref 和内部载荷两种形式都兼容。
        const parsed = parseMentionValue(item.value) ?? parseMentionRef(item.value);
        if (!parsed?.accountId || !parsed.id) return [];
        const ref = toMentionRef(parsed);
        return [{
          // name 是唯一键，必须是规范 ref；显示用 label。
          name: ref,
          label: item.label || parsed.id,
          description: item.description,
          section: item.section,
          value: ref,
        }];
      });
    },
    /**
     * 提交时的模型序列化。
     *
     * 把内部载荷还原成人类可读、Agent 可解析的 mention 文本，
     * 形如 `@[张三](dsh-feishu:accA:user:ou_a1)`，与会话引用的
     * `@[label](dsh-session:…)` 保持同一种范式。
     */
    codec: {
      clipboardText(ref: string) {
        const parsed = parseMentionValue(ref);
        return parsed ? `@${parsed.id}` : ref;
      },
      async serialize(ref: string) {
        // 插入时 ref 已经是规范形式，原样提交即可。
        return ref;
      },
    },
    onPick(pick: any) {
      const value = pick?.candidate?.value ?? '';
      const parsed = parseMentionValue(value) ?? parseMentionRef(value);
      if (!parsed) return undefined;
      const label = pick?.candidate?.label ?? parsed.id;
      // PickOutcome 需要 { insert: ReferenceInsert }；clipboardText 是复制/持久化投影。
      return {
        insert: {
          source: FEISHU_SOURCE_NAME,
          // ref 是序列化后的规范形式，而不是内部载荷，避免界面显示一长串 ID。
          ref: toMentionRef(parsed),
          label,
          appearance: 'session',
          clipboardText: `@${label}`,
        },
      };
    },
  };
}
