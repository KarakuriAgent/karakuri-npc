import { LlmError, type LlmGenerateOptions, type LlmMessage, type LlmProvider, type ResolvedLlmSettings } from './provider.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic Messages API プロバイダ。 */
export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly settings: ResolvedLlmSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    // LlmService のリトライ設計（合計 < 会話ターン期限 10 分）とセットで決めている値。
    private readonly timeoutMs = 60_000,
  ) {}

  async generate(messages: LlmMessage[], options: LlmGenerateOptions = {}): Promise<string> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    // Messages API は user/assistant の交互を要求するため、同一 role の連続をマージする。
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      const last = turns.at(-1);
      if (last && last.role === message.role) {
        last.content += `\n${message.content}`;
      } else {
        turns.push({ role: message.role, content: message.content });
      }
    }
    if (turns.length === 0 || turns[0]!.role !== 'user') {
      turns.unshift({ role: 'user', content: '(会話を始めてください)' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.settings.apiKey ?? '',
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.settings.model,
          max_tokens: options.maxTokens ?? 1024,
          temperature: options.temperature ?? this.settings.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages: turns,
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
      const retryable = response.status === 429 || response.status >= 500 || response.status === 529;
      throw new LlmError(`LLM responded with ${response.status}: ${body.slice(0, 300)}`, retryable);
    }

    const parsed = (await response.json().catch(() => null)) as
      | { content?: Array<{ type?: string; text?: unknown }> }
      | null;
    const text = parsed?.content?.find((block) => block.type === 'text')?.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new LlmError('LLM response has no content', true);
    }
    return text;
  }
}
