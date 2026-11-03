/** Preserve each handler's existing copy for reasons with different recovery paths. */
export function setupIncompleteMessage(packageId: string, reason: string | undefined, fallback: string): string {
  return reason === 'reconnect_required'
    ? `Connection '${packageId}' needs setup. Try reconnecting it in Rebel's settings on your computer.`
    : fallback;
}
