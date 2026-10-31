/**
 * One-day Halloween takeover. Imports nothing, so theme.ts can depend on it.
 *
 * Evaluated once at JS load, in the device's local time: a phone left
 * running past midnight keeps the costume until the app is relaunched.
 */
export function isHalloween(now: Date = new Date()): boolean {
  return now.getMonth() === 9 && now.getDate() === 31;
}

export const HALLOWEEN_ACTIVE: boolean = isHalloween();

/** The only room the group chat table accepts (see 0047_halloween_chat.sql). */
export const HALLOWEEN_ROOM = 'halloween-2026';
