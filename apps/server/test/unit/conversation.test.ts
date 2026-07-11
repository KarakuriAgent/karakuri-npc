import { describe, expect, it } from 'vitest';

import type { LlmService } from '../../src/llm/llm-service.js';
import { ConversationEngine, type SpeakDecision } from '../../src/runtime/conversation-engine.js';
import { createConversationHandlers } from '../../src/runtime/handlers/conversation.js';
import { MemoryService } from '../../src/runtime/memory.js';
import type { NotificationContext, NpcRuntime } from '../../src/runtime/npc-runtime.js';
import { openDatabase } from '../../src/storage/database.js';
import { ConversationStore } from '../../src/storage/conversation-store.js';
import { NpcStore } from '../../src/storage/npc-store.js';
import type { AgentNotification } from '../../src/types/world.js';
import { testNotification, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * generateJson の応答を差し替えられる LlmService モック。
 * 本物と同様に schema 検証を行い、要求 schema に合致する未消費レスポンスを返す
 * （fire-and-forget の記憶要約と speak が並行しても順序に依存しない）。
 */
function mockLlm(jsonResponses: unknown[]) {
  const remaining = [...jsonResponses];
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  return {
    calls,
    service: {
      isConfigured: () => true,
      generate: async () => 'text',
      generateJson: async (
        _npc: unknown,
        messages: Array<{ role: string; content: string }>,
        schema: { safeParse: (value: unknown) => { success: boolean }; parse: (value: unknown) => unknown },
      ) => {
        calls.push({ messages });
        const index = remaining.findIndex((r) => !(r instanceof Error) && schema.safeParse(r).success);
        if (index >= 0) return schema.parse(remaining.splice(index, 1)[0]);
        const next = remaining.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('mock llm: no response configured');
        return schema.parse(next);
      },
    } as unknown as LlmService,
  };
}

function setup(jsonResponses: unknown[], npcOverrides = {}) {
  const db = openDatabase(':memory:');
  const store = new NpcStore(db);
  const conversations = new ConversationStore(db);
  const npc = store.createNpc(testNpcInput(npcOverrides));
  const { service, calls } = mockLlm(jsonResponses);
  const engine = new ConversationEngine({ llm: service, conversations, logger: silentLogger });
  const memory = new MemoryService({ conversations, engine, logger: silentLogger });
  const handlers = createConversationHandlers({ conversations, engine, memory, logger: silentLogger });
  const runtime = {} as NpcRuntime;
  const call = async (kind: string, notification: AgentNotification) => {
    const handler = (handlers as Record<string, (ctx: NotificationContext, r: NpcRuntime) => unknown>)[kind];
    return handler!({ npc, notificationId: 'notif-x', notification }, runtime);
  };
  return { store, conversations, npc, calls, call, handlers };
}

const replyChoices = [
  { command: 'conversation_speak', label: '返答する', required_params: ['message', 'next_speaker_agent_id'] },
  { command: 'conversation_end', label: '会話を終了する', required_params: ['message', 'next_speaker_agent_id'] },
];

describe('conversation handlers', () => {
  it('conversation_request: 受諾して挨拶を返し、履歴に記録する', async () => {
    const { conversations, npc, call } = setup([{ accept: true, message: 'いらっしゃい。' }]);
    const notification = testNotification({
      kind: 'conversation_request',
      payload: { conversation_id: 'conv-1', initiator_name: '太郎', message: 'こんにちは' },
      choices: [
        { command: 'conversation_accept', label: '受諾', required_params: ['message'] },
        { command: 'conversation_reject', label: '拒否' },
      ],
    });

    const decision = await call('conversation_request', notification);
    expect(decision).toEqual({ command: 'conversation_accept', params: { message: 'いらっしゃい。' } });

    const messages = conversations.listMessages(npc.npc_id, 'conv-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ speaker_name: '太郎', message: 'こんにちは', is_self: false });
    expect(messages[1]).toMatchObject({ speaker_name: npc.name, message: 'いらっしゃい。', is_self: true });
  });

  it('conversation_request: policy=never は拒否する', async () => {
    const { call } = setup([], { conversation: { accept: 'never' } });
    const notification = testNotification({
      kind: 'conversation_request',
      payload: { conversation_id: 'conv-1', initiator_name: '太郎', message: 'こんにちは' },
    });
    expect(await call('conversation_request', notification)).toEqual({
      command: 'conversation_reject',
      params: {},
    });
  });

  it('conversation_reply: 相手の発言を記録し、LLM の返答で speak する', async () => {
    const { conversations, npc, call } = setup([
      { message: 'パンが焼けましたよ。', next_speaker_agent_id: 'agent-taro', end_conversation: false },
    ]);
    const participants = [
      { id: 'agent-taro', name: '太郎' },
      { id: npc.agent_id, name: npc.name },
    ];
    const notification = testNotification({
      kind: 'conversation_reply',
      payload: { conversation_id: 'conv-1', turn: 3, speaker_name: '太郎', message: 'おすすめは？', participants },
      choices: replyChoices,
    });

    const decision = await call('conversation_reply', notification);
    expect(decision).toEqual({
      command: 'conversation_speak',
      params: { message: 'パンが焼けましたよ。', next_speaker_agent_id: 'agent-taro' },
    });

    const record = conversations.getConversation(npc.npc_id, 'conv-1');
    expect(record?.counterpart_agent_id).toBe('agent-taro');
    const messages = conversations.listMessages(npc.npc_id, 'conv-1');
    expect(messages[0]).toMatchObject({ speaker_agent_id: 'agent-taro', message: 'おすすめは？' });
    expect(messages[1]).toMatchObject({ is_self: true, message: 'パンが焼けましたよ。' });
  });

  it('conversation_reply: end_conversation=true なら conversation_end を返す', async () => {
    const { call, npc } = setup([
      { message: 'ではまた。', next_speaker_agent_id: 'agent-taro', end_conversation: true },
    ]);
    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-1',
        speaker_name: '太郎',
        message: 'そろそろ行きますね',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
      },
      choices: replyChoices,
    });
    const decision = (await call('conversation_reply', notification)) as { command: string };
    expect(decision.command).toBe('conversation_end');
  });

  it('conversation_reply: LLM が無効な next_speaker を返したら参加者へ正規化する', async () => {
    const { call, npc } = setup([
      { message: 'こんにちは。', next_speaker_agent_id: 'nonexistent-agent', end_conversation: false },
    ]);
    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-1',
        speaker_name: '太郎',
        message: 'やあ',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
      },
      choices: replyChoices,
    });
    const decision = (await call('conversation_reply', notification)) as { params: { next_speaker_agent_id: string } };
    expect(decision.params.next_speaker_agent_id).toBe('agent-taro');
  });

  it('conversation_reply: LLM 失敗時は定型文でフォールバックし会話を維持する', async () => {
    const { call, npc } = setup([new Error('llm down')]);
    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-1',
        speaker_name: '太郎',
        message: 'やあ',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
      },
      choices: replyChoices,
    });
    const decision = (await call('conversation_reply', notification)) as {
      command: string;
      params: { message: string; next_speaker_agent_id: string };
    };
    expect(decision.command).toBe('conversation_speak');
    expect(decision.params.message.length).toBeGreaterThan(0);
    expect(decision.params.next_speaker_agent_id).toBe('agent-taro');
  });

  it('has_pending_transfer の required_params に従い transfer_response を添える', async () => {
    const { call, npc } = setup([
      { message: 'ありがとう!', next_speaker_agent_id: 'agent-taro', end_conversation: false },
    ]);
    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-1',
        speaker_name: '太郎',
        message: 'これあげる',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
        has_pending_transfer: true,
      },
      choices: [
        {
          command: 'conversation_speak',
          label: '返答する',
          required_params: ['message', 'next_speaker_agent_id', 'transfer_response'],
        },
      ],
    });
    const decision = (await call('conversation_reply', notification)) as { params: Record<string, unknown> };
    expect(decision.params.transfer_response).toBe('accept');
  });

  it('conversation_closing: お別れの言葉を speak する', async () => {
    const { call, npc } = setup([
      { message: 'またいらしてください。', next_speaker_agent_id: 'agent-taro', end_conversation: false },
    ]);
    const notification = testNotification({
      kind: 'conversation_closing',
      payload: {
        conversation_id: 'conv-1',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
        closing: true,
      },
      choices: [{ command: 'conversation_speak', label: 'お別れのメッセージを送る', required_params: ['message', 'next_speaker_agent_id'] }],
    });
    const decision = (await call('conversation_closing', notification)) as { command: string };
    expect(decision.command).toBe('conversation_speak');
  });

  it('conversation_fyi: active 会話に記録のみ', async () => {
    const { conversations, npc, call } = setup([]);
    conversations.upsertConversation({
      conversation_id: 'conv-1',
      npc_id: npc.npc_id,
      participants: [
        { id: 'agent-taro', name: '太郎' },
        { id: 'agent-jiro', name: '次郎' },
        { id: npc.agent_id, name: npc.name },
      ],
    });
    const notification = testNotification({
      kind: 'conversation_fyi',
      payload: { speaker_name: '次郎', message: 'ぼくも混ぜて' },
      choices: [],
    });
    expect(await call('conversation_fyi', notification)).toBeNull();
    const messages = conversations.listMessages(npc.npc_id, 'conv-1');
    expect(messages[0]).toMatchObject({ speaker_agent_id: 'agent-jiro', message: 'ぼくも混ぜて' });
  });

  it('conversation_inactive_check: ポリシーに従い stay/leave', async () => {
    const stay = setup([], { conversation: { inactive_check: 'stay' } });
    const notification = testNotification({
      kind: 'conversation_inactive_check',
      payload: { conversation_id: 'conv-1' },
    });
    expect(await stay.call('conversation_inactive_check', notification)).toEqual({
      command: 'conversation_stay',
      params: {},
    });
    const leave = setup([], { conversation: { inactive_check: 'leave' } });
    expect(await leave.call('conversation_inactive_check', notification)).toEqual({
      command: 'conversation_leave',
      params: {},
    });
  });

  it('conversation_ended: 会話を閉じ、記憶要約を実行する', async () => {
    const { conversations, npc, call } = setup([{ summary: '太郎はパンが好き。常連になりそう。' }]);
    conversations.upsertConversation({
      conversation_id: 'conv-1',
      npc_id: npc.npc_id,
      participants: [
        { id: 'agent-taro', name: '太郎' },
        { id: npc.agent_id, name: npc.name },
      ],
      counterpart_agent_id: 'agent-taro',
    });
    conversations.insertMessage({ conversation_id: 'conv-1', npc_id: npc.npc_id, speaker_name: '太郎', message: 'パン好きなんだ' });

    const notification = testNotification({ kind: 'conversation_ended', payload: { reason: 'ended_by_agent' }, choices: [] });
    await call('conversation_ended', notification);
    // 記憶要約は fire-and-forget のため完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(conversations.getConversation(npc.npc_id, 'conv-1')?.status).toBe('ended');
    const memoryRecord = conversations.getMemory(npc.npc_id, 'agent-taro');
    expect(memoryRecord?.summary).toContain('太郎');
    expect(conversations.getConversation(npc.npc_id, 'conv-1')?.summarized).toBe(true);
  });

  it('別会話の reply が来たら残留していた active 会話を superseded で閉じる', async () => {
    const { conversations, npc, call } = setup([
      { message: 'こんにちは。', next_speaker_agent_id: 'agent-taro', end_conversation: false },
      { summary: '次郎と少し話した。' },
    ]);
    // ended 通知を取りこぼした旧会話
    conversations.upsertConversation({
      conversation_id: 'conv-old',
      npc_id: npc.npc_id,
      participants: [
        { id: 'agent-jiro', name: '次郎' },
        { id: npc.agent_id, name: npc.name },
      ],
      counterpart_agent_id: 'agent-jiro',
    });
    conversations.insertMessage({ conversation_id: 'conv-old', npc_id: npc.npc_id, speaker_name: '次郎', message: 'やあ' });

    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-new',
        speaker_name: '太郎',
        message: 'こんにちは',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
      },
      choices: replyChoices,
    });
    await call('conversation_reply', notification);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(conversations.getConversation(npc.npc_id, 'conv-old')?.status).toBe('ended');
    expect(conversations.getConversation(npc.npc_id, 'conv-old')?.end_reason).toBe('superseded');
    expect(conversations.getActiveConversation(npc.npc_id)?.conversation_id).toBe('conv-new');
  });

  it('conversation_request: 記憶のある相手は名前から agent_id を逆引きして紐づける', async () => {
    const { conversations, npc, call } = setup([{ accept: true, message: 'お久しぶりです。' }]);
    conversations.upsertMemory({
      npc_id: npc.npc_id,
      counterpart_agent_id: 'agent-taro',
      counterpart_name: '太郎',
      summary: '常連客。カレーパンが好き。',
    });
    const notification = testNotification({
      kind: 'conversation_request',
      payload: { conversation_id: 'conv-2', initiator_name: '太郎', message: 'また来たよ' },
    });
    await call('conversation_request', notification);

    expect(conversations.getConversation(npc.npc_id, 'conv-2')?.counterpart_agent_id).toBe('agent-taro');
  });

  it('過去会話の履歴が次の会話のプロンプトに含まれる（15往復まで）', async () => {
    const { conversations, npc, call, calls } = setup([
      { message: 'また来てくれたんですね。', next_speaker_agent_id: 'agent-taro', end_conversation: false },
    ]);
    // 過去の 1:1 会話
    conversations.upsertConversation({
      conversation_id: 'conv-old',
      npc_id: npc.npc_id,
      participants: [
        { id: 'agent-taro', name: '太郎' },
        { id: npc.agent_id, name: npc.name },
      ],
      counterpart_agent_id: 'agent-taro',
    });
    conversations.insertMessage({ conversation_id: 'conv-old', npc_id: npc.npc_id, speaker_agent_id: 'agent-taro', speaker_name: '太郎', message: 'カレーパンが好きなんだ' });
    conversations.insertMessage({ conversation_id: 'conv-old', npc_id: npc.npc_id, speaker_agent_id: npc.agent_id, is_self: true, message: '覚えておきますね' });
    conversations.endConversation(npc.npc_id, 'conv-old', 'ended_by_agent');

    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-new',
        speaker_name: '太郎',
        message: 'また来たよ',
        participants: [
          { id: 'agent-taro', name: '太郎' },
          { id: npc.agent_id, name: npc.name },
        ],
      },
      choices: replyChoices,
    });
    await call('conversation_reply', notification);

    const prompt = calls[0]!.messages;
    const historyTexts = prompt.filter((m) => m.role !== 'system').map((m) => m.content);
    expect(historyTexts).toContain('カレーパンが好きなんだ');
    expect(historyTexts).toContain('覚えておきますね');
    expect(historyTexts).toContain('また来たよ');
  });
});
