import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  api,
  formatTime,
  type ConversationDto,
  type MemoryDto,
  type MessageDto,
  type NpcDto,
} from '../lib/api';

type Tab = 'conversations' | 'memories' | 'logs';

export default function NpcDetail() {
  const { id } = useParams();
  const [npc, setNpc] = useState<NpcDto | null>(null);
  const [tab, setTab] = useState<Tab>('conversations');
  const [actionMessage, setActionMessage] = useState('');

  const reload = useCallback(() => {
    if (id) void api<NpcDto>(`/api/npcs/${id}`).then(setNpc);
  }, [id]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!npc) return <div className="text-slate-500">読み込み中…</div>;

  const act = async (path: string) => {
    setActionMessage('実行中…');
    try {
      await api(`/api/npcs/${npc.npc_id}/${path}`, { method: 'POST' });
      setActionMessage('完了しました。');
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : String(e));
    }
    reload();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">{npc.name}</h1>
          <p className="text-sm text-slate-500">{npc.agent_id}</p>
        </div>
        <Link to={`/npcs/${npc.npc_id}/edit`} className="rounded border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50">
          編集
        </Link>
      </div>

      <section className="grid grid-cols-2 gap-4 rounded-lg bg-white p-5 shadow-sm md:grid-cols-4">
        <div>
          <p className="text-xs text-slate-500">状態</p>
          <p className="font-medium">
            {npc.enabled ? (npc.runtime?.logged_in ? '🟢 稼働中' : '🟡 接続中') : '⚪ 停止'}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">現在地</p>
          <p className="font-medium">
            {npc.runtime?.world_id ?? '-'} / {npc.runtime?.node_id ?? '-'}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">所持金</p>
          <p className="font-medium">{npc.runtime?.money ?? '-'}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">所持品</p>
          <p className="truncate font-medium" title={(npc.runtime?.items ?? []).map((i) => i.name ?? i.item_id).join(', ')}>
            {npc.runtime?.items?.length ? npc.runtime.items.map((i) => i.name ?? i.item_id).join(', ') : '-'}
          </p>
        </div>
        <div className="col-span-2 flex gap-2 md:col-span-4">
          <button onClick={() => act(npc.enabled ? 'disable' : 'enable')} className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-700">
            {npc.enabled ? '停止する' : '稼働する'}
          </button>
          <button
            onClick={() => act('return-home')}
            disabled={!npc.home_node_id}
            className="rounded border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
            title={npc.home_node_id ? `${npc.home_node_id} へ戻す` : 'home_node_id 未設定'}
          >
            ホームへ戻す
          </button>
          <span className="self-center text-sm text-slate-500">{actionMessage}</span>
        </div>
        {npc.runtime?.last_error && (
          <p className="col-span-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-4">{npc.runtime.last_error}</p>
        )}
      </section>

      <nav className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['conversations', '会話履歴'],
            ['memories', '記憶'],
            ['logs', '通知・コマンドログ'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium ${tab === key ? 'border-b-2 border-slate-900 text-slate-900' : 'text-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'conversations' && <ConversationsTab npcId={npc.npc_id} npcAgentId={npc.agent_id} />}
      {tab === 'memories' && <MemoriesTab npcId={npc.npc_id} />}
      {tab === 'logs' && <LogsTab npcId={npc.npc_id} />}
    </div>
  );
}

function ConversationsTab({ npcId, npcAgentId }: { npcId: string; npcAgentId: string }) {
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);

  useEffect(() => {
    void api<{ conversations: ConversationDto[] }>(`/api/npcs/${npcId}/conversations`).then((d) => setConversations(d.conversations));
  }, [npcId]);

  useEffect(() => {
    if (!selected) return;
    void api<{ messages: MessageDto[] }>(`/api/npcs/${npcId}/conversations/${selected}/messages`).then((d) => setMessages(d.messages));
  }, [npcId, selected]);

  if (conversations.length === 0) return <p className="text-sm text-slate-500">まだ会話がありません。</p>;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="space-y-2">
        {conversations.map((conv) => (
          <button
            key={conv.conversation_id}
            onClick={() => setSelected(conv.conversation_id)}
            className={`w-full rounded-lg border p-3 text-left text-sm ${
              selected === conv.conversation_id ? 'border-slate-900 bg-white' : 'border-slate-200 bg-white hover:border-slate-400'
            }`}
          >
            <p className="font-medium">
              {conv.participants.filter((p) => p.id !== npcAgentId).map((p) => p.name).join(', ') || '(相手不明)'}
            </p>
            <p className="text-xs text-slate-500">
              {formatTime(conv.started_at)} • {conv.status === 'active' ? '進行中' : `終了(${conv.end_reason ?? '-'})`}
            </p>
          </button>
        ))}
      </div>
      <div className="md:col-span-2">
        {selected ? (
          <div className="space-y-2 rounded-lg bg-white p-4 shadow-sm">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.is_self ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${message.is_self ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}>
                  <p className="mb-0.5 text-xs opacity-70">{message.speaker_name ?? '-'}</p>
                  <p className="whitespace-pre-wrap">{message.message}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">会話を選択してください。</p>
        )}
      </div>
    </div>
  );
}

function MemoriesTab({ npcId }: { npcId: string }) {
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(() => {
    void api<{ memories: MemoryDto[] }>(`/api/npcs/${npcId}/memories`).then((d) => setMemories(d.memories));
  }, [npcId]);

  useEffect(reload, [reload]);

  const save = async (agentId: string) => {
    await api(`/api/npcs/${npcId}/memories/${agentId}`, { method: 'PUT', body: JSON.stringify({ summary: draft }) });
    setEditing(null);
    reload();
  };

  const remove = async (agentId: string) => {
    if (!confirm('この記憶を削除しますか？')) return;
    await api(`/api/npcs/${npcId}/memories/${agentId}`, { method: 'DELETE' });
    reload();
  };

  if (memories.length === 0) return <p className="text-sm text-slate-500">まだ記憶がありません。会話が終わると自動で記録されます。</p>;

  return (
    <div className="space-y-3">
      {memories.map((memory) => (
        <div key={memory.counterpart_agent_id} className="rounded-lg bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">
              {memory.counterpart_name ?? memory.counterpart_agent_id}
              <span className="ml-2 text-xs text-slate-500">会話 {memory.conversation_count} 回 • 最終 {formatTime(memory.last_talked_at)}</span>
            </p>
            <div className="flex gap-2 text-sm">
              <button
                onClick={() => {
                  setEditing(memory.counterpart_agent_id);
                  setDraft(memory.summary);
                }}
                className="text-slate-600 hover:underline"
              >
                編集
              </button>
              <button onClick={() => remove(memory.counterpart_agent_id)} className="text-red-600 hover:underline">
                削除
              </button>
            </div>
          </div>
          {editing === memory.counterpart_agent_id ? (
            <div>
              <textarea rows={4} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="mt-2 flex gap-2">
                <button onClick={() => save(memory.counterpart_agent_id)} className="rounded bg-slate-900 px-3 py-1 text-sm text-white">
                  保存
                </button>
                <button onClick={() => setEditing(null)} className="rounded border border-slate-300 px-3 py-1 text-sm">
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-slate-700">{memory.summary}</p>
          )}
        </div>
      ))}
    </div>
  );
}

interface LogsResponse {
  deliveries: Array<{
    delivery_id: string;
    notification_id: string;
    kind: string;
    received_at: number;
    status: string;
    error: string | null;
  }>;
  commands: Array<{
    id: number;
    notification_id: string | null;
    command: string;
    params_json: string;
    accepted: number;
    error: string | null;
    executed_at: number;
  }>;
}

function LogsTab({ npcId }: { npcId: string }) {
  const [logs, setLogs] = useState<LogsResponse | null>(null);

  useEffect(() => {
    void api<LogsResponse>(`/api/npcs/${npcId}/logs`).then(setLogs);
    const timer = setInterval(() => void api<LogsResponse>(`/api/npcs/${npcId}/logs`).then(setLogs), 5000);
    return () => clearInterval(timer);
  }, [npcId]);

  if (!logs) return <p className="text-sm text-slate-500">読み込み中…</p>;

  const statusColor = (status: string) =>
    status === 'done' ? 'text-emerald-600' : status === 'failed' ? 'text-red-600' : 'text-slate-500';

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h3 className="mb-2 font-semibold">受信した通知</h3>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">時刻</th>
                <th>kind</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {logs.deliveries.map((delivery) => (
                <tr key={delivery.delivery_id} className="border-t border-slate-100" title={delivery.error ?? ''}>
                  <td className="py-1.5 whitespace-nowrap">{formatTime(delivery.received_at)}</td>
                  <td>{delivery.kind}</td>
                  <td className={statusColor(delivery.status)}>{delivery.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h3 className="mb-2 font-semibold">実行したコマンド</h3>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">時刻</th>
                <th>コマンド</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>
              {logs.commands.map((command) => (
                <tr key={command.id} className="border-t border-slate-100" title={command.error ?? command.params_json}>
                  <td className="py-1.5 whitespace-nowrap">{formatTime(command.executed_at)}</td>
                  <td>{command.command}</td>
                  <td className={command.accepted ? 'text-emerald-600' : 'text-red-600'}>{command.accepted ? 'OK' : 'NG'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
