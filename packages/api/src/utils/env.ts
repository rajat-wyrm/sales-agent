import { z } from 'zod';
import { config } from 'dotenv';

config();

// Values shipped in .env.example. If one of these survives into a production
// deployment, tokens can be forged by anyone who reads the public repository -- the
// schema's min(1) would happily accept them, so they have to be refused by name.
const PLACEHOLDER_SECRETS = new Set([
  'change-this-to-a-long-random-string',
  'change-me',
  'changeme',
  'secret',
  'your-secret-here',
  'replace-me',
  'dev-secret',
]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  HOST: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((v) => !PLACEHOLDER_SECRETS.has(v.trim().toLowerCase()), {
      message:
        'JWT_SECRET is still the .env.example placeholder; anyone with the public repo could forge admin tokens',
    }),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().optional(),
  ENCRYPTION_SECRET: z
    .string()
    .min(32)
    .refine((v) => !PLACEHOLDER_SECRETS.has(v.trim().toLowerCase()), {
      message: 'ENCRYPTION_SECRET is still the .env.example placeholder',
    }),
  GEMINI_API_KEY: z.string().optional(),
  SNOVIO_API_KEY: z.string().optional(),
  SNOVIO_API_SECRET: z.string().optional(),
  CONTACT_OUT_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_WEB_URL: z.string().optional(),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  SCRAPER_MAX_CONCURRENCY: z.string().transform(Number).default('5'),
  SCRAPER_TIMEOUT_SECONDS: z.string().transform(Number).default('30'),
  SCRAPER_RETRY_ATTEMPTS: z.string().transform(Number).default('3'),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.string().transform(Number).default('5'),
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: z.string().transform(Number).default('120'),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
    }
    _env = result.data;
  }
  return _env;
}

export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
