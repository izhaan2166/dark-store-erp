/** A short double vibration that tells someone a scan was refused. */
export function buzz(): void {
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    // Not every device can vibrate.
  }
}
