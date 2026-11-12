import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeishuCandidates,
  parseMentionValue,
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
