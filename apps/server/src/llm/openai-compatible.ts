import { LlmError, type LlmGenerateOptions, type LlmMessage, type LlmProvider, type ResolvedLlmSettings } from './provider.js';

/**
 * OpenAI 互換 chat completions プロバイダ。
 * LiteLLM proxy / Ollama / vLLM 等にそのまま向けられるよう、
 * response_format 等のオプション機能には依存しない（JSON はプロンプト指示で得る）。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly settings: ResolvedLlmSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    // LlmService のリトライ設計（合計 < 会話ターン期限 10 分）とセットで決めている値。
    private readonly timeoutMs = 60_000,
  ) {}

  async generate(messages: LlmMessage[], options: LlmGenerateOptions = {}): Promise<string> {
    const baseUrl = (this.settings.baseUrl ?? '').replace(/\/+$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          temperature: options.temperature ?? this.settings.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 1024,
        }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new LlmError(
        timedOut ? 'LLM request timed out' : `LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // 429 / 5xx はリトライ可能、4xx（認証・バリデーション）は設定ミスなのでリトライしない。
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmError(`LLM responded with ${response.status}: ${body.slice(0, 300)}`, retryable);
    }

    const parsed = (await response.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: unknown } }> }
      | null;
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new LlmError('LLM response has no content', true);
    }
    return content;
  }
}
