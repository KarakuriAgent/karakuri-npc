import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';

import { api, setOnUnauthorized } from './lib/api';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import NpcDetail from './pages/NpcDetail';
import NpcForm from './pages/NpcForm';
import Settings from './pages/Settings';

interface AuthStatus {
  auth_required: boolean;
  authenticated: boolean;
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const location = useLocation();

  useEffect(() => {
    setOnUnauthorized(() => setAuth({ auth_required: true, authenticated: false }));
    api<AuthStatus>('/api/auth/status')
      .then(setAuth)
      .catch(() => setAuth({ auth_required: false, authenticated: true }));
  }, []);

  if (!auth) {
    return <div className="p-10 text-center text-slate-500">読み込み中…</div>;
  }
  if (auth.auth_required && !auth.authenticated) {
    return <Login onLoggedIn={() => setAuth({ auth_required: true, authenticated: true })} />;
  }

  const navLink = (to: string, label: string) => (
    <Link
      to={to}
      className={`rounded px-3 py-1.5 text-sm font-medium ${
        location.pathname === to ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-200'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/" className="text-lg font-bold">
            🎎 Karakuri NPC
          </Link>
          <nav className="flex gap-1">
            {navLink('/', 'ダッシュボード')}
            {navLink('/npcs/new', 'NPC作成')}
            {navLink('/settings', '設定')}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/npcs/new" element={<NpcForm />} />
          <Route path="/npcs/:id" element={<NpcDetail />} />
          <Route path="/npcs/:id/edit" element={<NpcForm />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
