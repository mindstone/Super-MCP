/** Confirmed dead grants since process start: invalid_grant not recovered by
 * the bounded peer re-read. Exposed through GET /stats for host reporting. */
const counts = new Map<string, number>();

export function countRefreshRefusal(packageId: string): void {
  counts.set(packageId, getRefreshRefusalCount(packageId) + 1);
}

export function getRefreshRefusalCount(packageId: string): number {
  return counts.get(packageId) ?? 0;
}

export function resetRefreshRefusalCountsForTests(): void { counts.clear(); }
