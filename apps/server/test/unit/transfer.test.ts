import { describe, expect, it } from 'vitest';

import type { LlmService } from '../../src/llm/llm-service.js';
import { ConversationEngine } from '../../src/runtime/conversation-engine.js';
import { createConversationHandlers } from '../../src/runtime/handlers/conversation.js';
import { createTransferHandlers } from '../../src/runtime/handlers/transfer.js';
import { MemoryService } from '../../src/runtime/memory.js';
import type { NotificationContext, NpcRuntime } from '../../src/runtime/npc-runtime.js';
import { openDatabase } from '../../src/storage/database.js';
import { ConversationStore } from '../../src/storage/conversation-store.js';
import { NpcStore } from '../../src/storage/npc-store.js';
import type { AgentNotification } from '../../src/types/world.js';
import { testNotification, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function mockLlm(jsonResponses: unknown[]) {
  const remaining = [...jsonResponses];
  return {
    isConfigured: () => true,
    generate: async () => 'text',
    generateJson: async (
      _npc: unknown,
      _messages: unknown,
      schema: { safeParse: (value: unknown) => { success: boolean }; parse: (value: unknown) => unknown },
    ) => {
      const index = remaining.findIndex((r) => !(r instanceof Error) && schema.safeParse(r).success);
      if (index >= 0) return schema.parse(remaining.splice(index, 1)[0]);
      const next = remaining.shift();
      if (next instanceof Error) throw next;
      throw new Error('mock llm: no response configured');
    },
  } as unknown as LlmService;
}

function setup(jsonResponses: unknown[], npcOverrides = {}) {
  const db = openDatabase(':memory:');
  const store = new NpcStore(db);
  const conversations = new ConversationStore(db);
  const npc = store.createNpc(testNpcInput(npcOverrides));
  const engine = new ConversationEngine({ llm: mockLlm(jsonResponses), conversations, logger: silentLogger });
  const memory = new MemoryService({ conversations, engine, logger: silentLogger });
  const transferHandlers = createTransferHandlers({ store, engine, logger: silentLogger });
  const conversationHandlers = createConversationHandlers({ conversations, engine, memory, store, logger: silentLogger });
  const handlers = { ...transferHandlers, ...conversationHandlers };
  const runtime = {} as NpcRuntime;
  const call = async (kind: string, notification: AgentNotification) => {
    const handler = (handlers as Record<string, (ctx: NotificationContext, r: NpcRuntime) => unknown>)[kind];
    return handler!({ npc, notificationId: 'notif-x', notification }, runtime);
  };
  return { store, conversations, npc, call };
}

function transferRequestNotification(item: { item_id: string; quantity: number } | null, money = 0): AgentNotification {
  return testNotification({
    kind: 'transfer_request',
    payload: { transfer_id: 't-1', from_name: '太郎', item, money },
    choices: [
      { command: 'transfer_accept', label: '譲渡を受け入れる' },
      { command: 'transfer_reject', label: '譲渡を拒否する' },
    ],
  });
}

describe('transfer handlers', () => {
  it('always_accept ポリシーで受け取る', async () => {
    const { call } = setup([]);
    const decision = await call('transfer_request', transferRequestNotification({ item_id: 'bread', quantity: 1 }));
    expect(decision).toEqual({ command: 'transfer_accept', params: {} });
  });

  it('always_reject ポリシーで断る', async () => {
    const { call } = setup([], { transfer: { receive: 'always_reject' } });
    const decision = await call('transfer_request', transferRequestNotification(null, 100));
    expect(decision).toEqual({ command: 'transfer_reject', params: {} });
  });

  it('llm ポリシーは LLM 判断に従う', async () => {
    const { call } = setup([{ accept: false }], { transfer: { receive: 'llm' } });
    const decision = await call('transfer_request', transferRequestNotification(null, 100));
    expect(decision).toEqual({ command: 'transfer_reject', params: {} });
  });

  it('インベントリ満杯なら新種のアイテムを断る', async () => {
    const { store, npc, call } = setup([]);
    store.patchRuntime(npc.npc_id, {
      items: Array.from({ length: 10 }, (_, i) => ({ item_id: `item-${i}` })),
    });
    const decision = await call('transfer_request', transferRequestNotification({ item_id: 'new-item', quantity: 1 }));
    expect(decision).toEqual({ command: 'transfer_reject', params: {} });

    // 既に持っている種類（スタック）は受け取る
    const stackable = await call('transfer_request', transferRequestNotification({ item_id: 'item-3', quantity: 1 }));
    expect(stackable).toEqual({ command: 'transfer_accept', params: {} });
  });
});

describe('会話中の give', () => {
  const participants = [
    { id: 'agent-taro', name: '太郎' },
  ];

  function replyNotification(npcAgentId: string): AgentNotification {
    return testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-1',
        speaker_name: '太郎',
        message: 'お腹すいたなあ',
        participants: [...participants, { id: npcAgentId, name: 'テスト花子' }],
      },
      choices: [
        { command: 'conversation_speak', label: '返答する', required_params: ['message', 'next_speaker_agent_id'] },
        { command: 'conversation_end', label: '会話を終了する', required_params: ['message', 'next_speaker_agent_id'] },
      ],
    });
  }

  it('LLM が give を返し所持していれば transfer を添付する', async () => {
    const { store, npc, call } = setup([
      { message: 'よかったらパンをどうぞ。', next_speaker_agent_id: 'agent-taro', end_conversation: false, give: { item_id: 'bread' } },
    ]);
    store.patchRuntime(npc.npc_id, { money: 500, items: [{ item_id: 'bread', name: 'パン' }] });

    const decision = (await call('conversation_reply', replyNotification(npc.agent_id))) as {
      params: Record<string, unknown>;
    };
    expect(decision.params.transfer).toEqual({ item: { item_id: 'bread', quantity: 1 } });
  });

  it('所持していないアイテムの give は無視される', async () => {
    const { store, npc, call } = setup([
      { message: 'どうぞ。', next_speaker_agent_id: 'agent-taro', end_conversation: false, give: { item_id: 'gold-bar' } },
    ]);
    store.patchRuntime(npc.npc_id, { money: 500, items: [{ item_id: 'bread' }] });

    const decision = (await call('conversation_reply', replyNotification(npc.agent_id))) as {
      params: Record<string, unknown>;
    };
    expect(decision.params.transfer).toBeUndefined();
  });

  it('所持金を超える money の give は無視される', async () => {
    const { store, npc, call } = setup([
      { message: 'これで何か買って。', next_speaker_agent_id: 'agent-taro', end_conversation: false, give: { money: 10000 } },
    ]);
    store.patchRuntime(npc.npc_id, { money: 500, items: [] });

    const decision = (await call('conversation_reply', replyNotification(npc.agent_id))) as {
      params: Record<string, unknown>;
    };
    expect(decision.params.transfer).toBeUndefined();
  });

  it('give_enabled=false なら give は無効', async () => {
    const { store, npc, call } = setup(
      [{ message: 'どうぞ。', next_speaker_agent_id: 'agent-taro', end_conversation: false, give: { item_id: 'bread' } }],
      { transfer: { give_enabled: false } },
    );
    store.patchRuntime(npc.npc_id, { money: 500, items: [{ item_id: 'bread' }] });

    const decision = (await call('conversation_reply', replyNotification(npc.agent_id))) as {
      params: Record<string, unknown>;
    };
    expect(decision.params.transfer).toBeUndefined();
  });

  it('transfer_response が必要なターンでは give を添付しない（同時指定不可）', async () => {
    const { store, npc, call } = setup([
      { message: 'ありがとう。お返しにどうぞ。', next_speaker_agent_id: 'agent-taro', end_conversation: false, give: { item_id: 'bread' } },
    ]);
    store.patchRuntime(npc.npc_id, { money: 500, items: [{ item_id: 'bread' }] });
    const notification = testNotification({
      kind: 'conversation_reply',
      payload: {
        conversation_id: 'conv-1',
        speaker_name: '太郎',
        message: 'これあげる',
        participants: [...participants, { id: npc.agent_id, name: npc.name }],
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
    expect(decision.params.transfer).toBeUndefined();
    expect(decision.params.transfer_response).toBe('accept');
  });
});
