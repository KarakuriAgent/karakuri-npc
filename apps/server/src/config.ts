import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8300),
  DATA_DIR: z.string().min(1).default('./data'),
  WEBHOOK_PUBLIC_BASE_URL: z.string().url().optional(),
  WEB_PASSWORD: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
});

export type AppConfig = z.infer<typeof configSchema>;

/** 空文字の env は未設定として扱う（.env の空値対策）。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  return configSchema.parse(cleaned);
}
