import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, formatTime, type NpcDto, type NpcRuntimeState } from '../lib/api';

interface SummaryEvent {
  npcs: Array<{
    npc_id: string;
    name: string;
    enabled: boolean;
    schedule_active: boolean;
    runtime: NpcRuntimeState | null;
  }>;
  at: number;
}

interface FeedResponse {
  deliveries: Array<{
    delivery_id: string;
    npc_name: string | null;
    kind: string;
    status: string;
    error: string | null;
    received_at: number;
  }>;
  commands: Array<{
    id: number;
    npc_name: string | null;
    command: string;
    accepted: number;
    error: string | null;
    executed_at: number;
  }>;
}

interface FeedEntry {
  key: string;
  at: number;
  npcName: string;
  label: string;
  ok: boolean;
  detail: string | null;
}

function buildFeed(feed: FeedResponse): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...feed.deliveries.map((d) => ({
      key: `d-${d.delivery_id}`,
      at: d.received_at,
      npcName: d.npc_name ?? '-',
      label: `📩 ${d.kind}`,
      ok: d.status !== 'failed',
      detail: d.error,
    })),
    ...feed.commands.map((c) => ({
      key: `c-${c.id}`,
      at: c.executed_at,
      npcName: c.npc_name ?? '-',
      label: `▶ ${c.command}`,
      ok: c.accepted === 1,
      detail: c.error,
    })),
  ];
  return entries.sort((a, b) => b.at - a.at).slice(0, 30);
}

function statusBadge(npc: NpcDto): { label: string; className: string } {
  if (!npc.enabled) return { label: '停止', className: 'bg-slate-200 text-slate-600' };
  if (npc.runtime?.logged_in) {
    if (npc.runtime.logout_pending_since) return { label: 'ログオフ待ち', className: 'bg-orange-100 text-orange-700' };
    return { label: '稼働中', className: 'bg-emerald-100 text-emerald-700' };
  }
  // 時間外のオフラインは正常状態（過去の last_error より優先して表示する）
  if (!npc.schedule_active) return { label: '時間外', className: 'bg-indigo-100 text-indigo-700' };
  if (npc.runtime?.last_error) return { label: 'エラー', className: 'bg-red-100 text-red-700' };
  return { label: '接続中…', className: 'bg-amber-100 text-amber-700' };
}

export default function Dashboard() {
  const [npcs, setNpcs] = useState<NpcDto[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = () => {
    api<{ npcs: NpcDto[] }>('/api/npcs')
      .then((data) => {
        setNpcs(data.npcs);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  };

  useEffect(() => {
    reload();
    // SSE でランタイム状態のライブ更新（NPC の増減や設定変更は再取得で拾う）。
    // EventSource は非 200 応答で自動再接続しないため、切断時は 10 秒後に張り直す。
    // 401（セッション切れ）は api() 経由の確認リクエストでログイン画面へ誘導する。
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      source = new EventSource('/api/events');
      source.addEventListener('summary', (event) => {
        const summary = JSON.parse((event as MessageEvent).data) as SummaryEvent;
        setNpcs((current) =>
          current.map((npc) => {
            const update = summary.npcs.find((s) => s.npc_id === npc.npc_id);
            return update
              ? { ...npc, enabled: update.enabled, schedule_active: update.schedule_active, runtime: update.runtime }
              : npc;
          }),
        );
      });
      source.onerror = () => {
        source?.close();
        void api('/api/npcs').catch(() => {}); // 401 なら onUnauthorized が発火する
        reconnectTimer = setTimeout(connect, 10_000);
      };
    };
    connect();
    // 横断イベントフィードは 5 秒ポーリング
    const loadFeed = () => void api<FeedResponse>('/api/logs').then((data) => setFeed(buildFeed(data))).catch(() => {});
    loadFeed();
    const feedTimer = setInterval(loadFeed, 5000);
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(feedTimer);
    };
  }, []);

  const toggle = async (npc: NpcDto) => {
    await api(`/api/npcs/${npc.npc_id}/${npc.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
    reload();
  };

  if (!loaded) return <div className="text-slate-500">読み込み中…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">NPC ダッシュボード</h1>
        <Link to="/npcs/new" className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
          + NPC を作成
        </Link>
      </div>

      {npcs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          NPC がまだありません。「NPC を作成」から、karakuri-world 側で発行した API キーと webhook secret を登録してください。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {npcs.map((npc) => {
            const badge = statusBadge(npc);
            return (
              <Link
                key={npc.npc_id}
                to={`/npcs/${npc.npc_id}`}
                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-lg font-semibold">{npc.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                </div>
                <dl className="space-y-1 text-sm text-slate-600">
                  <div className="flex justify-between">
                    <dt>現在地</dt>
                    <dd>
                      {npc.runtime?.world_id ?? '-'} / {npc.runtime?.node_id ?? '-'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>所持金</dt>
                    <dd>{npc.runtime?.money ?? '-'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>最終通知</dt>
                    <dd>{formatTime(npc.runtime?.last_notification_at)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>移動</dt>
                    <dd>{npc.movement.mode === 'random' ? 'ランダム' : '固定'}</dd>
                  </div>
                </dl>
                {npc.runtime?.last_error && (
                  <p className="mt-2 truncate rounded bg-red-50 px-2 py-1 text-xs text-red-600" title={npc.runtime.last_error}>
                    {npc.runtime.last_error}
                  </p>
                )}
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    void toggle(npc);
                  }}
                  className={`mt-3 w-full rounded py-1.5 text-sm font-medium ${
                    npc.enabled
                      ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      : 'bg-emerald-600 text-white hover:bg-emerald-500'
                  }`}
                >
                  {npc.enabled ? '停止する' : '稼働する'}
                </button>
              </Link>
            );
          })}
        </div>
      )}

      {feed.length > 0 && (
        <section className="mt-6 rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-2 font-semibold">直近のイベント</h2>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <tbody>
                {feed.map((entry) => (
                  <tr key={entry.key} className="border-t border-slate-100" title={entry.detail ?? ''}>
                    <td className="py-1.5 whitespace-nowrap text-slate-500">{formatTime(entry.at)}</td>
                    <td className="px-2 font-medium">{entry.npcName}</td>
                    <td>{entry.label}</td>
                    <td className={entry.ok ? 'text-emerald-600' : 'text-red-600'}>{entry.ok ? 'OK' : 'NG'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
