import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../../src/config.js';
import { LlmService, extractJsonText } from '../../src/llm/llm-service.js';
import { LLM_GLOBAL_SETTING_KEY, LlmError, resolveLlmSettings, type LlmProvider } from '../../src/llm/provider.js';
import { createTestStore, testNpcInput } from '../helpers/test-env.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeConfig(env: Record<string, string> = {}) {
  return loadConfig({ DATA_DIR: './data', ...env } as NodeJS.ProcessEnv);
}

describe('extractJsonText', () => {
  it('コードフェンスと前後の説明文を取り除く', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('はい、こちらです。\n{"a": 1} 以上です。')).toBe('{"a": 1}');
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });
});

describe('resolveLlmSettings', () => {
  it('env → settings → NPC 上書きの優先順で解決する', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    const config = makeConfig({ OPENAI_BASE_URL: 'https://llm.env', OPENAI_MODEL: 'env-model' });

    expect(resolveLlmSettings(config, store, npc)).toMatchObject({
      provider: 'openai_compatible',
      baseUrl: 'https://llm.env',
      model: 'env-model',
    });

    store.setSetting(LLM_GLOBAL_SETTING_KEY, JSON.stringify({ base_url: 'https://llm.global', model: 'global-model' }));
    expect(resolveLlmSettings(config, store, npc)).toMatchObject({
      baseUrl: 'https://llm.global',
      model: 'global-model',
    });

    const npc2 = store.updateNpc(npc.npc_id, { llm: { model: 'npc-model', temperature: 0.2 } })!;
    expect(resolveLlmSettings(config, store, npc2)).toMatchObject({ model: 'npc-model', temperature: 0.2 });
  });

  it('設定が揃わなければ null', () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    expect(resolveLlmSettings(makeConfig(), store, npc)).toBeNull();
  });
});

function makeService(responses: Array<string | Error>, env: Record<string, string> = {}) {
  const calls: Array<{ messages: unknown }> = [];
  let index = 0;
  const provider: LlmProvider = {
    async generate(messages) {
      calls.push({ messages });
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const store = createTestStore();
  const npc = store.createNpc(testNpcInput());
  const service = new LlmService({
    config: makeConfig({ OPENAI_BASE_URL: 'https://llm.test', OPENAI_MODEL: 'm', ...env }),
    store,
    createProvider: () => provider,
    logger: silentLogger,
    sleepImpl: async () => {},
  });
  return { service, npc, calls };
}

describe('LlmService', () => {
  it('retryable な失敗を最大 2 回まで試す（会話ターン期限内に収める設計値）', async () => {
    const { service, npc } = makeService([new LlmError('temporary', true), 'ok']);
    expect(await service.generate(npc, [{ role: 'user', content: 'hi' }])).toBe('ok');

    const exhausted = makeService([
      new LlmError('temporary', true),
      new LlmError('temporary', true),
      'ok',
    ]);
    await expect(exhausted.service.generate(exhausted.npc, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'temporary',
    );
    expect(exhausted.calls).toHaveLength(2);
  });

  it('non-retryable な失敗は即座に投げる', async () => {
    const { service, npc, calls } = makeService([new LlmError('bad request', false), 'ok']);
    await expect(service.generate(npc, [{ role: 'user', content: 'hi' }])).rejects.toThrow('bad request');
    expect(calls).toHaveLength(1);
  });

  it('generateJson は不正な JSON を 1 回だけ修復リトライする', async () => {
    const { service, npc, calls } = makeService(['これはJSONではない', '{"answer": "ok"}']);
    const result = await service.generateJson(
      npc,
      [{ role: 'user', content: 'q' }],
      z.object({ answer: z.string() }),
      '{"answer": string}',
    );
    expect(result).toEqual({ answer: 'ok' });
    expect(calls).toHaveLength(2);
  });

  it('LLM 未設定なら llm_not_configured を投げる', async () => {
    const store = createTestStore();
    const npc = store.createNpc(testNpcInput());
    const service = new LlmService({ config: makeConfig(), store, logger: silentLogger });
    await expect(service.generate(npc, [{ role: 'user', content: 'hi' }])).rejects.toThrow('llm_not_configured');
  });
});
