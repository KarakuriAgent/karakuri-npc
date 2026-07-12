import type { NpcStore } from '../storage/npc-store.js';
import type { Npc } from '../types/npc.js';
import { WorldApiError, WorldClient } from '../world/client.js';
import type { WebhookDispatch } from '../webhook/receiver.js';
import type { NotificationHandlers } from './npc-runtime.js';
import { NpcRuntime } from './npc-runtime.js';

const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
/** 通知 TTL（30 分）を超えた未処理 delivery は再処理しない。 */
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;

export interface NpcManagerDeps {
  store: NpcStore;
  handlers: NotificationHandlers;
  createClient: (npc: Npc) => WorldClient;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  healthIntervalMs?: number;
}

/**
 * 全 NPC の稼働管理。
 * - enabled な NPC のログイン状態を維持する（起動時 + 定期ヘルスループ + not_logged_in 検知時）
 * - webhook からの通知を NPC ごとの NpcRuntime（直列キュー）へ振り分ける
 */
export class NpcManager {
  private readonly store: NpcStore;
  private readonly handlers: NotificationHandlers;
  private readonly createClient: (npc: Npc) => WorldClient;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly healthIntervalMs: number;
  private readonly runtimes = new Map<string, NpcRuntime>();
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(deps: NpcManagerDeps) {
    this.store = deps.store;
    this.handlers = deps.handlers;
    this.createClient = deps.createClient;
    this.logger = deps.logger ?? console;
    this.healthIntervalMs = deps.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  }

  /** 初回ヘルスチェックが失敗しても定期ループとリカバリは必ず開始する。 */
  async start(): Promise<void> {
    this.healthTimer = setInterval(() => {
      this.healthCheck().catch((error) => this.logger.error('health check failed:', error));
    }, this.healthIntervalMs);
    this.healthTimer.unref();
    this.recoverUnprocessedDeliveries();
    await this.healthCheck().catch((error) => this.logger.error('initial health check failed:', error));
  }

  async stop(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.drain()));
  }

  handleWebhook(dispatch: WebhookDispatch): void {
    this.runtimeFor(dispatch.npcId).enqueueDelivery(dispatch.deliveryId);
  }

  runtimeFor(npcId: string): NpcRuntime {
    let runtime = this.runtimes.get(npcId);
    if (!runtime) {
      runtime = new NpcRuntime(npcId, {
        store: this.store,
        handlers: this.handlers,
        createClient: this.createClient,
        logger: this.logger,
      });
      this.runtimes.set(npcId, runtime);
    }
    return runtime;
  }

  /**
   * enabled な NPC をログインさせ、disabled でログイン中の NPC をログアウトさせる。
   * 各 NPC は独立した world API 呼び出しのため並列に処理する（1 体の遅延で全体を塞がない）。
   */
  async healthCheck(): Promise<void> {
    await Promise.all(
      this.store.listNpcs().map(async (npc) => {
        const runtime = this.store.getRuntime(npc.npc_id);
        try {
          if (npc.enabled && !runtime?.logged_in) {
            await this.loginNpc(npc);
          } else if (!npc.enabled && runtime?.logged_in) {
            await this.logoutNpc(npc);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[${npc.npc_id}] health check: ${message}`);
          this.store.patchRuntime(npc.npc_id, { last_error: message });
        }
      }),
    );
  }

  /**
   * ログイン実行。home_node_id があれば位置指定ログインを試み、
   * クールダウン (429) や配置不正 (400) は位置指定なしで即フォールバックする。
   */
  async loginNpc(npc: Npc): Promise<void> {
    const client = this.createClient(npc);
    let result;
    try {
      result = await client.login(npc.home_node_id ? { node_id: npc.home_node_id } : undefined);
    } catch (error) {
      if (error instanceof WorldApiError && error.code === 'state_conflict' && /logged in/i.test(error.message)) {
        // 既にログイン済み（プロセス再起動後など）。状態だけ合わせる。
        this.store.patchRuntime(npc.npc_id, { logged_in: true, last_error: null });
        return;
      }
      if (
        npc.home_node_id &&
        error instanceof WorldApiError &&
        (error.status === 429 || error.status === 400)
      ) {
        this.logger.warn(
          `[${npc.npc_id}] placed login failed (${error.code}), falling back to plain login`,
        );
        result = await client.login();
      } else {
        throw error;
      }
    }
    this.store.patchRuntime(npc.npc_id, {
      logged_in: true,
      node_id: typeof result?.node_id === 'string' ? result.node_id : null,
      agent_state: 'idle',
      last_error: null,
    });
    this.logger.info(`[${npc.npc_id}] logged in at ${result?.node_id ?? '(unknown)'}`);
  }

  async logoutNpc(npc: Npc): Promise<void> {
    const client = this.createClient(npc);
    try {
      await client.logout();
    } catch (error) {
      if (!(error instanceof WorldApiError && error.status === 409)) throw error;
      // 409 = 既にログアウト済み。状態だけ合わせる。
    }
    this.store.patchRuntime(npc.npc_id, { logged_in: false, agent_state: null });
    this.logger.info(`[${npc.npc_id}] logged out`);
  }

  /**
   * 再起動リカバリ: 未着手 (received) の delivery（通知 TTL 内）を再キューイングする。
   * processing はコマンド送信済みかどうか判別できないため再実行しない
   * （再実行すると同一通知への二重コマンドになりうる。取りこぼしは idle_reminder が保険）。
   */
  private recoverUnprocessedDeliveries(): void {
    const since = Date.now() - RECOVERY_WINDOW_MS;
    for (const delivery of this.store.listRecoverableDeliveries(since)) {
      this.logger.info(`[${delivery.npc_id}] recovering delivery ${delivery.delivery_id} (${delivery.kind})`);
      this.runtimeFor(delivery.npc_id).enqueueDelivery(delivery.delivery_id);
    }
    const abandoned = this.store.markAbandonedProcessingDeliveries(since);
    if (abandoned > 0) {
      this.logger.warn(`marked ${abandoned} in-flight deliveries as failed (command state unknown after restart)`);
    }
  }
}
