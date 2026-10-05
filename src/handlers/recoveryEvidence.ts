/** Bounded control-field projection, not sign-in classification. */
export interface RecoveryControlCandidate {
  action?: "auth_required";
  auth_tool?: string;
  reason?: "token_expired" | "not_connected";
  ok?: false;
  code?: string;
  status?: "auth_required";
}
export interface RecoveryEvidenceV1 {
  version: 1;
  candidates: RecoveryControlCandidate[];
  overflow?: "content_blocks" | "text_size" | "parse_budget" | "candidates";
}
export const RECOVERY_EVIDENCE_LIMITS = {
  textCodeUnits: 2 * 1024 * 1024,
  totalParseCodeUnits: 8 * 1024 * 1024,
  contentBlocks: 128,
  candidates: 64,
} as const;
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function project(value: unknown): RecoveryControlCandidate | undefined {
  const payload = record(value);
  if (!payload) return undefined;
  // Preserve the host normalizer's action-first precedence, including rejecting
  // malformed action fields instead of exposing a lower-priority status/code.
  if (payload.action === "auth_required") {
    if (typeof payload.auth_tool !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(payload.auth_tool) ||
        (payload.reason !== "token_expired" && payload.reason !== "not_connected")) return undefined;
    return { action: "auth_required", auth_tool: payload.auth_tool, reason: payload.reason };
  }
  const candidate: RecoveryControlCandidate = {};
  if (payload.ok === false && typeof payload.code === "string" &&
      /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(payload.code)) {
    candidate.ok = false;
    candidate.code = payload.code;
  }
  if (payload.status === "auth_required") candidate.status = "auth_required";
  return Object.keys(candidate).length ? candidate : undefined;
}

/** Only the current original result is read; connector metadata is never adopted. */
export function extractRecoveryEvidenceV1(result: unknown): RecoveryEvidenceV1 | undefined {
  const candidates: RecoveryControlCandidate[] = [];
  const direct = project(result);
  if (direct) candidates.push(direct);
  const content = record(result)?.content;
  const overflow = (reason: NonNullable<RecoveryEvidenceV1["overflow"]>): RecoveryEvidenceV1 =>
    ({ version: 1, candidates: [], overflow: reason });
  if (Array.isArray(content)) {
    if (content.length > RECOVERY_EVIDENCE_LIMITS.contentBlocks) return overflow("content_blocks");
    let remaining = RECOVERY_EVIDENCE_LIMITS.totalParseCodeUnits;
    for (const block of content) {
      const item = record(block);
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      if (item.text.length > RECOVERY_EVIDENCE_LIMITS.textCodeUnits) return overflow("text_size");
      if (item.text.length > remaining) return overflow("parse_budget");
      remaining -= item.text.length;
      let parsed: unknown;
      try { parsed = JSON.parse(item.text); }
      catch { continue; } // Prose/malformed text is not complete producer JSON.
      const candidate = project(parsed);
      if (!candidate) continue;
      if (candidates.length >= RECOVERY_EVIDENCE_LIMITS.candidates) return overflow("candidates");
      candidates.push(candidate);
    }
  }
  return candidates.length ? { version: 1, candidates } : undefined;
}

/** The reserved field is constructed upstream, never relayed from a connector. */
export function stripConnectorRecoveryEvidence(result: unknown): unknown {
  const outer = record(result);
  const meta = record(outer?._meta);
  const superMcp = record(meta?.superMcp);
  if (!outer || !meta || !superMcp || !("recoveryEvidenceV1" in superMcp)) return result;
  const { recoveryEvidenceV1: _privateEvidence, ...retained } = superMcp;
  return { ...outer, _meta: { ...meta, superMcp: retained } };
}
