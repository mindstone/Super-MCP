// FOX-11496: the router's own proof that a connector call did not run, and the label that carries it out.

/** The router's package registry is closed (it is shutting down), so it admitted no call. */
export class RegistryClosedError extends Error {
  readonly code = "ERR_REGISTRY_CLOSED";

  constructor(packageId?: string) {
    super(
      packageId
        ? `MCP package registry is closed; cannot admit '${packageId}'`
        : "MCP package registry is closed",
    );
    this.name = "RegistryClosedError";
  }
}

/** The connector's cloud said, before passing the call on, that it would not take it. */
export class PackageHomeRefusedError extends Error {
  constructor(readonly reason: 'shutting_down' | 'registry_closed', connectorName: string) {
    super(`Your cloud was restarting, so ${connectorName} didn't start that action.`);
    this.name = 'PackageHomeRefusedError';
  }
}

/** The call never left this router, so the connector never saw it. */
export class NeverSentError extends Error {
  constructor(connectorName: string, options?: ErrorOptions) {
    super(`${connectorName} was reconnecting, so Rebel didn't send that action.`, options);
    this.name = 'NeverSentError';
  }
}

/** Whether a call that was never sent may be sent once more: the connector says the tool only reads, or repeats safely. */
export function isSafeToReplayNeverSent(annotations: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean } | undefined): boolean {
  if (!annotations) return false;
  return (annotations.readOnlyHint === true || annotations.idempotentHint === true) && annotations.destructiveHint !== true;
}

export const DISPATCH_LABEL_KEY = 'rebelDispatchV1';

export interface DispatchLabelV1 {
  v: 1;
  home: 'cloud' | 'local';
  packageId: string;
  verdict?: 'never_sent' | 'refused_before_running';
  reason?: 'registry_closed' | 'shutting_down';
}

/** The verdict comes only from the class of the error this router caught, never from its text, code or data. */
export function buildDispatchLabel(packageId: string, homed: boolean, caught: unknown): DispatchLabelV1 {
  const label: DispatchLabelV1 = { v: 1, home: homed ? 'cloud' : 'local', packageId };
  if (caught instanceof RegistryClosedError) return { ...label, verdict: 'never_sent', reason: 'registry_closed' };
  if (caught instanceof NeverSentError) return { ...label, verdict: 'never_sent' };
  if (caught instanceof PackageHomeRefusedError) return { ...label, verdict: 'refused_before_running', reason: caught.reason };
  return label;
}

/**
 * The error as it leaves the router: any label already in its `data` (a connector or the cloud can put anything
 * there) is dropped, and this router's own label, if any, is added beside the rest of `data`.
 */
export function withDispatchLabel<T extends object>(outgoing: T, label: DispatchLabelV1 | undefined): T {
  const { data } = outgoing as { data?: unknown };
  const record = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  if (data !== undefined && !record) return outgoing;
  if (!label && !(record && Object.hasOwn(record, DISPATCH_LABEL_KEY))) return outgoing;
  const { [DISPATCH_LABEL_KEY]: _incoming, ...rest } = record ?? {};
  return { ...outgoing, data: label ? { ...rest, [DISPATCH_LABEL_KEY]: label } : rest };
}
