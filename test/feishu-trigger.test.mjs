import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeishuCandidates,
  parseMentionValue,
  parseMentionRef,
  toMentionRef,
  createFeishuTriggerSource,
} from '../lib/feishu-trigger.js';

const ACCOUNTS = [
  {
    accountId: 'accA',
    accountName: '刘珂',
    appName: 'DSH牛马',
    isCurrent: true,
    relations: [
      { type: 'user', id: 'ou_a1', name: '张三', tenantKey: 'tk1' },
      { type: 'chat', id: 'oc_a2', name: '研发群' },
    ],
  },
  {
    accountId: 'accB',
    accountName: '李四',
    appName: '另一应用',
    isCurrent: false,
    relations: [
      { type: 'user', id: 'ou_b1', name: '张三', tenantKey: 'tk2' },
      { type: 'user', id: 'ou_b2', name: '王五' },
    ],
  },
];

test('候选按账号分组，当前账号排在最前', () => {
  const candidates = buildFeishuCandidates(ACCOUNTS, '');
  const sections = [...new Set(candidates.map((item) => item.section))];

  assert.equal(sections[0], '当前账号：刘珂（DSH牛马）');
  assert.equal(sections[1], '其他账号：李四（另一应用）');
  assert.equal(candidates.length, 4);
});

test('同名用户在不同账号下分属不同分组，载荷含账号', () => {
  const candidates = buildFeishuCandidates(ACCOUNTS, '张三');
  assert.equal(candidates.length, 2);
  const values = candidates.map((item) => item.value);
  assert.ok(values.includes('dsh-feishu:accA:user:ou_a1'));
  assert.ok(values.includes('dsh-feishu:accB:user:ou_b1'));
});

test('查询过滤不区分大小写并匹配空查询返回全部', () => {
  assert.equal(buildFeishuCandidates(ACCOUNTS, '研发').length, 1);
  assert.equal(buildFeishuCandidates(ACCOUNTS, '王').length, 1);
  assert.equal(buildFeishuCandidates(ACCOUNTS, '不存在').length, 0);
});

test('候选描述区分用户与群', () => {
  const candidates = buildFeishuCandidates(ACCOUNTS, '研发');
  assert.match(candidates[0].description, /群/);
  const user = buildFeishuCandidates(ACCOUNTS, '王五')[0];
  assert.match(user.description, /用户/);
});

test('mention 载荷可正确解析', () => {
  assert.deepEqual(parseMentionValue('dsh-feishu:accA:user:ou_a1'), {
    accountId: 'accA', type: 'user', id: 'ou_a1',
  });
  assert.deepEqual(parseMentionValue('dsh-feishu:accB:chat:oc_b9'), {
    accountId: 'accB', type: 'chat', id: 'oc_b9',
  });
  assert.equal(parseMentionValue('bad:value'), undefined);
  assert.equal(parseMentionValue('dsh-feishu:accA:bogus:id'), undefined);
});

test('source 定义满足 DSH 触发管线契约', async () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  assert.equal(source.trigger, '@');
  assert.equal(source.name, 'feishu');
  assert.equal(typeof source.candidates, 'function');
  assert.equal(typeof source.onPick, 'function');

  const rows = await source.candidates({}, { query: '' });
  assert.equal(rows.length, 4);
  // 每个候选都必须带 value 与 section，否则分组与回填都会失效。
  for (const row of rows) {
    assert.equal(typeof row.value, 'string');
    assert.equal(typeof row.section, 'string');
  }
});

test('onPick 返回 insertion 结果并保留 label', async () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  const rows = await source.candidates({}, { query: '张三' });
  const pick = source.onPick({ candidate: rows[0] });

  assert.equal(pick.insert.source, 'feishu');
  assert.equal(pick.insert.ref, rows[0].value);
  assert.equal(pick.insert.label, '张三');
  assert.equal(typeof pick.insert.clipboardText, 'string');
});

test('onPick 在非法载荷时返回 undefined，不产生错误插入', () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  assert.equal(source.onPick({ candidate: { value: 'garbage' } }), undefined);
});

test('候选 name 使用规范 mention，避免界面显示一长串 ID', async () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  const rows = await source.candidates({}, { query: '张三' });

  for (const row of rows) {
    // name 必须是 @[..](dsh-feishu:..) 形式，且能被解析回账号与目标。
    assert.match(row.name, /^@\[.+\]\(dsh-feishu:.+\)$/);
    assert.ok(parseMentionRef(row.name), `无法解析: ${row.name}`);
  }
});

test('插入的 ref 与候选 name 一致，保证再次解析可用', async () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  const rows = await source.candidates({}, { query: '张三' });
  const pick = source.onPick({ candidate: rows[0] });

  assert.equal(pick.insert.ref, rows[0].name);
  const parsed = parseMentionRef(pick.insert.ref);
  assert.equal(parsed.accountId, 'accA');
  assert.equal(parsed.type, 'user');
});

test('插入结果包含 appearance 与 clipboardText', async () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  const rows = await source.candidates({}, { query: '研发' });
  const pick = source.onPick({ candidate: rows[0] });

  assert.equal(typeof pick.insert.appearance, 'string');
  assert.equal(pick.insert.clipboardText, '@研发群');
});

test('codec.serialize 原样返回规范 ref，不再二次包装', async () => {
  const source = createFeishuTriggerSource({ loadAccounts: () => ACCOUNTS });
  const rows = await source.candidates({}, { query: '研发' });
  const serialized = await source.codec.serialize(rows[0].name);
  assert.equal(serialized, rows[0].name);
});

test('同名用户描述带 openId 尾部以便区分', () => {
  const candidates = buildFeishuCandidates(ACCOUNTS, '张三');
  const descriptions = candidates.map((item) => item.description);
  // 同一账号内同名时，尾 4 位必须不同，用户才能区分。
  assert.equal(new Set(descriptions).size, descriptions.length);
  for (const description of descriptions) {
    assert.match(description, /^用户 · [0-9a-zA-Z_]+$/);
  }
});

test('同名同尾位的真实场景可由 openId 全量区分载荷', () => {
  const candidates = buildFeishuCandidates(ACCOUNTS, '张三');
  const values = new Set(candidates.map((item) => item.value));
  assert.equal(values.size, candidates.length);
});

test('toMentionRef 与 parseMentionRef 互为逆运算', () => {
  const ref = toMentionRef({ accountId: 'accA', type: 'user', id: 'ou_a1' });
  assert.equal(ref, '@[accA:user:ou_a1](dsh-feishu:accA:user:ou_a1)');
  assert.deepEqual(parseMentionRef(ref), { accountId: 'accA', type: 'user', id: 'ou_a1' });
});
