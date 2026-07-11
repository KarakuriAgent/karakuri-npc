import type { ZodType } from 'zod';

import type { AppConfig } from '../config.js';
import type { NpcStore } from '../storage/npc-store.js';
import type { Npc } from '../types/npc.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import {
  LlmError,
  Semaphore,
  resolveLlmSettings,
  type LlmGenerateOptions,
  type LlmMessage,
  type LlmProvider,
  type ResolvedLlmSettings,
} from './provider.js';

// world の会話ターン期限は 10 分。generateJson は generate を最大 2 回（初回 + 修復）呼ぶため、
// 最悪合計 (60s × 2 + 2s) × 2 ≒ 4.1 分 に収まるよう試行回数とタイムアウトを絞っている
// （プロバイダ側タイムアウトは各 60 秒）。安易に増やすとターンを取りこぼす。
const MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** LLM 応答からコードフェンス等を除去して JSON 部分を取り出す。 */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

export interface LlmServiceDeps {
  config: AppConfig;
  store: NpcStore;
  createProvider?: (settings: ResolvedLlmSettings) => LlmProvider;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * NPC ごとの LLM 設定解決・同時実行制限・リトライ・JSON 構造化出力をまとめた入口。
 * 設定が未構成（プロバイダ解決不可）の場合、generate 系は LlmError('llm_not_configured') を投げる。
 */
export class LlmService {
  private readonly config: AppConfig;
  private readonly store: NpcStore;
  private readonly semaphore: Semaphore;
  private readonly createProvider: (settings: ResolvedLlmSettings) => LlmProvider;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(deps: LlmServiceDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.semaphore = new Semaphore(deps.config.LLM_MAX_CONCURRENCY);
    this.createProvider = deps.createProvider
      ?? ((settings) =>
        settings.provider === 'anthropic' ? new AnthropicProvider(settings) : new OpenAiCompatibleProvider(settings));
    this.logger = deps.logger ?? console;
    this.sleepImpl = deps.sleepImpl ?? sleep;
  }

  isConfigured(npc: Npc): boolean {
    return resolveLlmSettings(this.config, this.store, npc) !== null;
  }

  /** テキスト生成。retryable な失敗は指数バックオフで最大 3 回試す。 */
  async generate(npc: Npc, messages: LlmMessage[], options: LlmGenerateOptions = {}): Promise<string> {
    const settings = resolveLlmSettings(this.config, this.store, npc);
    if (!settings) {
      throw new LlmError('llm_not_configured', false);
    }
    const provider = this.createProvider(settings);
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.semaphore.run(() => provider.generate(messages, options));
      } catch (error) {
        lastError = error;
        const retryable = error instanceof LlmError ? error.retryable : true;
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        this.logger.warn(`[llm] attempt ${attempt} failed, retrying in ${delay}ms: ${String(error)}`);
        await this.sleepImpl(delay);
      }
    }
    throw lastError;
  }

  /**
   * JSON 構造化出力。スキーマ説明をプロンプトに付与し、パース/検証失敗時は
   * 1 回だけ修復を依頼する。
   */
  async generateJson<T>(
    npc: Npc,
    messages: LlmMessage[],
    schema: ZodType<T>,
    formatInstruction: string,
    options: LlmGenerateOptions = {},
  ): Promise<T> {
    const augmented: LlmMessage[] = [
      ...messages,
      {
        role: 'system',
        content: `出力形式: 以下の JSON だけを返すこと。説明文・コードフェンスは不要。\n${formatInstruction}`,
      },
    ];
    const first = await this.generate(npc, augmented, options);
    const firstParsed = this.tryParse(first, schema);
    if (firstParsed.ok) return firstParsed.value;

    const repair: LlmMessage[] = [
      ...augmented,
      { role: 'assistant', content: first },
      {
        role: 'system',
        content: `出力が不正です（${firstParsed.error}）。指定の JSON だけをもう一度返してください。`,
      },
    ];
    const second = await this.generate(npc, repair, options);
    const secondParsed = this.tryParse(second, schema);
    if (secondParsed.ok) return secondParsed.value;
    throw new LlmError(`LLM JSON output invalid: ${secondParsed.error}`, false);
  }

  private tryParse<T>(raw: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
    try {
      const value = schema.parse(JSON.parse(extractJsonText(raw)));
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
    }
  }
}
