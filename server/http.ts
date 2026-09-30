import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { Trust, type Prefs } from '../shared/config.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionUser {
  id: string;
  handle: string;
  trust: number;
  email: string;
  emailVerified: boolean;
  /** Effective settings (defaults merged). */
  prefs: Prefs;
  twoFactor: boolean;
  sessionId: string;
  /** Gold Quill pass end (ISO), or null. */
  quillUntil: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, 'invalid', first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.');
  }
  return r.data;
}

export function requireUser(req: FastifyRequest, minTrust: number = Trust.New): SessionUser {
  if (!req.user) throw new HttpError(401, 'login', 'Please log in.');
  if (req.user.trust < minTrust) throw new HttpError(403, 'trust', 'Your account cannot do that yet.');
  return req.user;
}

export function clientSignals(req: FastifyRequest) {
  const header = req.headers['x-client-id'];
  return {
    ip: req.ip,
    deviceCookie: req.cookies?.did,
    clientStorageId: typeof header === 'string' ? header : undefined,
  };
}

export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
  const e = err as { statusCode?: number; message?: string; validation?: unknown };
  if (e?.statusCode && e.statusCode < 500) {
    return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message ?? 'Bad request.' });
  }
  reply.log.error(err);
  return reply.status(500).send({ error: 'server', message: 'Something went wrong. Please try again.' });
}
