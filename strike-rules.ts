import { SITE_ROOMS } from '../../shared/config.js';

export type StrikeAction = 'none' | 'room_mute' | 'site_mute';

/** Pure decision (no I/O) so it can be unit-tested: strikes in the short window and in the last hour. */
export function strikeAction(inWindow: number, inHour: number): StrikeAction {
  if (inHour >= SITE_ROOMS.strikesToSiteMute) return 'site_mute';
  if (inWindow >= SITE_ROOMS.strikesToRoomMute) return 'room_mute';
  return 'none';
}
