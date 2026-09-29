import 'dotenv/config';

function required(name: string, devDefault?: string): string {
  const v = process.env[name] ?? (process.env.NODE_ENV !== 'production' ? devDefault : undefined);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: required('DATABASE_URL', 'postgres://chat:chat@127.0.0.1:5432/chat'),
  redisUrl: required('REDIS_URL', 'redis://127.0.0.1:6379'),
  /** Secret for HMAC-hashing device ids and network prefixes. Rotating it resets ban-evasion matching. */
  signalSecret: required('SIGNAL_SECRET', 'dev-only-signal-secret-change-me'),
  /** Set when running behind a load balancer / reverse proxy so request.ip is the real client. */
  trustProxy: process.env.TRUST_PROXY === 'true',
  /** 'console' prints codes to the server log (development). Add real adapters in server/mail.ts. */
  mailAdapter: process.env.MAIL_ADAPTER ?? 'console',
  /** Resend (resend.com) API key, when MAIL_ADAPTER=resend. Kept only in the host's environment settings. */
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  /** Who emails come from; the domain must be verified with the mail provider. */
  mailFrom: process.env.MAIL_FROM ?? 'RoleplayRetro <no-reply@roleplayretro.com>',
};
