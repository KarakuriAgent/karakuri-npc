import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, ApiError, type NpcDto } from '../lib/api';

const emptyForm = {
  name: '',
  world_base_url: '',
  agent_id: '',
  api_key: '',
  webhook_secret: '',
  persona: '',
  home_node_id: '',
  movement_mode: 'stationary' as 'stationary' | 'random',
  anchor_node_id: '',
  range_rows: 5,
  range_cols: 5,
  move_probability: 0.5,
  rest_duration: 1,
  conversation_accept: 'always',
  inactive_check: 'stay',
  max_history_pairs: 15,
  transfer_receive: 'always_accept',
  give_enabled: true,
  llm_provider: '',
  llm_base_url: '',
  llm_api_key: '',
  llm_model: '',
  llm_temperature: '',
};

type FormState = typeof emptyForm;

function toForm(npc: NpcDto): FormState {
  return {
    name: npc.name,
    world_base_url: npc.world_base_url,
    agent_id: npc.agent_id,
    api_key: '',
    webhook_secret: '',
    persona: npc.persona,
    home_node_id: npc.home_node_id ?? '',
    movement_mode: npc.movement.mode,
    anchor_node_id: npc.movement.anchor_node_id ?? '',
    range_rows: npc.movement.range.rows,
    range_cols: npc.movement.range.cols,
    move_probability: npc.movement.move_probability,
    rest_duration: npc.movement.rest_duration,
    conversation_accept: npc.conversation.accept,
    inactive_check: npc.conversation.inactive_check,
    max_history_pairs: npc.conversation.max_history_pairs,
    transfer_receive: npc.transfer.receive,
    give_enabled: npc.transfer.give_enabled,
    llm_provider: npc.llm.provider ?? '',
    llm_base_url: npc.llm.base_url ?? '',
    llm_api_key: npc.llm.api_key ?? '',
    llm_model: npc.llm.model ?? '',
    llm_temperature: npc.llm.temperature?.toString() ?? '',
  };
}

function toPayload(form: FormState, isNew: boolean): Record<string, unknown> {
  return {
    name: form.name,
    world_base_url: form.world_base_url,
    agent_id: form.agent_id,
    // 編集時の空欄は「変更しない」（サーバー側で無視される）
    ...(form.api_key || isNew ? { api_key: form.api_key } : {}),
    ...(form.webhook_secret || isNew ? { webhook_secret: form.webhook_secret } : {}),
    persona: form.persona,
    home_node_id: form.home_node_id || null,
    movement: {
      mode: form.movement_mode,
      ...(form.anchor_node_id ? { anchor_node_id: form.anchor_node_id } : {}),
      range: { rows: Number(form.range_rows), cols: Number(form.range_cols) },
      move_probability: Number(form.move_probability),
      rest_duration: Number(form.rest_duration),
    },
    conversation: {
      accept: form.conversation_accept,
      inactive_check: form.inactive_check,
      max_history_pairs: Number(form.max_history_pairs),
    },
    transfer: {
      receive: form.transfer_receive,
      give_enabled: form.give_enabled,
    },
    llm: {
      ...(form.llm_provider ? { provider: form.llm_provider } : {}),
      ...(form.llm_base_url ? { base_url: form.llm_base_url } : {}),
      ...(form.llm_api_key ? { api_key: form.llm_api_key } : {}),
      ...(form.llm_model ? { model: form.llm_model } : {}),
      ...(form.llm_temperature !== '' ? { temperature: Number(form.llm_temperature) } : {}),
    },
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const inputClass = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';

export default function NpcForm() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    api<NpcDto>(`/api/npcs/${id}`).then((npc) => setForm(toForm(npc)));
  }, [id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (isNew) {
        const created = await api<NpcDto>('/api/npcs', { method: 'POST', body: JSON.stringify(toPayload(form, true)) });
        navigate(`/npcs/${created.npc_id}`);
      } else {
        await api(`/api/npcs/${id}`, { method: 'PATCH', body: JSON.stringify(toPayload(form, false)) });
        navigate(`/npcs/${id}`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTestResult('テスト中…');
    try {
      if (isNew) {
        setTestResult('接続テストは保存後に実行できます。');
        return;
      }
      const result = await api<{ ok: boolean; detail: string }>(`/api/npcs/${id}/test-connection`, { method: 'POST' });
      setTestResult(result.ok ? `✅ ${result.detail}` : `❌ ${result.detail}`);
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const remove = async () => {
    if (!id) return;
    if (!confirm('この NPC を削除しますか？（会話履歴・記憶も削除されます）')) return;
    await api(`/api/npcs/${id}`, { method: 'DELETE' });
    navigate('/');
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-bold">{isNew ? 'NPC を作成' : `${form.name} を編集`}</h1>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm">
        <h2 className="font-semibold">world 接続</h2>
        <p className="text-xs text-slate-500">
          karakuri-world 側（管理者のマイページ / Discord コマンド）で NPC エージェントを作成し、発行された値を貼り付けてください。
        </p>
        <Field label="NPC 名" hint="world 側の agent_name と揃えることを推奨">
          <input required className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="world ベース URL">
          <input
            required
            type="url"
            placeholder="https://world.example.com"
            className={inputClass}
            value={form.world_base_url}
            onChange={(e) => set('world_base_url', e.target.value)}
          />
        </Field>
        <Field label="agent_id" hint="world 側で発行された npc-xxxx 形式の ID">
          <input required className={inputClass} value={form.agent_id} onChange={(e) => set('agent_id', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="API キー" hint={isNew ? '' : '空欄なら変更しない'}>
            <input
              required={isNew}
              type="password"
              className={inputClass}
              value={form.api_key}
              onChange={(e) => set('api_key', e.target.value)}
            />
          </Field>
          <Field label="webhook secret" hint={isNew ? '' : '空欄なら変更しない'}>
            <input
              required={isNew}
              type="password"
              className={inputClass}
              value={form.webhook_secret}
              onChange={(e) => set('webhook_secret', e.target.value)}
            />
          </Field>
        </div>
        {!isNew && (
          <div className="flex items-center gap-3">
            <button type="button" onClick={testConnection} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
              接続テスト
            </button>
            <span className="text-sm text-slate-600">{testResult}</span>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm">
        <h2 className="font-semibold">役割（ペルソナ）</h2>
        <Field label="人格・役割設定" hint="会話時の system prompt に使われます。口調・職業・性格・背景などを自由に">
          <textarea
            rows={6}
            className={inputClass}
            value={form.persona}
            onChange={(e) => set('persona', e.target.value)}
            placeholder="例: あなたは駅前のパン屋「こむぎ堂」の店主。明るく人懐っこい性格で、パンの話になると止まらない。"
          />
        </Field>
      </section>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm">
        <h2 className="font-semibold">移動</h2>
        <div className="grid grid-cols-2 gap-4">
          <Field label="開始位置 (home_node_id)" hint="例: 50-50。ログイン時にこの位置から開始">
            <input
              className={inputClass}
              pattern="\d+-\d+"
              value={form.home_node_id}
              onChange={(e) => set('home_node_id', e.target.value)}
              placeholder="50-50"
            />
          </Field>
          <Field label="移動モード">
            <select className={inputClass} value={form.movement_mode} onChange={(e) => set('movement_mode', e.target.value as FormState['movement_mode'])}>
              <option value="stationary">動かない（固定）</option>
              <option value="random">範囲内をランダム移動</option>
            </select>
          </Field>
        </div>
        {form.movement_mode === 'random' && (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Field label="移動範囲の中心" hint="空欄なら開始位置(home)基準">
                <input className={inputClass} pattern="\d+-\d+" value={form.anchor_node_id} onChange={(e) => set('anchor_node_id', e.target.value)} placeholder="home と同じ" />
              </Field>
              <Field label="範囲 縦(±行)">
                <input type="number" min={0} max={200} className={inputClass} value={form.range_rows} onChange={(e) => set('range_rows', Number(e.target.value))} />
              </Field>
              <Field label="範囲 横(±列)">
                <input type="number" min={0} max={200} className={inputClass} value={form.range_cols} onChange={(e) => set('range_cols', Number(e.target.value))} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="移動確率" hint="行動機会（約10分毎）ごとに移動する確率 0〜1">
                <input type="number" min={0} max={1} step={0.05} className={inputClass} value={form.move_probability} onChange={(e) => set('move_probability', Number(e.target.value))} />
              </Field>
              <Field label="休憩時間" hint="移動しないときの待機。1=10分〜36=6時間">
                <input type="number" min={1} max={36} className={inputClass} value={form.rest_duration} onChange={(e) => set('rest_duration', Number(e.target.value))} />
              </Field>
            </div>
          </>
        )}
      </section>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm">
        <h2 className="font-semibold">会話・アイテム</h2>
        <div className="grid grid-cols-3 gap-4">
          <Field label="話しかけられたら">
            <select className={inputClass} value={form.conversation_accept} onChange={(e) => set('conversation_accept', e.target.value)}>
              <option value="always">常に受ける</option>
              <option value="llm">LLM が判断</option>
              <option value="never">受けない</option>
            </select>
          </Field>
          <Field label="会話の継続確認">
            <select className={inputClass} value={form.inactive_check} onChange={(e) => set('inactive_check', e.target.value)}>
              <option value="stay">残る</option>
              <option value="leave">抜ける</option>
            </select>
          </Field>
          <Field label="記憶する往復数" hint="LLM に渡す会話履歴">
            <input type="number" min={1} max={50} className={inputClass} value={form.max_history_pairs} onChange={(e) => set('max_history_pairs', Number(e.target.value))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="アイテムを差し出されたら">
            <select className={inputClass} value={form.transfer_receive} onChange={(e) => set('transfer_receive', e.target.value)}>
              <option value="always_accept">常に受け取る</option>
              <option value="llm">LLM が判断</option>
              <option value="always_reject">受け取らない</option>
            </select>
          </Field>
          <Field label="アイテムを渡す">
            <select className={inputClass} value={String(form.give_enabled)} onChange={(e) => set('give_enabled', e.target.value === 'true')}>
              <option value="true">会話の流れで渡せる（LLM 判断）</option>
              <option value="false">渡さない</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm">
        <h2 className="font-semibold">LLM（グローバル設定の上書き）</h2>
        <div className="grid grid-cols-3 gap-4">
          <Field label="プロバイダ">
            <select className={inputClass} value={form.llm_provider} onChange={(e) => set('llm_provider', e.target.value)}>
              <option value="">グローバル設定に従う</option>
              <option value="openai_compatible">OpenAI 互換</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </Field>
          <Field label="モデル">
            <input className={inputClass} value={form.llm_model} onChange={(e) => set('llm_model', e.target.value)} placeholder="グローバル設定に従う" />
          </Field>
          <Field label="temperature">
            <input type="number" min={0} max={2} step={0.1} className={inputClass} value={form.llm_temperature} onChange={(e) => set('llm_temperature', e.target.value)} placeholder="0.7" />
          </Field>
          <Field label="ベース URL（OpenAI 互換のみ）">
            <input className={inputClass} value={form.llm_base_url} onChange={(e) => set('llm_base_url', e.target.value)} placeholder="グローバル設定に従う" />
          </Field>
          <Field label="API キー">
            <input type="password" className={inputClass} value={form.llm_api_key} onChange={(e) => set('llm_api_key', e.target.value)} placeholder="グローバル設定に従う" />
          </Field>
        </div>
      </section>

      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-between">
        <button type="submit" disabled={saving} className="rounded bg-slate-900 px-6 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          {saving ? '保存中…' : isNew ? '作成する' : '保存する'}
        </button>
        {!isNew && (
          <button type="button" onClick={remove} className="rounded px-4 py-2 text-sm text-red-600 hover:bg-red-50">
            NPC を削除
          </button>
        )}
      </div>
    </form>
  );
}
