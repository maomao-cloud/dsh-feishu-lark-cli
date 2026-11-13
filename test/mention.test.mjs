import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, stripMentions } from '../lib/index.js';

test('解析序列化形式的飞书 mention', () => {
  const text = '@[张三](dsh-feishu:accA:user:ou_a1) 会议改到三点';
  const mentions = parseMentions(text);

  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].accountId, 'accA');
  assert.equal(mentions[0].type, 'user');
  assert.equal(mentions[0].id, 'ou_a1');
  assert.equal(mentions[0].label, '张三');
});

test('解析群 mention', () => {
  const mentions = parseMentions('@[研发群](dsh-feishu:accB:chat:oc_9) 明天上线');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].type, 'chat');
  assert.equal(mentions[0].id, 'oc_9');
});

test('解析含冒号账号 ID 的 mention，供真实发送链路使用', () => {
  const mentions = parseMentions('@[姜玉伟](dsh-feishu:cli_aa5441b4bbf9dcec:07154a7e:user:ou_92dce599fed1dae4f4e44a9626680899) 33335455');
  assert.deepEqual(mentions[0], {
    accountId: 'cli_aa5441b4bbf9dcec:07154a7e',
    type: 'user',
    id: 'ou_92dce599fed1dae4f4e44a9626680899',
    raw: '@[姜玉伟](dsh-feishu:cli_aa5441b4bbf9dcec:07154a7e:user:ou_92dce599fed1dae4f4e44a9626680899)',
    label: '姜玉伟',
  });
});

test('支持一条消息多个 mention', () => {
  const text = '@[张三](dsh-feishu:accA:user:ou_a1) @[李四](dsh-feishu:accB:user:ou_b1) 请确认';
  const mentions = parseMentions(text);
  assert.equal(mentions.length, 2);
  assert.equal(mentions[1].accountId, 'accB');
});

test('忽略非本插件的引用与非法载荷', () => {
  assert.equal(parseMentions('@[readme.md](dsh-file:src/readme.md) 看看').length, 0);
  assert.equal(parseMentions('@[坏](dsh-feishu:bogus)').length, 0);
  assert.equal(parseMentions('@[类型错](dsh-feishu:accA:bogus:id)').length, 0);
});

test('剔除 mention 后保留纯正文', () => {
  const text = '@[张三](dsh-feishu:accA:user:ou_a1) 会议改到三点';
  const mentions = parseMentions(text);
  assert.equal(stripMentions(text, mentions), '会议改到三点');
});

test('多个 mention 全部剔除', () => {
  const text = '@[张三](dsh-feishu:accA:user:ou_a1) @[研发群](dsh-feishu:accA:chat:oc_1) 明天上线';
  const mentions = parseMentions(text);
  assert.equal(stripMentions(text, mentions), '明天上线');
});

test('正文为空时剔除结果为空白', () => {
  const text = '@[张三](dsh-feishu:accA:user:ou_a1)';
  const mentions = parseMentions(text);
  assert.equal(stripMentions(text, mentions), '');
});
