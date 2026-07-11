import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

const COOKIE_NAME = 'karakuri_npc_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function issueSessionCookie(c: Context, password: string): void {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const token = `${expiresAt}.${sign(String(expiresAt), password)}`;
  // https 経由（またはリバースプロキシ配下）では Secure を付け、平文経路への cookie 送出を防ぐ。
  const forwardedProto = c.req.header('x-forwarded-proto');
  const secure = forwardedProto === 'https' || new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    ...(secure ? { secure: true } : {}),
  });
}

export function verifySession(c: Context, password: string): boolean {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  return safeEqual(signature, sign(expiresAt, password));
}

export function verifyPassword(input: string, password: string): boolean {
  return safeEqual(input, password);
}

/**
 * WebUI API の認証。WEB_PASSWORD 未設定なら認証なし（localhost 運用前提）。
 * webhook（world からの通知）には適用しないこと。
 */
export function webAuth(password: string | undefined): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!password) return next();
    if (!verifySession(c, password)) {
      return c.json({ error: 'unauthorized', message: 'ログインが必要です。' }, 401);
    }
    return next();
  };
}
