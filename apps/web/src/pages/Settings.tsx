import { useEffect, useState, type FormEvent } from 'react';

import { api } from '../lib/api';

interface SettingsResponse {
  llm: { provider?: string; base_url?: string; api_key?: string; model?: string; temperature?: number };
  env_defaults: { openai_base_url: string | null; openai_model: string | null; anthropic_configured: boolean };
}

interface MetaResponse {
  webhook_url: string | null;
  port: number;
}

const inputClass = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';

export default function Settings() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [envDefaults, setEnvDefaults] = useState<SettingsResponse['env_defaults'] | null>(null);
  const [form, setForm] = useState({ provider: '', base_url: '', api_key: '', model: '', temperature: '' });
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api<MetaResponse>('/api/meta').then(setMeta);
    void api<SettingsResponse>('/api/settings').then((data) => {
      setEnvDefaults(data.env_defaults);
      setForm({
        provider: data.llm.provider ?? '',
        base_url: data.llm.base_url ?? '',
        api_key: data.llm.api_key ?? '',
        model: data.llm.model ?? '',
        temperature: data.llm.temperature?.toString() ?? '',
      });
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...(form.provider ? { provider: form.provider } : {}),
          ...(form.base_url ? { base_url: form.base_url } : {}),
          ...(form.api_key ? { api_key: form.api_key } : {}),
          ...(form.model ? { model: form.model } : {}),
          ...(form.temperature !== '' ? { temperature: Number(form.temperature) } : {}),
        }),
      });
      setMessage('保存しました。');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-bold">設定</h1>

      <section className="rounded-lg bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">webhook 受信 URL</h2>
        {meta?.webhook_url ? (
          <div>
            <code className="block rounded bg-slate-100 px-3 py-2 text-sm">{meta.webhook_url}</code>
            <p className="mt-2 text-xs text-slate-500">
              karakuri-world 側の NPC 作成フォームの webhook_url にこの値を設定してください。
            </p>
          </div>
        ) : (
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-700">
            WEBHOOK_PUBLIC_BASE_URL が未設定です。world からの通知を受けるには公開 https URL が必要です
            （ローカル開発では <code>cloudflared tunnel --url http://localhost:{meta?.port ?? 8300}</code> 等）。
          </p>
        )}
      </section>

      <form onSubmit={submit} className="space-y-4 rounded-lg bg-white p-5 shadow-sm">
        <h2 className="font-semibold">LLM グローバル設定</h2>
        <p className="text-xs text-slate-500">
          全 NPC の既定値。NPC ごとに上書きできます。
          {envDefaults?.openai_base_url && ` 環境変数の既定: ${envDefaults.openai_base_url} (${envDefaults.openai_model ?? 'モデル未設定'})`}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">プロバイダ</span>
            <select className={inputClass} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              <option value="">環境変数に従う (OpenAI 互換)</option>
              <option value="openai_compatible">OpenAI 互換</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">モデル</span>
            <input className={inputClass} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="例: gpt-4o-mini / claude-sonnet-5" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">ベース URL（OpenAI 互換）</span>
            <input className={inputClass} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">API キー</span>
            <input type="password" className={inputClass} value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="****" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">temperature</span>
            <input type="number" min={0} max={2} step={0.1} className={inputClass} value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} placeholder="0.7" />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="rounded bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700">
            保存
          </button>
          <span className="text-sm text-slate-600">{message}</span>
        </div>
      </form>
    </div>
  );
}
