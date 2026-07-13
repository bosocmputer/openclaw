const MAX_EVENTS_PER_TURN = 20;
const MAX_STRING_CHARS = 4_000;
const MAX_DEPTH = 6;
const CAPTURE_TTL_MS = 10 * 60_000;

export type AgentBrainToolEvidence = {
  toolCallId?: string;
  toolName: string;
  status: "ok" | "error";
  durationMs?: number;
  input?: unknown;
  result?: unknown;
};

type EvidenceBucket = {
  createdAt: number;
  events: AgentBrainToolEvidence[];
};

const evidenceBySession = new Map<string, EvidenceBucket>();

function enabled(): boolean {
  const value = (process.env.AGENT_BRAIN_V2_ENABLED ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

function keyFor(agentId: string | undefined, sessionKey: string | undefined): string | undefined {
  const agent = agentId?.trim();
  const session = sessionKey?.trim();
  return agent && session ? `${agent}\0${session}` : undefined;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    const redacted = value
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/giu, "$1[redacted]")
      .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,}]+/giu, "$1[redacted]");
    return redacted.length > MAX_STRING_CHARS
      ? `${redacted.slice(0, MAX_STRING_CHARS)}...[truncated]`
      : redacted;
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => redactValue(entry, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(value).slice(0, 50)) {
    output[field] = /token|api[_-]?key|authorization|password|secret|cookie/iu.test(field)
      ? "[redacted]"
      : redactValue(raw, depth + 1);
  }
  return output;
}

function cleanupExpired(now = Date.now()): void {
  for (const [key, bucket] of evidenceBySession) {
    if (now - bucket.createdAt > CAPTURE_TTL_MS) {
      evidenceBySession.delete(key);
    }
  }
}

export function beginAgentBrainToolEvidenceCapture(params: {
  agentId?: string;
  sessionKey?: string;
}): void {
  if (!enabled()) {
    return;
  }
  cleanupExpired();
  const key = keyFor(params.agentId, params.sessionKey);
  if (key) {
    evidenceBySession.set(key, { createdAt: Date.now(), events: [] });
  }
}

export function recordAgentBrainToolEvidence(params: {
  agentId?: string;
  sessionKey?: string;
  event: AgentBrainToolEvidence;
}): void {
  if (!enabled()) {
    return;
  }
  const key = keyFor(params.agentId, params.sessionKey);
  if (!key) {
    return;
  }
  const bucket = evidenceBySession.get(key);
  if (!bucket || bucket.events.length >= MAX_EVENTS_PER_TURN) {
    return;
  }
  const toolCallId =
    typeof params.event.toolCallId === "string" ? params.event.toolCallId.slice(0, 120) : undefined;
  const durationMs =
    typeof params.event.durationMs === "number" && Number.isFinite(params.event.durationMs)
      ? Math.max(0, params.event.durationMs)
      : undefined;
  const input = redactValue(params.event.input);
  const result = redactValue(params.event.result);
  bucket.events.push({
    ...(toolCallId ? { toolCallId } : {}),
    toolName: params.event.toolName.slice(0, 160),
    status: params.event.status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(result !== undefined ? { result } : {}),
  });
}

export function consumeAgentBrainToolEvidence(params: {
  agentId?: string;
  sessionKey?: string;
}): AgentBrainToolEvidence[] {
  const key = keyFor(params.agentId, params.sessionKey);
  if (!key) {
    return [];
  }
  const events = evidenceBySession.get(key)?.events ?? [];
  evidenceBySession.delete(key);
  return events;
}

export function clearAgentBrainToolEvidenceForTests(): void {
  evidenceBySession.clear();
}
