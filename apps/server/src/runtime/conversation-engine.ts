import { z } from 'zod';

import type { LlmService } from '../llm/llm-service.js';
import type { LlmMessage } from '../llm/provider.js';
import type { ConversationMessage, ConversationParticipant, ConversationStore } from '../storage/conversation-store.js';
import type { Npc } from '../types/npc.js';
import type { AgentNotificationPerception } from '../types/world.js';

/** LLM が会話ターンで返す構造化出力。 */
export const speakDecisionSchema = z.object({
  message: z.string().min(1),
  next_speaker_agent_id: z.string().optional(),
  end_conversation: z.boolean().optional().default(false),
});
export type SpeakDecision = z.infer<typeof speakDecisionSchema>;

export const acceptDecisionSchema = z.object({
  accept: z.boolean(),
  message: z.string().min(1),
});
export type AcceptDecision = z.infer<typeof acceptDecisionSchema>;

const summarySchema = z.object({ summary: z.string().min(1) });

export interface ConversationSituation {
  perception?: AgentNotificationPerception | undefined;
  participants: ConversationParticipant[];
  conversationId: string;
  closing?: boolean;
}

const FALLBACK_REPLIES = ['そうなんですね。', 'なるほど…。', 'ふむふむ。'];
const FALLBACK_GREETING = 'こんにちは。どうしましたか？';
const FALLBACK_FAREWELL = 'それでは、また。';

export interface ConversationEngineDeps {
  llm: LlmService;
  conversations: ConversationStore;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * 会話の LLM 意思決定。プロンプトは「ペルソナ + 状況 + 相手の記憶 + 履歴（会話をまたいだ
 * 直近 max_history_pairs 往復 + 現在の会話全文）」で構築する。
 * LLM 失敗時は定型文へフォールバックし、会話をタイムアウトで殺さないことを最優先にする。
 */
export class ConversationEngine {
  private readonly llm: LlmService;
  private readonly conversations: ConversationStore;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(deps: ConversationEngineDeps) {
    this.llm = deps.llm;
    this.conversations = deps.conversations;
    this.logger = deps.logger ?? console;
  }

  /** 会話着信への受諾判定と初回返答の生成。 */
  async decideAccept(
    npc: Npc,
    input: { initiatorName: string; message: string; perception?: AgentNotificationPerception | undefined; policyAccept: boolean | 'llm' },
  ): Promise<AcceptDecision> {
    const system = this.buildSystemPrompt(npc, {
      perception: input.perception,
      participants: [{ id: 'unknown', name: input.initiatorName }],
      conversationId: '',
    });
    const judgeInstruction =
      input.policyAccept === 'llm'
        ? 'あなたの役割・状況に照らして会話を受けるか決めてください。特別な理由がなければ受けるのが自然です。'
        : '会話は必ず受諾します（accept は true 固定）。';
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `${input.initiatorName} があなたに話しかけてきました:\n「${input.message}」\n\n${judgeInstruction}\n受諾する場合は最初の返答メッセージを、拒否する場合も message には断りの一言を入れてください。`,
      },
    ];
    try {
      const decision = await this.llm.generateJson(
        npc,
        messages,
        acceptDecisionSchema,
        '{"accept": boolean, "message": "返答メッセージ(1〜3文)"}',
      );
      if (input.policyAccept !== 'llm') decision.accept = true;
      return decision;
    } catch (error) {
      this.logger.warn(`[${npc.npc_id}] accept decision LLM failed, fallback greeting: ${String(error)}`);
      return { accept: true, message: FALLBACK_GREETING };
    }
  }

  /** 自分のターンでの発言・次話者・終了判断。 */
  async decideSpeak(npc: Npc, situation: ConversationSituation): Promise<SpeakDecision> {
    const others = situation.participants.filter((p) => p.id !== npc.agent_id);
    const history = this.buildHistory(npc, situation);
    const system = this.buildSystemPrompt(npc, situation);

    const task = situation.closing
      ? 'あなたが最後のメッセージ（お別れの言葉）を送る番です。短い別れの挨拶を返してください。'
      : 'あなたが発言する番です。会話の流れに沿って自然に返答してください。話題が尽きた・切り上げるべきと感じたら end_conversation を true にしてください。';
    const nextSpeakerNote = others.length > 0
      ? `next_speaker_agent_id は次に話してほしい相手の agent_id（${others.map((p) => `${p.id}=${p.name}`).join(', ')}）から選んでください。`
      : '';

    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'system', content: `${task}\n${nextSpeakerNote}` },
    ];
    try {
      const decision = await this.llm.generateJson(
        npc,
        messages,
        speakDecisionSchema,
        '{"message": "発言(1〜3文)", "next_speaker_agent_id": "agent_id", "end_conversation": boolean}',
      );
      return this.normalizeSpeakDecision(npc, decision, others, situation);
    } catch (error) {
      this.logger.warn(`[${npc.npc_id}] speak decision LLM failed, fallback reply: ${String(error)}`);
      const fallbackMessage = situation.closing
        ? FALLBACK_FAREWELL
        : FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]!;
      return this.normalizeSpeakDecision(
        npc,
        { message: fallbackMessage, end_conversation: false },
        others,
        situation,
      );
    }
  }

  /** 会話終了後の相手ごとの記憶更新。新しい累積要約を返す。 */
  async summarizeForCounterpart(
    npc: Npc,
    counterpart: ConversationParticipant,
    transcript: ConversationMessage[],
    existingSummary: string | null,
  ): Promise<string> {
    const log = transcript
      .map((m) => `${m.is_self ? npc.name : (m.speaker_name ?? '相手')}: ${m.message}`)
      .join('\n');
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: `あなたは「${npc.name}」の記憶を管理するアシスタントです。${npc.name} が「${counterpart.name}」について覚えておくべきことを、これまでの記憶と今回の会話から更新してください。人物像・約束・重要な出来事を中心に、400字以内の日本語でまとめます。`,
      },
      {
        role: 'user',
        content: `# これまでの記憶\n${existingSummary ?? '(初対面。まだ記憶はない)'}\n\n# 今回の会話\n${log}\n\n更新後の記憶を返してください。`,
      },
    ];
    const result = await this.llm.generateJson(
      npc,
      messages,
      summarySchema,
      '{"summary": "更新後の記憶(400字以内)"}',
    );
    return result.summary.slice(0, 1000);
  }

  /**
   * next_speaker の正当性を保証する。LLM 出力が参加者に無い場合は直近の相手発言者、
   * それも無ければ最初の他参加者に倒す。参加者情報が空（payload に participants が
   * 無いターン再開など）のときは、履歴中の非自己発言者の agent_id を最後の頼りにする。
   */
  private normalizeSpeakDecision(
    npc: Npc,
    decision: { message: string; next_speaker_agent_id?: string | undefined; end_conversation: boolean },
    others: ConversationParticipant[],
    situation: ConversationSituation,
  ): SpeakDecision {
    const validIds = new Set(others.map((p) => p.id));
    let next = decision.next_speaker_agent_id;
    if (!next || (validIds.size > 0 && !validIds.has(next))) {
      const messages = this.conversations.listMessages(npc.npc_id, situation.conversationId);
      const lastOther = messages
        .filter((m) => !m.is_self && m.speaker_agent_id && (validIds.size === 0 || validIds.has(m.speaker_agent_id)))
        .at(-1);
      next = lastOther?.speaker_agent_id ?? others[0]?.id ?? npc.agent_id;
    }
    return {
      message: decision.message,
      next_speaker_agent_id: next,
      end_conversation: decision.end_conversation,
    };
  }

  private buildSystemPrompt(npc: Npc, situation: ConversationSituation): string {
    const sections: string[] = [];
    sections.push(
      `あなたは仮想世界「からくりワールド」の住人「${npc.name}」です。世界には他の住人が暮らしており、話しかけられたら会話をします。`,
    );
    if (npc.persona.trim()) {
      sections.push(`# あなたの役割・人格\n${npc.persona.trim()}`);
    }
    if (npc.llm.system_prompt_extra?.trim()) {
      sections.push(npc.llm.system_prompt_extra.trim());
    }

    const p = situation.perception;
    if (p) {
      const parts: string[] = [];
      const location = p.current_node?.location_label ?? p.current_node?.label ?? p.current_node?.node_id;
      if (location) parts.push(`現在地: ${location}`);
      if (p.world_time) parts.push(`時刻: ${p.world_time}`);
      if (p.weather?.condition) parts.push(`天気: ${p.weather.condition}`);
      if (parts.length > 0) sections.push(`# 現在の状況\n${parts.join(' / ')}`);
    }

    const others = situation.participants.filter((part) => part.id !== npc.agent_id);
    if (others.length > 0) {
      const memoryLines = others.map((other) => {
        const memory = this.conversations.getMemory(npc.npc_id, other.id);
        return `- ${other.name}: ${memory?.summary ?? '(初対面。まだ記憶はない)'}`;
      });
      sections.push(`# 会話相手についての記憶\n${memoryLines.join('\n')}`);
    }

    sections.push(
      '# 会話のスタイル\n- 1〜3文の自然な日本語で話す\n- 役割・人格から外れない\n- 相手の発言に噛み合った返答をする',
    );
    return sections.join('\n\n');
  }

  /**
   * LLM に渡す会話履歴。1:1 会話では同じ相手との過去会話も
   * max_history_pairs 往復（×2 メッセージ）まで先頭に含める。
   */
  private buildHistory(npc: Npc, situation: ConversationSituation): LlmMessage[] {
    const limit = npc.conversation.max_history_pairs * 2;
    const current = this.conversations.listMessages(npc.npc_id, situation.conversationId);
    const others = situation.participants.filter((p) => p.id !== npc.agent_id);

    let past: ConversationMessage[] = [];
    if (others.length === 1) {
      past = this.conversations.listPastMessagesWithCounterpart(
        npc.npc_id,
        others[0]!.id,
        situation.conversationId,
        Math.max(0, limit - current.length),
      );
    }

    const combined = [...past, ...current].slice(-limit);
    const group = situation.participants.length > 2;
    return combined.map((m): LlmMessage => {
      if (m.is_self) return { role: 'assistant', content: m.message };
      const name = m.speaker_name ?? '相手';
      return { role: 'user', content: group ? `${name}: ${m.message}` : m.message };
    });
  }
}
