import { AGE, DEFAULT_PREFS, MINOR_LOCKS, type Prefs } from '../shared/config.js';

/** Whole years between a YYYY-MM-DD birthdate and `now` (UTC). */
export function ageOn(birthdate: string | Date, now = new Date()): number {
  const b = typeof birthdate === 'string' ? new Date(`${birthdate}T00:00:00Z`) : birthdate;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

/** Unknown birthdate counts as under 18: the safe default for the locks. */
export function isMinor(birthdate: string | Date | null): boolean {
  return birthdate == null || ageOn(birthdate) < AGE.adult;
}

/** Stored prefs merged over defaults, with the under-18 locks applied last. */
export function effectivePrefs(stored: Partial<Prefs> | null | undefined, minor: boolean): Prefs {
  const merged = { ...DEFAULT_PREFS, ...(stored ?? {}) } as Prefs;
  return minor ? { ...merged, ...MINOR_LOCKS } : merged;
}

/** Keys a minor tried to change away from their locked value. */
export function lockedChanges(patch: Partial<Prefs>, minor: boolean): string[] {
  if (!minor) return [];
  return (Object.keys(MINOR_LOCKS) as (keyof Prefs)[]).filter((k) => k in patch && patch[k] !== MINOR_LOCKS[k]);
}
