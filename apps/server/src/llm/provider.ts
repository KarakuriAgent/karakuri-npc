import { z } from 'zod';

import type { AppConfig } from '../config.js';
import type { NpcStore } from '../storage/npc-store.js';
import type { Npc } from '../types/npc.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmGenerateOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LlmProvider {
  generate(messages: LlmMessage[], options?: LlmGenerateOptions): Promise<string>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** settings テーブル（key: llm_global）に保存するグローバル LLM 設定。 */
export const globalLlmSettingsSchema = z.object({
  provider: z.enum(['openai_compatible', 'anthropic']).optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type GlobalLlmSettings = z.infer<typeof globalLlmSettingsSchema>;

export const LLM_GLOBAL_SETTING_KEY = 'llm_global';

export interface ResolvedLlmSettings {
  provider: 'openai_compatible' | 'anthropic';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
}

export function loadGlobalLlmSettings(store: NpcStore): GlobalLlmSettings {
  const raw = store.getSetting(LLM_GLOBAL_SETTING_KEY);
  if (!raw) return {};
  try {
    return globalLlmSettingsSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * LLM 設定の解決順: NPC ごとの上書き → settings テーブル → 環境変数。
 * モデル・認証情報が揃わなければ null（呼び出し側は定型文フォールバック）。
 */
export function resolveLlmSettings(config: AppConfig, store: NpcStore, npc: Npc): ResolvedLlmSettings | null {
  const global = loadGlobalLlmSettings(store);
  const provider = npc.llm.provider ?? global.provider ?? 'openai_compatible';
  const temperature = npc.llm.temperature ?? global.temperature;

  if (provider === 'anthropic') {
    const apiKey = npc.llm.api_key ?? global.api_key ?? config.ANTHROPIC_API_KEY;
    const model = npc.llm.model ?? global.model;
    if (!apiKey || !model) return null;
    return {
      provider,
      model,
      apiKey,
      ...(temperature !== undefined ? { temperature } : {}),
    };
  }

  const baseUrl = npc.llm.base_url ?? global.base_url ?? config.OPENAI_BASE_URL;
  const apiKey = npc.llm.api_key ?? global.api_key ?? config.OPENAI_API_KEY;
  const model = npc.llm.model ?? global.model ?? config.OPENAI_MODEL;
  if (!baseUrl || !model) return null;
  return {
    provider,
    model,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

/** グローバルの LLM 同時実行制限。NPC 内は直列だが複数 NPC の同時会話を絞る。 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // 起床とゲート再チェックの間に別の呼び出しが枠を取ることがあるため while で再確認する。
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
