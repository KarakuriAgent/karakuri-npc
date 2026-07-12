import { randomUUID } from 'node:crypto';

import type { Db } from './database.js';
import type { DeliveryRecord, DeliveryStatus, Npc, NpcRuntimeState } from '../types/npc.js';
import {
  conversationPolicySchema,
  llmConfigSchema,
  movementConfigSchema,
  scheduleConfigSchema,
  transferPolicySchema,
} from '../types/npc.js';

interface NpcRow {
  npc_id: string;
  name: string;
  enabled: number;
  agent_id: string;
  api_key: string;
  webhook_secret: string;
  persona: string;
  rules: string;
  home_node_id: string | null;
  movement_json: string;
  conversation_json: string;
  transfer_json: string;
  llm_json: string;
  schedule_json: string;
  created_at: number;
  updated_at: number;
}

interface RuntimeRow {
  npc_id: string;
  logged_in: number;
  world_id: string | null;
  node_id: string | null;
  agent_state: string | null;
  money: number | null;
  items_json: string | null;
  last_notification_at: number | null;
  last_command_at: number | null;
  last_error: string | null;
  status_synced_at: number | null;
  logout_pending_since: number | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 破損 JSON は既定値で継続するが、設定がサイレントに戻るのを検知できるよう警告する。
    console.warn(`npc-store: broken JSON column, falling back to defaults: ${text.slice(0, 80)}`);
    return {};
  }
}

function npcFromRow(row: NpcRow): Npc {
  return {
    npc_id: row.npc_id,
    name: row.name,
    enabled: row.enabled === 1,
    agent_id: row.agent_id,
    api_key: row.api_key,
    webhook_secret: row.webhook_secret,
    persona: row.persona,
    rules: row.rules,
    home_node_id: row.home_node_id,
    movement: movementConfigSchema.parse(parseJson(row.movement_json)),
    conversation: conversationPolicySchema.parse(parseJson(row.conversation_json)),
    transfer: transferPolicySchema.parse(parseJson(row.transfer_json)),
    llm: llmConfigSchema.parse(parseJson(row.llm_json)),
    schedule: scheduleConfigSchema.parse(parseJson(row.schedule_json)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function runtimeFromRow(row: RuntimeRow): NpcRuntimeState {
  return {
    npc_id: row.npc_id,
    logged_in: row.logged_in === 1,
    world_id: row.world_id,
    node_id: row.node_id,
    agent_state: row.agent_state,
    money: row.money,
    items: row.items_json ? (parseJson(row.items_json) as NpcRuntimeState['items']) : null,
    last_notification_at: row.last_notification_at,
    last_command_at: row.last_command_at,
    last_error: row.last_error,
    status_synced_at: row.status_synced_at,
    logout_pending_since: row.logout_pending_since,
  };
}

export interface NpcCreateInput {
  name: string;
  agent_id: string;
  api_key: string;
  webhook_secret: string;
  persona?: string | undefined;
  rules?: string | undefined;
  home_node_id?: string | null | undefined;
  enabled?: boolean | undefined;
  movement?: unknown;
  conversation?: unknown;
  transfer?: unknown;
  llm?: unknown;
  schedule?: unknown;
}

export type NpcUpdateInput = { [K in keyof NpcCreateInput]?: NpcCreateInput[K] | undefined };

export class NpcStore {
  constructor(private readonly db: Db) {}

  createNpc(input: NpcCreateInput, now = Date.now()): Npc {
    const npcId = `npc-local-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO npcs(
          npc_id, name, enabled, agent_id, api_key, webhook_secret,
          persona, rules, home_node_id, movement_json, conversation_json, transfer_json, llm_json, schedule_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        npcId,
        input.name,
        input.enabled ? 1 : 0,
        input.agent_id,
        input.api_key,
        input.webhook_secret,
        input.persona ?? '',
        input.rules ?? '',
        input.home_node_id ?? null,
        JSON.stringify(movementConfigSchema.parse(input.movement ?? {})),
        JSON.stringify(conversationPolicySchema.parse(input.conversation ?? {})),
        JSON.stringify(transferPolicySchema.parse(input.transfer ?? {})),
        JSON.stringify(llmConfigSchema.parse(input.llm ?? {})),
        JSON.stringify(scheduleConfigSchema.parse(input.schedule ?? {})),
        now,
        now,
      );
    this.db
      .prepare('INSERT INTO npc_runtime(npc_id, logged_in) VALUES (?, 0)')
      .run(npcId);
    return this.getNpc(npcId)!;
  }

  updateNpc(npcId: string, patch: NpcUpdateInput, now = Date.now()): Npc | null {
    const current = this.getNpc(npcId);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled,
      agent_id: patch.agent_id ?? current.agent_id,
      api_key: patch.api_key ?? current.api_key,
      webhook_secret: patch.webhook_secret ?? current.webhook_secret,
      persona: patch.persona ?? current.persona,
      rules: patch.rules ?? current.rules,
      home_node_id: patch.home_node_id === undefined ? current.home_node_id : patch.home_node_id,
      movement: movementConfigSchema.parse(patch.movement ?? current.movement),
      conversation: conversationPolicySchema.parse(patch.conversation ?? current.conversation),
      transfer: transferPolicySchema.parse(patch.transfer ?? current.transfer),
      llm: llmConfigSchema.parse(patch.llm ?? current.llm),
      // 部分 patch で未指定フィールドが zod の default に巻き戻らないよう既存値とマージする
      schedule: scheduleConfigSchema.parse(
        patch.schedule === undefined || typeof patch.schedule !== 'object' || patch.schedule === null
          ? current.schedule
          : { ...current.schedule, ...patch.schedule },
      ),
    };
    this.db
      .prepare(
        `UPDATE npcs SET
          name = ?, enabled = ?, agent_id = ?, api_key = ?, webhook_secret = ?,
          persona = ?, rules = ?, home_node_id = ?, movement_json = ?, conversation_json = ?, transfer_json = ?,
          llm_json = ?, schedule_json = ?, updated_at = ?
        WHERE npc_id = ?`,
      )
      .run(
        next.name,
        next.enabled ? 1 : 0,
        next.agent_id,
        next.api_key,
        next.webhook_secret,
        next.persona,
        next.rules,
        next.home_node_id,
        JSON.stringify(next.movement),
        JSON.stringify(next.conversation),
        JSON.stringify(next.transfer),
        JSON.stringify(next.llm),
        JSON.stringify(next.schedule),
        now,
        npcId,
      );
    return this.getNpc(npcId);
  }

  deleteNpc(npcId: string): boolean {
    const result = this.db.prepare('DELETE FROM npcs WHERE npc_id = ?').run(npcId);
    return result.changes > 0;
  }

  getNpc(npcId: string): Npc | null {
    const row = this.db.prepare('SELECT * FROM npcs WHERE npc_id = ?').get(npcId) as NpcRow | undefined;
    return row ? npcFromRow(row) : null;
  }

  getNpcByAgentId(agentId: string): Npc | null {
    const row = this.db.prepare('SELECT * FROM npcs WHERE agent_id = ?').get(agentId) as NpcRow | undefined;
    return row ? npcFromRow(row) : null;
  }

  /** webhook 署名検証専用の軽量ルックアップ（ホットパスでフル Npc 復元を避ける）。 */
  getWebhookAuthByAgentId(agentId: string): { npc_id: string; webhook_secret: string } | null {
    const row = this.db
      .prepare('SELECT npc_id, webhook_secret FROM npcs WHERE agent_id = ?')
      .get(agentId) as { npc_id: string; webhook_secret: string } | undefined;
    return row ?? null;
  }

  listNpcs(): Npc[] {
    const rows = this.db.prepare('SELECT * FROM npcs ORDER BY created_at, npc_id').all() as NpcRow[];
    return rows.map(npcFromRow);
  }

  // ---- runtime ----

  getRuntime(npcId: string): NpcRuntimeState | null {
    const row = this.db.prepare('SELECT * FROM npc_runtime WHERE npc_id = ?').get(npcId) as RuntimeRow | undefined;
    return row ? runtimeFromRow(row) : null;
  }

  patchRuntime(npcId: string, patch: Partial<Omit<NpcRuntimeState, 'npc_id'>>): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.logged_in !== undefined) push('logged_in', patch.logged_in ? 1 : 0);
    if (patch.world_id !== undefined) push('world_id', patch.world_id);
    if (patch.node_id !== undefined) push('node_id', patch.node_id);
    if (patch.agent_state !== undefined) push('agent_state', patch.agent_state);
    if (patch.money !== undefined) push('money', patch.money);
    if (patch.items !== undefined) push('items_json', patch.items === null ? null : JSON.stringify(patch.items));
    if (patch.last_notification_at !== undefined) push('last_notification_at', patch.last_notification_at);
    if (patch.last_command_at !== undefined) push('last_command_at', patch.last_command_at);
    if (patch.last_error !== undefined) push('last_error', patch.last_error);
    if (patch.status_synced_at !== undefined) push('status_synced_at', patch.status_synced_at);
    if (patch.logout_pending_since !== undefined) push('logout_pending_since', patch.logout_pending_since);
    if (assignments.length === 0) return;
    values.push(npcId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO npc_runtime(npc_id, logged_in) VALUES (?, 0)`,
      )
      .run(npcId);
    this.db.prepare(`UPDATE npc_runtime SET ${assignments.join(', ')} WHERE npc_id = ?`).run(...values);
  }

  // ---- deliveries ----

  /** 新規 delivery を登録する。既知の delivery_id なら false（重複配送）。 */
  insertDelivery(record: Omit<DeliveryRecord, 'status' | 'error' | 'notification_json'>): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries(delivery_id, npc_id, notification_id, kind, received_at, status)
         VALUES (?, ?, ?, ?, ?, 'received')`,
      )
      .run(record.delivery_id, record.npc_id, record.notification_id, record.kind, record.received_at);
    return result.changes > 0;
  }

  updateDelivery(
    deliveryId: string,
    patch: { status?: DeliveryStatus; error?: string | null; notification_json?: string | null },
  ): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      values.push(patch.status);
    }
    if (patch.error !== undefined) {
      assignments.push('error = ?');
      values.push(patch.error);
    }
    if (patch.notification_json !== undefined) {
      assignments.push('notification_json = ?');
      values.push(patch.notification_json);
    }
    if (assignments.length === 0) return;
    values.push(deliveryId);
    this.db.prepare(`UPDATE deliveries SET ${assignments.join(', ')} WHERE delivery_id = ?`).run(...values);
  }

  getDelivery(deliveryId: string): DeliveryRecord | null {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').get(deliveryId) as
      | DeliveryRecord
      | undefined;
    return row ?? null;
  }

  listDeliveries(npcId: string, limit = 50): DeliveryRecord[] {
    return this.db
      .prepare('SELECT * FROM deliveries WHERE npc_id = ? ORDER BY received_at DESC, delivery_id LIMIT ?')
      .all(npcId, limit) as DeliveryRecord[];
  }

  /**
   * 再起動リカバリ用: 未着手 (received) かつ通知 TTL 内の delivery。
   * processing はコマンド送信済みか不明のため対象外（呼び出し側で failed へ落とす）。
   */
  listRecoverableDeliveries(since: number): DeliveryRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM deliveries
         WHERE status = 'received' AND received_at >= ?
         ORDER BY received_at, delivery_id`,
      )
      .all(since) as DeliveryRecord[];
  }

  /** 再起動時に残った processing を failed に落とす（コマンド送信済みか不明なため再実行しない）。 */
  markAbandonedProcessingDeliveries(since: number): number {
    const result = this.db
      .prepare(
        `UPDATE deliveries SET status = 'failed', error = 'abandoned_on_restart'
         WHERE status = 'processing' AND received_at >= ?`,
      )
      .run(since);
    return result.changes;
  }

  // ---- command log ----

  insertCommandLog(entry: {
    npc_id: string;
    notification_id: string | null;
    command: string;
    params: unknown;
    accepted: boolean;
    result?: unknown;
    error?: string | null;
    executed_at?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO command_log(npc_id, notification_id, command, params_json, accepted, result_json, error, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.npc_id,
        entry.notification_id,
        entry.command,
        JSON.stringify(entry.params ?? {}),
        entry.accepted ? 1 : 0,
        entry.result === undefined ? null : JSON.stringify(entry.result),
        entry.error ?? null,
        entry.executed_at ?? Date.now(),
      );
  }

  listCommandLog(npcId: string, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM command_log WHERE npc_id = ? ORDER BY executed_at DESC, id DESC LIMIT ?')
      .all(npcId, limit) as Array<Record<string, unknown>>;
  }

  /** ダッシュボードのイベントフィード用: 全 NPC 横断の直近 delivery（NPC 名付き）。 */
  listRecentDeliveriesAll(limit = 30): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT d.delivery_id, d.npc_id, n.name AS npc_name, d.kind, d.status, d.error, d.received_at
         FROM deliveries d LEFT JOIN npcs n ON n.npc_id = d.npc_id
         ORDER BY d.received_at DESC, d.delivery_id LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  /** ダッシュボードのイベントフィード用: 全 NPC 横断の直近コマンド（NPC 名付き）。 */
  listRecentCommandLogAll(limit = 30): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT c.id, c.npc_id, n.name AS npc_name, c.command, c.accepted, c.error, c.executed_at
         FROM command_log c LEFT JOIN npcs n ON n.npc_id = c.npc_id
         ORDER BY c.executed_at DESC, c.id DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  // ---- settings ----

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
