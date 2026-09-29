import { AGE, DEFAULT_PREFS, type Prefs } from '../shared/config.js';

/** Whole years between a YYYY-MM-DD birthdate and `now` (UTC). */
export function ageOn(birthdate: string | Date, now = new Date()): number {
  const b = typeof birthdate === 'string' ? new Date(`${birthdate}T00:00:00Z`) : birthdate;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

/**
 * The site is 18+ only. An account under 18 (or with no birthdate on file) can't sign in or keep
 * a session: a backstop, since signup already refuses anyone younger.
 */
export function isUnderage(birthdate: string | Date | null): boolean {
  return birthdate == null || ageOn(birthdate) < AGE.minimum;
}

/** Stored prefs merged over defaults. */
export function effectivePrefs(stored: Partial<Prefs> | null | undefined): Prefs {
  return { ...DEFAULT_PREFS, ...(stored ?? {}) } as Prefs;
}
