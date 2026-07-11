import { z } from 'zod';

import type { ConversationStore } from '../../storage/conversation-store.js';
import type { NpcStore } from '../../storage/npc-store.js';
import type { Npc } from '../../types/npc.js';
import type { ConversationEngine } from '../conversation-engine.js';
import type { NotificationHandler, NotificationHandlers } from '../npc-runtime.js';

/** world 設定 economy.max_inventory_slots の既定値。超過見込みの受け取りは断る。 */
const DEFAULT_MAX_INVENTORY_SLOTS = 10;

const transferRequestPayloadSchema = z.looseObject({
  from_name: z.string(),
  item: z.looseObject({ item_id: z.string(), quantity: z.number() }).nullable().optional(),
  money: z.number().optional(),
});

const transferResultPayloadSchema = z.looseObject({
  partner_name: z.string().optional(),
  item: z.looseObject({ item_id: z.string(), quantity: z.number() }).nullable().optional(),
  money: z.number().optional(),
  received: z.boolean().optional(),
});

export interface TransferHandlersDeps {
  store: NpcStore;
  /** 授受の事実を相手の記憶へ追記するのに使う（既知の相手のみ。名前→agent_id 逆引き）。 */
  conversations?: ConversationStore | undefined;
  /** receive='llm' のときの受け取り判断に使う。未指定なら accept に倒す。 */
  engine?: ConversationEngine | undefined;
  /** transfer 結果通知に付く次の行動 choices の処理を委譲する（idle 契機ハンドラ）。 */
  idleHandler?: NotificationHandler | undefined;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * 成立した授受を相手の記憶に一行追記する（LLM は使わない機械的追記）。
 * payload は名前ベースのため、記憶がある既知の相手のみ対象（未知の相手はスキップ）。
 */
function appendTransferMemory(
  deps: TransferHandlersDeps,
  npc: Npc,
  partnerName: string,
  note: string,
): void {
  const conversations = deps.conversations;
  if (!conversations) return;
  const memory = conversations
    .listMemories(npc.npc_id)
    .find((record) => record.counterpart_name === partnerName);
  if (!memory) return;
  const summary = `${memory.summary}\n${note}`.slice(0, 1000);
  conversations.setMemorySummary(npc.npc_id, memory.counterpart_agent_id, summary);
}

function describeTransfer(item: { item_id: string; quantity: number } | null | undefined, money: number | undefined): string {
  if (item) return `${item.item_id}×${item.quantity}`;
  if (money) return `${money}円`;
  return '何か';
}

/**
 * 単独（会話外）の譲渡ハンドラ群。
 * 受け取りは TransferPolicy.receive に従う。会話中の譲渡は conversation ハンドラ側で
 * transfer_response / give として処理される。
 */
export function createTransferHandlers(deps: TransferHandlersDeps): NotificationHandlers {
  const logger = deps.logger ?? console;

  const decideReceive = async (npc: Npc, summary: string, fromName: string): Promise<boolean> => {
    if (npc.transfer.receive === 'always_reject') return false;
    if (npc.transfer.receive === 'llm' && deps.engine) {
      try {
        return await deps.engine.decideTransferReceive(npc, { fromName, offerSummary: summary });
      } catch (error) {
        logger.warn(`[${npc.npc_id}] transfer receive LLM failed, accepting: ${String(error)}`);
        return true;
      }
    }
    return true;
  };

  return {
    transfer_request: async ({ npc, notification }) => {
      const payload = transferRequestPayloadSchema.safeParse(notification.payload ?? {});
      if (!payload.success) {
        logger.warn(`[${npc.npc_id}] transfer_request payload invalid, rejecting`);
        return { command: 'transfer_reject', params: {} };
      }

      // インベントリ上限（world 側 max_inventory_slots）超過見込みのアイテムは断る。
      // items が未同期（null）の場合は判定せず受け取る（world 側でも実行時に検証される）。
      if (payload.data.item) {
        const runtime = deps.store.getRuntime(npc.npc_id);
        const owned = runtime?.items;
        if (owned && owned.length >= DEFAULT_MAX_INVENTORY_SLOTS && !owned.some((i) => i.item_id === payload.data.item!.item_id)) {
          logger.info(`[${npc.npc_id}] rejecting transfer: inventory full (${owned.length} slots)`);
          return { command: 'transfer_reject', params: {} };
        }
      }

      const accept = await decideReceive(npc, notification.summary, payload.data.from_name);
      return { command: accept ? 'transfer_accept' : 'transfer_reject', params: {} };
    },

    // 成立した授受は既知の相手の記憶に追記する。状態（money/items）は通知の
    // perception と get_status 同期で反映される。通知に次の行動 choices が
    // 付いていれば idle 契機として委譲する。
    transfer_accepted: (ctx, runtime) => {
      const payload = transferResultPayloadSchema.safeParse(ctx.notification.payload ?? {});
      if (payload.success && payload.data.partner_name) {
        const what = describeTransfer(payload.data.item, payload.data.money);
        const note = payload.data.received ? `（${what}を受け取った）` : `（${what}を渡した）`;
        appendTransferMemory(deps, ctx.npc, payload.data.partner_name, note);
      }
      return deps.idleHandler?.(ctx, runtime) ?? null;
    },
    transfer_sent: (ctx, runtime) => deps.idleHandler?.(ctx, runtime) ?? null,
    transfer_rejected: (ctx, runtime) => deps.idleHandler?.(ctx, runtime) ?? null,
    transfer_timeout: (ctx, runtime) => deps.idleHandler?.(ctx, runtime) ?? null,
    transfer_cancelled: (ctx, runtime) => deps.idleHandler?.(ctx, runtime) ?? null,
    transfer_escrow_lost: (ctx, runtime) => deps.idleHandler?.(ctx, runtime) ?? null,
  };
}
