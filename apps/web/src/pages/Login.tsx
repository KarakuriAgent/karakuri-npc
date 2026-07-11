import { useState, type FormEvent } from 'react';

import { api } from '../lib/api';

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      onLoggedIn();
    } catch {
      setError('パスワードが違います。');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 rounded-lg bg-white p-6 shadow">
        <h1 className="mb-4 text-lg font-bold">🎎 Karakuri NPC</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="パスワード"
          className="mb-3 w-full rounded border border-slate-300 px-3 py-2"
          autoFocus
        />
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <button type="submit" className="w-full rounded bg-slate-900 py-2 font-medium text-white hover:bg-slate-700">
          ログイン
        </button>
      </form>
    </div>
  );
}
