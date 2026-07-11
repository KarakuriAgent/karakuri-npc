import type { Db } from './database.js';

export interface ConversationParticipant {
  id: string;
  name: string;
}

export interface ConversationRecord {
  conversation_id: string;
  npc_id: string;
  participants: ConversationParticipant[];
  counterpart_agent_id: string | null;
  status: 'active' | 'ended';
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  summarized: boolean;
}

export interface ConversationMessage {
  id: number;
  conversation_id: string;
  npc_id: string;
  turn: number | null;
  speaker_agent_id: string | null;
  speaker_name: string | null;
  is_self: boolean;
  message: string;
  created_at: number;
}

export interface MemoryRecord {
  npc_id: string;
  counterpart_agent_id: string;
  counterpart_name: string | null;
  summary: string;
  conversation_count: number;
  last_talked_at: number | null;
  updated_at: number;
}

interface ConversationRow {
  conversation_id: string;
  npc_id: string;
  participants_json: string;
  counterpart_agent_id: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  summarized: number;
}

function conversationFromRow(row: ConversationRow): ConversationRecord {
  let participants: ConversationParticipant[] = [];
  try {
    const parsed = JSON.parse(row.participants_json);
    if (Array.isArray(parsed)) participants = parsed as ConversationParticipant[];
  } catch {
    participants = [];
  }
  return {
    conversation_id: row.conversation_id,
    npc_id: row.npc_id,
    participants,
    counterpart_agent_id: row.counterpart_agent_id,
    status: row.status === 'ended' ? 'ended' : 'active',
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
    summarized: row.summarized === 1,
  };
}

interface MessageRow extends Omit<ConversationMessage, 'is_self'> {
  is_self: number;
}

function messageFromRow(row: MessageRow): ConversationMessage {
  return { ...row, is_self: row.is_self === 1 };
}

/** 会話・メッセージ・記憶の永続化。npc_id 単位で分離される。 */
export class ConversationStore {
  constructor(private readonly db: Db) {}

  /**
   * 会話行を作成または更新する（participants は空でない値で上書き）。
   * counterpart_agent_id は undefined = 既存維持、null / 文字列 = その値で上書き
   * （グループ化で 1:1 相手が解除されるケースを null で表現できるようにする）。
   */
  upsertConversation(input: {
    conversation_id: string;
    npc_id: string;
    participants?: ConversationParticipant[];
    counterpart_agent_id?: string | null;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations(conversation_id, npc_id, participants_json, counterpart_agent_id, status, started_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT(conversation_id, npc_id) DO UPDATE SET
           participants_json = CASE WHEN excluded.participants_json != '[]' THEN excluded.participants_json ELSE conversations.participants_json END`,
      )
      .run(
        input.conversation_id,
        input.npc_id,
        JSON.stringify(input.participants ?? []),
        input.counterpart_agent_id ?? null,
        now,
      );
    if (input.counterpart_agent_id !== undefined) {
      this.db
        .prepare('UPDATE conversations SET counterpart_agent_id = ? WHERE npc_id = ? AND conversation_id = ?')
        .run(input.counterpart_agent_id, input.npc_id, input.conversation_id);
    }
  }

  getConversation(npcId: string, conversationId: string): ConversationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE npc_id = ? AND conversation_id = ?')
      .get(npcId, conversationId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  /** NPC が現在参加している会話（NPC は同時に 1 会話のみという world 仕様に依存）。 */
  getActiveConversation(npcId: string): ConversationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE npc_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1")
      .get(npcId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  endConversation(npcId: string, conversationId: string, reason: string | null, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE conversations SET status = 'ended', ended_at = ?, end_reason = ?
         WHERE npc_id = ? AND conversation_id = ? AND status = 'active'`,
      )
      .run(now, reason, npcId, conversationId);
  }

  markSummarized(npcId: string, conversationId: string): void {
    this.db
      .prepare('UPDATE conversations SET summarized = 1 WHERE npc_id = ? AND conversation_id = ?')
      .run(npcId, conversationId);
  }

  listConversations(npcId: string, limit = 50): ConversationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations WHERE npc_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(npcId, limit) as ConversationRow[];
    return rows.map(conversationFromRow);
  }

  insertMessage(input: {
    conversation_id: string;
    npc_id: string;
    turn?: number | null;
    speaker_agent_id?: string | null;
    speaker_name?: string | null;
    is_self?: boolean;
    message: string;
    now?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_messages(conversation_id, npc_id, turn, speaker_agent_id, speaker_name, is_self, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversation_id,
        input.npc_id,
        input.turn ?? null,
        input.speaker_agent_id ?? null,
        input.speaker_name ?? null,
        input.is_self ? 1 : 0,
        input.message,
        input.now ?? Date.now(),
      );
  }

  listMessages(npcId: string, conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_messages WHERE npc_id = ? AND conversation_id = ? ORDER BY id')
      .all(npcId, conversationId) as MessageRow[];
    return rows.map(messageFromRow);
  }

  /**
   * 同じ相手との過去の 1:1 会話のメッセージを、直近 limit 件を古い順（時系列）で返す。
   * excludeConversationId には現在の会話を渡す。
   */
  listPastMessagesWithCounterpart(
    npcId: string,
    counterpartAgentId: string,
    excludeConversationId: string,
    limit: number,
  ): ConversationMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM conversation_messages m
         JOIN conversations c ON c.npc_id = m.npc_id AND c.conversation_id = m.conversation_id
         WHERE m.npc_id = ? AND c.counterpart_agent_id = ? AND m.conversation_id != ?
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(npcId, counterpartAgentId, excludeConversationId, limit) as MessageRow[];
    return rows.map(messageFromRow).reverse();
  }

  // ---- memories ----

  getMemory(npcId: string, counterpartAgentId: string): MemoryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE npc_id = ? AND counterpart_agent_id = ?')
      .get(npcId, counterpartAgentId) as MemoryRecord | undefined;
    return row ?? null;
  }

  listMemories(npcId: string): MemoryRecord[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE npc_id = ? ORDER BY updated_at DESC')
      .all(npcId) as MemoryRecord[];
  }

  upsertMemory(input: {
    npc_id: string;
    counterpart_agent_id: string;
    counterpart_name?: string | null;
    summary: string;
    last_talked_at?: number;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO memories(npc_id, counterpart_agent_id, counterpart_name, summary, conversation_count, last_talked_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(npc_id, counterpart_agent_id) DO UPDATE SET
           counterpart_name = COALESCE(excluded.counterpart_name, memories.counterpart_name),
           summary = excluded.summary,
           conversation_count = memories.conversation_count + 1,
           last_talked_at = excluded.last_talked_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.npc_id,
        input.counterpart_agent_id,
        input.counterpart_name ?? null,
        input.summary,
        input.last_talked_at ?? now,
        now,
      );
  }

  deleteMemory(npcId: string, counterpartAgentId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM memories WHERE npc_id = ? AND counterpart_agent_id = ?')
      .run(npcId, counterpartAgentId);
    return result.changes > 0;
  }

  /** WebUI 用: 記憶の手動編集（conversation_count を増やさない）。 */
  setMemorySummary(npcId: string, counterpartAgentId: string, summary: string, now = Date.now()): boolean {
    const result = this.db
      .prepare('UPDATE memories SET summary = ?, updated_at = ? WHERE npc_id = ? AND counterpart_agent_id = ?')
      .run(summary, now, npcId, counterpartAgentId);
    return result.changes > 0;
  }
}
