import { env } from './env.js';

/**
 * Outbound email/SMS behind one small interface, so a provider can be swapped
 * without touching the auth code. Only the console adapter ships; add yours here.
 */
export interface Messenger {
  sendEmailCode(to: string, code: string): Promise<void>;
  sendSmsCode(to: string, code: string): Promise<void>;
}

const consoleMessenger: Messenger = {
  async sendEmailCode(to, code) {
    console.log(`[mail] verification code for ${to}: ${code}`);
  },
  async sendSmsCode(to, code) {
    console.log(`[sms] verification code for ${to}: ${code}`);
  },
};

export function messenger(): Messenger {
  switch (env.mailAdapter) {
    case 'console':
      return consoleMessenger;
    default:
      throw new Error(`Unknown MAIL_ADAPTER "${env.mailAdapter}". Add an adapter in server/mail.ts.`);
  }
}
