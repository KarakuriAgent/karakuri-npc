import type { NpcStore } from '../../storage/npc-store.js';
import type { NotificationHandlers } from '../npc-runtime.js';

/**
 * ライフサイクル系通知のハンドラ。
 * agent_logged_out は通常 webhook では届かない（world は保存しない通知を配送できない）が、
 * 将来仕様変更で届いた場合に備えて状態ミラーを落とす。enabled な NPC は
 * ヘルスループが再ログインさせる。
 */
export function createLifecycleHandlers(store: NpcStore): NotificationHandlers {
  return {
    agent_logged_out: ({ npc }) => {
      store.patchRuntime(npc.npc_id, { logged_in: false, agent_state: null, logout_pending_since: null });
      return null;
    },
  };
}
