import type { NpcStore } from '../storage/npc-store.js';
import type { Npc } from '../types/npc.js';
import type { AgentNotification, AgentNotificationKind } from '../types/world.js';
import { WorldApiError, WorldClient, defaultCreateClient } from '../world/client.js';
import { chooseFallbackCommand, type CommandChoice } from './handlers/fallback.js';
import { applyCommandResultToMirror, applyNotificationToMirror } from './state-mirror.js';

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
  createClient?: (npc: Npc) => WorldClient;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
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
  private queue: Promise<void> = Promise.resolve();

  constructor(npcId: string, deps: NpcRuntimeDeps) {
    this.npcId = npcId;
    this.store = deps.store;
    this.handlers = deps.handlers;
    this.createClient = deps.createClient ?? defaultCreateClient;
    this.logger = deps.logger ?? console;
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
    const client = this.createClient(npc);

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
      const decision = await this.decideChoice(npc, notificationId, notification);
      await this.executeDecision(npc, notificationId, decision, client);
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
