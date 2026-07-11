import type { ConversationStore } from '../storage/conversation-store.js';
import type { Npc } from '../types/npc.js';
import type { ConversationEngine } from './conversation-engine.js';

export interface MemoryServiceDeps {
  conversations: ConversationStore;
  engine: ConversationEngine;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/** 会話終了時の記憶更新ジョブ。参加者ごとに累積要約を LLM で更新する。 */
export class MemoryService {
  private readonly conversations: ConversationStore;
  private readonly engine: ConversationEngine;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(deps: MemoryServiceDeps) {
    this.conversations = deps.conversations;
    this.engine = deps.engine;
    this.logger = deps.logger ?? console;
  }

  /**
   * fire-and-forget で呼ばれる（通知キューをブロックしない）。
   * 失敗はログのみ。summarized フラグで成功後の再実行を防ぐ。
   */
  async summarizeConversation(npc: Npc, conversationId: string): Promise<void> {
    const conversation = this.conversations.getConversation(npc.npc_id, conversationId);
    if (!conversation || conversation.summarized) return;
    const messages = this.conversations.listMessages(npc.npc_id, conversationId);
    if (messages.length === 0) {
      this.conversations.markSummarized(npc.npc_id, conversationId);
      return;
    }

    const counterparts = conversation.participants.filter(
      (participant) => participant.id !== npc.agent_id && participant.id !== 'unknown',
    );
    let allOk = true;
    for (const counterpart of counterparts) {
      try {
        const existing = this.conversations.getMemory(npc.npc_id, counterpart.id);
        const summary = await this.engine.summarizeForCounterpart(
          npc,
          counterpart,
          messages,
          existing?.summary ?? null,
        );
        this.conversations.upsertMemory({
          npc_id: npc.npc_id,
          counterpart_agent_id: counterpart.id,
          counterpart_name: counterpart.name,
          summary,
        });
      } catch (error) {
        allOk = false;
        this.logger.warn(
          `[${npc.npc_id}] memory update failed for ${counterpart.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (allOk) {
      this.conversations.markSummarized(npc.npc_id, conversationId);
    }
  }
}
