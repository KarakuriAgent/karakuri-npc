import type { NpcStore } from '../storage/npc-store.js';
import type { Npc } from '../types/npc.js';
import type { AgentNotification, AgentNotificationKind } from '../types/world.js';
import { WorldApiError, WorldClient } from '../world/client.js';
import { chooseFallbackCommand, type CommandChoice } from './handlers/fallback.js';
import { isScheduleActive } from './schedule.js';
import { applyCommandResultToMirror, applyNotificationToMirror } from './state-mirror.js';

/** 自由に行動を選べるだけの通知。スケジュール時間外は応答不要なのでログオフに直行できる。 */
const IDLE_TRIGGER_KINDS = new Set([
  'agent_logged_in',
  'movement_completed',
  'wait_completed',
  'idle_reminder',
  'info_choices',
  'server_announcement',
]);

export interface NotificationContext {
  npc: Npc;
  notificationId: string;
  notification: AgentNotification;
}

/**
 * kind 別ハンドラの決定結果。
 * 配列は優先順の候補列で、runtime が先頭から順に試し最初に受理されたものを採用する
 * （move はマップ都合で拒否されうるため候補列 + wait を返すのが典型）。null = 何もしない。
 */
export type CommandDecision = CommandChoice | CommandChoice[] | null;

/** kind 別ハンドラ。コマンド決定を返すと runtime が実行する。 */
export type NotificationHandler = (
  ctx: NotificationContext,
  runtime: NpcRuntime,
) => Promise<CommandDecision> | CommandDecision;

export type NotificationHandlers = Partial<Record<AgentNotificationKind, NotificationHandler>>;

export interface NpcRuntimeDeps {
  store: NpcStore;
  handlers: NotificationHandlers;
  createClient: (npc: Npc) => WorldClient;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** スケジュール時間外のターン境界ログオフの実行を委譲する（NpcManager.logoutNpc）。 */
  logout?: (npc: Npc) => Promise<void>;
  /** 会話中はログオフを会話終了まで先送りするための参照。未指定なら常に会話なし扱い。 */
  hasActiveConversation?: (npcId: string) => boolean;
}

/**
 * 1 NPC = 1 インスタンス。通知処理を直列化するアクター。
 * world 側もエージェント単位でコマンドを直列化しており、「1 通知 1 コマンド」を守るため
 * 並行処理は行わない。
 */
export class NpcRuntime {
  readonly npcId: string;
  private readonly store: NpcStore;
  private readonly handlers: NotificationHandlers;
  private readonly createClient: (npc: Npc) => WorldClient;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly logout: ((npc: Npc) => Promise<void>) | null;
  private readonly hasActiveConversation: (npcId: string) => boolean;
  private queue: Promise<void> = Promise.resolve();

  constructor(npcId: string, deps: NpcRuntimeDeps) {
    this.npcId = npcId;
    this.store = deps.store;
    this.handlers = deps.handlers;
    this.createClient = deps.createClient;
    this.logger = deps.logger ?? console;
    this.logout = deps.logout ?? null;
    this.hasActiveConversation = deps.hasActiveConversation ?? (() => false);
  }

  /** 通知処理をキュー末尾に積む。戻りはキュー完了を待たない。 */
  enqueueDelivery(deliveryId: string): void {
    this.queue = this.queue
      .then(() => this.processDelivery(deliveryId))
      .catch((error) => {
        this.logger.error(`[${this.npcId}] delivery ${deliveryId} failed:`, error);
      });
  }

  /** テスト・graceful shutdown 用: 現在キューに積まれた処理の完了を待つ。 */
  async drain(): Promise<void> {
    await this.queue;
  }

  private async processDelivery(deliveryId: string): Promise<void> {
    const npc = this.store.getNpc(this.npcId);
    if (!npc) {
      this.store.updateDelivery(deliveryId, { status: 'skipped', error: 'npc_deleted' });
      return;
    }
    const delivery = this.store.getDelivery(deliveryId);
    if (!delivery || delivery.status === 'done' || delivery.status === 'skipped') return;

    this.store.updateDelivery(deliveryId, { status: 'processing' });
    this.store.patchRuntime(npc.npc_id, { last_notification_at: Date.now() });

    // createClient は WORLD_BASE_URL 未設定時に throw する。処理中のまま
    // delivery を取り残さないよう、必ず failed へ落とす。
    let client: WorldClient;
    try {
      client = this.createClient(npc);
    } catch (error) {
      this.recordFailure(deliveryId, npc, 'client_create_failed', error);
      return;
    }

    let notificationId: string;
    let notification: AgentNotification;
    try {
      const fetched = await client.getNotification(delivery.notification_id);
      this.store.updateDelivery(deliveryId, { notification_json: JSON.stringify(fetched.notification) });
      if (fetched.stale) {
        // 消費済み / 置換済み / 期限切れ。コマンドは弾かれるだけなので消費しない。
        this.store.updateDelivery(deliveryId, { status: 'skipped', error: 'stale_notification' });
        return;
      }
      notificationId = fetched.notificationId;
      notification = fetched.notification;
    } catch (error) {
      this.recordFailure(deliveryId, npc, 'notification_fetch_failed', error);
      return;
    }

    // 全通知共通: perception から状態ミラー（現在地・所持金・ワールド）を更新する。
    applyNotificationToMirror(this.store, npc.npc_id, notification);

    try {
      // ダッシュボードからの手動停止は即時扱い: 会話中でも行動せずログオフする
      // （通常は healthCheck が先にログアウトさせるため、これはその隙間の通知を拾う保険）。
      if (!npc.enabled && this.logout) {
        this.logger.info(`[${npc.npc_id}] disabled, logging out at turn boundary`);
        await this.logout(npc);
        this.store.updateDelivery(deliveryId, { status: 'done', error: null });
        return;
      }

      // スケジュール時間外のターン境界ログオフ:
      // - 新しい行動（移動・待機）は起こさない
      // - 会話・アイテム授受など応答が必要な通知は設定値通り処理してから離脱する
      // - 会話中は会話が閉じた通知の処理後にログオフする
      const offSchedule = !isScheduleActive(npc.schedule, new Date());
      const inConversationBefore = this.hasActiveConversation(npc.npc_id);

      let decision: CommandDecision;
      if (offSchedule && notification.kind === 'conversation_request') {
        // ログオフ間際に始まる新規会話は（既存会話の有無によらず）受けない
        decision = { command: 'conversation_reject', params: {} };
      } else if (offSchedule && !inConversationBefore && IDLE_TRIGGER_KINDS.has(notification.kind)) {
        decision = null;
      } else {
        decision = await this.decideChoice(npc, notificationId, notification);
      }

      const inConversationAfter = this.hasActiveConversation(npc.npc_id);
      // ハンドラ内で会話が閉じた（conversation_ended 等）直後の idle 委譲行動は時間外では破棄する
      const discardDecision = offSchedule && inConversationBefore && !inConversationAfter;
      if (!discardDecision) {
        await this.executeDecision(npc, notificationId, decision, client);
      }
      if (
        offSchedule &&
        this.logout &&
        !inConversationAfter &&
        this.store.getRuntime(npc.npc_id)?.logged_in
      ) {
        this.logger.info(`[${npc.npc_id}] off schedule, logging out at turn boundary`);
        await this.logout(npc);
      }
      this.store.updateDelivery(deliveryId, { status: 'done', error: null });
    } catch (error) {
      this.recordFailure(deliveryId, npc, 'handler_failed', error);
    }
  }

  /** kind → ハンドラのルーティング。未登録 kind は安全なフォールバック（wait or 何もしない）。 */
  private async decideChoice(
    npc: Npc,
    notificationId: string,
    notification: AgentNotification,
  ): Promise<CommandDecision> {
    const handler = (this.handlers as Partial<Record<string, NotificationHandler>>)[notification.kind];
    if (handler) {
      return handler({ npc, notificationId, notification }, this);
    }
    return chooseFallbackCommand(notification, npc.movement.rest_duration);
  }

  /** 候補列を先頭から試し、最初に受理されたコマンドで確定する（1 通知 1 コマンド）。 */
  private async executeDecision(
    npc: Npc,
    notificationId: string,
    decision: CommandDecision,
    client: WorldClient,
  ): Promise<unknown> {
    if (!decision) return null;
    const candidates = Array.isArray(decision) ? decision : [decision];
    for (const [index, choice] of candidates.entries()) {
      const isLast = index === candidates.length - 1;
      const result = await this.executeCommand(npc, notificationId, choice, client, true, !isLast);
      if (result !== null) return result;
    }
    return null;
  }

  /**
   * コマンドを実行しログに記録する。stale 通知は最新通知で 1 回だけ再決定する。
   * 拒否（WorldApiError で処理継続可能なもの）は null を返し、候補列の次を試せるようにする。
   */
  async executeCommand(
    npc: Npc,
    notificationId: string,
    choice: CommandChoice,
    client: WorldClient = this.createClient(npc),
    allowStaleRetry = true,
    quietRejection = false,
  ): Promise<unknown> {
    try {
      const result = await client.command(notificationId, choice.command, choice.params);
      this.store.insertCommandLog({
        npc_id: npc.npc_id,
        notification_id: notificationId,
        command: choice.command,
        params: choice.params,
        accepted: true,
        result,
      });
      this.store.patchRuntime(npc.npc_id, { last_command_at: Date.now(), last_error: null });
      // info 系コマンドの inline data（get_status 等）を状態ミラーへ反映する。
      applyCommandResultToMirror(this.store, npc.npc_id, choice.command, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.insertCommandLog({
        npc_id: npc.npc_id,
        notification_id: notificationId,
        command: choice.command,
        params: choice.params,
        accepted: false,
        error: message,
      });
      if (error instanceof WorldApiError) {
        if (error.code === 'not_logged_in') {
          this.store.patchRuntime(npc.npc_id, { logged_in: false, last_error: 'not_logged_in' });
          throw error;
        }
        if (error.code === 'notification_stale' && allowStaleRetry) {
          const latest = this.extractLatestNotification(error);
          if (latest) {
            this.logger.warn(`[${npc.npc_id}] stale notification ${notificationId} -> retry with ${latest.id}`);
            const nextDecision = await this.decideChoice(npc, latest.id, latest.notification);
            if (!nextDecision) return null;
            const candidates = Array.isArray(nextDecision) ? nextDecision : [nextDecision];
            for (const [index, next] of candidates.entries()) {
              const result = await this.executeCommand(
                npc,
                latest.id,
                next,
                client,
                false,
                index < candidates.length - 1,
              );
              if (result !== null) return result;
            }
            return null;
          }
        }
        // state_conflict / info_already_consumed / invalid_move_target 等は
        // 次の候補または次の通知で立て直せるため握りつぶす。
        if (!quietRejection) {
          this.logger.warn(`[${npc.npc_id}] command ${choice.command} rejected: ${error.code} ${error.message}`);
          this.store.patchRuntime(npc.npc_id, { last_error: `${error.code}: ${error.message}` });
        }
        return null;
      }
      throw error;
    }
  }

  private extractLatestNotification(error: WorldApiError): { id: string; notification: AgentNotification } | null {
    const details = error.details as
      | { latest_notification_id?: unknown; latest_notification?: unknown }
      | undefined;
    if (typeof details?.latest_notification_id !== 'string' || !details.latest_notification) return null;
    return {
      id: details.latest_notification_id,
      notification: details.latest_notification as AgentNotification,
    };
  }

  private recordFailure(deliveryId: string, npc: Npc, label: string, error: unknown): void {
    const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
    this.logger.error(`[${npc.npc_id}] ${message}`);
    this.store.updateDelivery(deliveryId, { status: 'failed', error: message });
    this.store.patchRuntime(npc.npc_id, { last_error: message });
    if (error instanceof WorldApiError && error.code === 'not_logged_in') {
      this.store.patchRuntime(npc.npc_id, { logged_in: false });
    }
  }
}
