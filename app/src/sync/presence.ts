/**
 * Whether the Coach tab is currently on screen with the app in the foreground.
 * Set by the Coach screen; read by the sync engine to decide whether newly
 * synced messages count as seen.
 */
let coachVisible = false;

export function setCoachVisible(v: boolean): void {
  coachVisible = v;
}

export function isCoachVisible(): boolean {
  return coachVisible;
}
