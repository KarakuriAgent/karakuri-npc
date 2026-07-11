import { z } from 'zod';

import type { ConversationParticipant, ConversationStore } from '../../storage/conversation-store.js';
import type { NpcStore } from '../../storage/npc-store.js';
import type { Npc } from '../../types/npc.js';
import type { AgentNotification } from '../../types/world.js';
import type { ConversationEngine } from '../conversation-engine.js';
import type { MemoryService } from '../memory.js';
import type { CommandChoice } from './fallback.js';
import type { NotificationHandler, NotificationHandlers } from '../npc-runtime.js';

const participantSchema = z.looseObject({ id: z.string(), name: z.string() });

const requestPayloadSchema = z.looseObject({
  conversation_id: z.string(),
  initiator_name: z.string(),
  message: z.string(),
});

const replyPayloadSchema = z.looseObject({
  conversation_id: z.string(),
  turn: z.number().optional(),
  speaker_name: z.string(),
  message: z.string(),
  participants: z.array(participantSchema).default([]),
  has_pending_transfer: z.boolean().optional(),
});

const turnPayloadSchema = z.looseObject({
  conversation_id: z.string(),
  turn: z.number().optional(),
  participants: z.array(participantSchema).default([]),
  closing: z.boolean().optional(),
  has_pending_transfer: z.boolean().optional(),
});

const fyiPayloadSchema = z.looseObject({
  speaker_name: z.string(),
  message: z.string(),
});

const inactiveCheckPayloadSchema = z.looseObject({
  conversation_id: z.string(),
});

export interface ConversationHandlersDeps {
  conversations: ConversationStore;
  engine: ConversationEngine;
  memory: MemoryService;
  /** give_enabled 時の所持品参照（状態ミラー）に使う。省略時は give 無効。 */
  store?: NpcStore | undefined;
  /** 会話終了通知に含まれる次の行動 choices の処理を委譲する（idle 契機ハンドラ）。 */
  idleHandler?: NotificationHandler | undefined;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * NPC は同時に 1 会話のみ（world 仕様）。別 conversation_id の active 会話が残っていたら、
 * ended 通知の取りこぼし/順序ずれとみなして閉じ、記憶更新を回してから新会話を進める。
 */
function closeSupersededConversations(
  deps: Pick<ConversationHandlersDeps, 'conversations' | 'memory'>,
  npc: Npc,
  currentConversationId: string,
  logger: Pick<Console, 'warn'>,
): void {
  const active = deps.conversations.getActiveConversation(npc.npc_id);
  if (!active || active.conversation_id === currentConversationId) return;
  deps.conversations.endConversation(npc.npc_id, active.conversation_id, 'superseded');
  void deps.memory.summarizeConversation(npc, active.conversation_id).catch((error) => {
    logger.warn(`[${npc.npc_id}] memory job (superseded) failed: ${String(error)}`);
  });
}

function upsertParticipants(
  conversations: ConversationStore,
  npc: Npc,
  conversationId: string,
  participants: ConversationParticipant[],
): void {
  const others = participants.filter((participant) => participant.id !== npc.agent_id);
  conversations.upsertConversation({
    conversation_id: conversationId,
    npc_id: npc.npc_id,
    participants,
    // participants 不明（payload 省略）のときは既存値を維持する
    ...(participants.length > 0 ? { counterpart_agent_id: others.length === 1 ? others[0]!.id : null } : {}),
  });
}

function resolveSpeakerAgentId(participants: ConversationParticipant[], speakerName: string): string | null {
  return participants.find((participant) => participant.name === speakerName)?.id ?? null;
}

/**
 * 通知の required_params に transfer_response が含まれる場合（会話中の譲渡オファー保留中）、
 * transfer ポリシーに従った応答を params に添える。
 * receive='llm' は v1 では accept に倒す（受け取り判断に LLM を挟むのは Phase 4 以降の課題）。
 */
function transferResponseParams(npc: Npc, notification: AgentNotification, command: string): Record<string, unknown> {
  const choice = notification.choices.find((candidate) => candidate.command === command);
  if (!choice?.required_params?.includes('transfer_response')) return {};
  return { transfer_response: npc.transfer.receive === 'always_reject' ? 'reject' : 'accept' };
}

export function createConversationHandlers(deps: ConversationHandlersDeps): NotificationHandlers {
  const { conversations, engine, memory } = deps;
  const logger = deps.logger ?? console;

  /** 自分のターン（reply / turn / closing）の共通処理。 */
  const speakTurn = async (
    npc: Npc,
    notification: AgentNotification,
    conversationId: string,
    participants: ConversationParticipant[],
    closing: boolean,
  ): Promise<CommandChoice | null> => {
    const record = conversations.getConversation(npc.npc_id, conversationId);
    const knownParticipants = participants.length > 0 ? participants : (record?.participants ?? []);

    // world 仕様: transfer（give）と transfer_response は同時指定不可。
    // 保留オファーへの応答が必要なターンでは give を無効化する。
    const speakChoice = notification.choices.find((choice) => choice.command === 'conversation_speak');
    const mustRespondTransfer = speakChoice?.required_params?.includes('transfer_response') ?? false;
    const runtime = deps.store?.getRuntime(npc.npc_id) ?? null;
    const allowGive = npc.transfer.give_enabled && !mustRespondTransfer && runtime !== null;

    const decision = await engine.decideSpeak(npc, {
      conversationId,
      participants: knownParticipants,
      perception: notification.perception,
      closing,
      allowGive,
      ...(allowGive
        ? {
            inventory: {
              money: runtime.money,
              items: (runtime.items ?? []).map((item) => ({
                item_id: item.item_id,
                name: typeof item.name === 'string' ? item.name : undefined,
              })),
            },
          }
        : {}),
    });

    conversations.insertMessage({
      conversation_id: conversationId,
      npc_id: npc.npc_id,
      speaker_agent_id: npc.agent_id,
      speaker_name: npc.name,
      is_self: true,
      message: decision.message,
    });

    // closing では speak のみが提示される。end は choices にあるときだけ使う。
    const canEnd = notification.choices.some((choice) => choice.command === 'conversation_end');
    const command = !closing && decision.end_conversation && canEnd ? 'conversation_end' : 'conversation_speak';
    return {
      command,
      params: {
        message: decision.message,
        next_speaker_agent_id: decision.next_speaker_agent_id,
        // give は speak のみに添付できる（end の schema に transfer は無い）
        ...(command === 'conversation_speak' && decision.transfer ? { transfer: decision.transfer } : {}),
        ...transferResponseParams(npc, notification, command),
      },
    };
  };

  const handleEnded = async (
    ctx: { npc: Npc; notificationId: string; notification: AgentNotification },
    runtime: Parameters<NotificationHandler>[1],
    reason: string | null,
  ) => {
    const active = conversations.getActiveConversation(ctx.npc.npc_id);
    if (active) {
      conversations.endConversation(ctx.npc.npc_id, active.conversation_id, reason);
      // 記憶更新は LLM を伴うため fire-and-forget（通知キューをブロックしない）
      void memory.summarizeConversation(ctx.npc, active.conversation_id).catch((error) => {
        logger.warn(`[${ctx.npc.npc_id}] memory job failed: ${String(error)}`);
      });
    }
    // 終了通知には次の行動 choices が付くことがある。idle 契機として委譲する。
    return deps.idleHandler ? deps.idleHandler(ctx, runtime) : null;
  };

  return {
    conversation_request: async ({ npc, notification }) => {
      const payload = requestPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) {
        logger.warn(`[${npc.npc_id}] conversation_request payload invalid, rejecting`);
        return { command: 'conversation_reject', params: {} };
      }
      const { conversation_id, initiator_name, message } = payload.data;

      if (npc.conversation.accept === 'never') {
        return { command: 'conversation_reject', params: {} };
      }

      const decision = await engine.decideAccept(npc, {
        initiatorName: initiator_name,
        message,
        perception: notification.perception,
        policyAccept: npc.conversation.accept === 'llm' ? 'llm' : true,
      });
      if (!decision.accept) {
        return { command: 'conversation_reject', params: {} };
      }

      closeSupersededConversations(deps, npc, conversation_id, logger);
      // request payload は initiator の名前しか持たない。既知の相手（記憶あり）なら
      // 名前から agent_id を逆引きし、短命会話でも記憶更新できるようにする。
      const known = conversations
        .listMemories(npc.npc_id)
        .find((memory) => memory.counterpart_name === initiator_name);
      conversations.upsertConversation({
        conversation_id,
        npc_id: npc.npc_id,
        ...(known
          ? {
              participants: [
                { id: known.counterpart_agent_id, name: initiator_name },
                { id: npc.agent_id, name: npc.name },
              ],
              counterpart_agent_id: known.counterpart_agent_id,
            }
          : {}),
      });
      conversations.insertMessage({
        conversation_id,
        npc_id: npc.npc_id,
        turn: 1,
        speaker_name: initiator_name,
        message,
      });
      conversations.insertMessage({
        conversation_id,
        npc_id: npc.npc_id,
        turn: 2,
        speaker_agent_id: npc.agent_id,
        speaker_name: npc.name,
        is_self: true,
        message: decision.message,
      });
      return { command: 'conversation_accept', params: { message: decision.message } };
    },

    conversation_reply: async ({ npc, notification }) => {
      const payload = replyPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) {
        logger.warn(`[${npc.npc_id}] conversation_reply payload invalid, skipping`);
        return null;
      }
      const { conversation_id, turn, speaker_name, message, participants } = payload.data;
      closeSupersededConversations(deps, npc, conversation_id, logger);
      upsertParticipants(conversations, npc, conversation_id, participants);
      conversations.insertMessage({
        conversation_id,
        npc_id: npc.npc_id,
        turn: turn ?? null,
        speaker_agent_id: resolveSpeakerAgentId(participants, speaker_name),
        speaker_name,
        message,
      });
      return speakTurn(npc, notification, conversation_id, participants, false);
    },

    conversation_turn: async ({ npc, notification }) => {
      const payload = turnPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) return null;
      const { conversation_id, participants } = payload.data;
      upsertParticipants(conversations, npc, conversation_id, participants);
      return speakTurn(npc, notification, conversation_id, participants, false);
    },

    conversation_closing: async ({ npc, notification }) => {
      const payload = turnPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) return null;
      // 自分が最後のメッセージ担当のときだけ speak choice が付く。無ければ記録のみ。
      if (!notification.choices.some((choice) => choice.command === 'conversation_speak')) return null;
      const { conversation_id, participants } = payload.data;
      upsertParticipants(conversations, npc, conversation_id, participants);
      return speakTurn(npc, notification, conversation_id, participants, true);
    },

    conversation_fyi: ({ npc, notification }) => {
      const payload = fyiPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) return null;
      // fyi には conversation_id が無い。NPC は同時に 1 会話のみのため active 会話に紐づける。
      const active = conversations.getActiveConversation(npc.npc_id);
      if (!active) return null;
      conversations.insertMessage({
        conversation_id: active.conversation_id,
        npc_id: npc.npc_id,
        speaker_agent_id: resolveSpeakerAgentId(active.participants, payload.data.speaker_name),
        speaker_name: payload.data.speaker_name,
        message: payload.data.message,
      });
      return null;
    },

    conversation_inactive_check: ({ npc, notification }) => {
      const payload = inactiveCheckPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) return null;
      // llm ポリシーは v1 では stay に倒す（判断コストに見合わない）
      const command = npc.conversation.inactive_check === 'leave' ? 'conversation_leave' : 'conversation_stay';
      return { command, params: {} };
    },

    conversation_ended: (ctx, runtime) => {
      const reason = typeof ctx.notification.payload?.reason === 'string' ? ctx.notification.payload.reason : null;
      return handleEnded(ctx, runtime, reason);
    },

    conversation_forced_ended: (ctx, runtime) => {
      const reason = typeof ctx.notification.payload?.reason === 'string' ? ctx.notification.payload.reason : 'forced';
      return handleEnded(ctx, runtime, reason);
    },

    // 拒否/参加取消は NPC が start/join を自発しないため通常来ないが、来ても安全に無視する。
    conversation_rejected: () => null,
    conversation_pending_join_cancelled: () => null,
  };
}
