// Shared Agent Brain runtime helpers for channel integrations.

type ReplyPayloadLike = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
  isStatusNotice?: boolean;
};

type RuntimeMessageContext = Record<string, unknown> & {
  Body?: string;
  BodyForAgent?: string;
  BodyForCommands?: string;
  RawBody?: string;
  CommandBody?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaPaths?: unknown[];
  MediaUrls?: unknown[];
  MessageSid?: string;
};

type AgentBrainEvaluation = {
  ok?: boolean;
  status?: string;
  memoriesToInject?: unknown;
  injectedChars?: unknown;
  includedMemoryIds?: unknown;
  assistantAddendum?: unknown;
};

export type AgentBrainRuntimeResult = {
  attempted: boolean;
  applied: boolean;
  status: "disabled" | "skipped" | "ok" | "error" | "timeout";
  durationMs?: number;
  injectedChars?: number;
  includedMemoryIds?: string[];
  assistantAddendum?: string;
  finalText?: string;
};

export type ApplyAgentBrainRuntimeParams = {
  ctxPayload: RuntimeMessageContext;
  agentId: string;
  channel: "line" | "telegram";
  accountId?: string;
  log?: (message: string) => void;
};

export type SubmitAgentBrainTurnEvidenceParams = ApplyAgentBrainRuntimeParams & {
  result: AgentBrainRuntimeResult | null | undefined;
};

const DEFAULT_AGENT_BRAIN_URL = "http://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 700;
const MAX_TIMEOUT_MS = 2_500;
const MAX_CONTEXT_CHARS = 1_500;
const MAX_ADDENDUM_CHARS = 800;

function normalizeEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAgentBrainEnabled(): boolean {
  return (
    normalizeEnvString(process.env.AGENT_BRAIN_ENABLED) === "1" ||
    normalizeEnvString(process.env.OPENCLAW_AGENT_BRAIN_ENABLED) === "1"
  );
}

function resolveAgentBrainApiBaseUrl(): string {
  return (
    normalizeEnvString(process.env.AGENT_BRAIN_API_URL) ??
    normalizeEnvString(process.env.OPENCLAW_AGENT_BRAIN_URL) ??
    normalizeEnvString(process.env.OPENCLAW_API_URL) ??
    DEFAULT_AGENT_BRAIN_URL
  ).replace(/\/+$/u, "");
}

function resolveAgentBrainApiToken(): string | undefined {
  return (
    normalizeEnvString(process.env.AGENT_BRAIN_API_TOKEN) ??
    normalizeEnvString(process.env.OPENCLAW_AGENT_BRAIN_TOKEN) ??
    normalizeEnvString(process.env.API_TOKEN)
  );
}

function resolveAgentBrainTimeoutMs(): number {
  const raw =
    normalizeEnvString(process.env.AGENT_BRAIN_TIMEOUT_MS) ??
    normalizeEnvString(process.env.OPENCLAW_AGENT_BRAIN_TIMEOUT_MS);
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function withEndpoint(baseUrl: string): string {
  if (/\/api$/u.test(baseUrl)) {
    return `${baseUrl}/agent-brain/evaluate-turn`;
  }
  return `${baseUrl}/api/agent-brain/evaluate-turn`;
}

function isControlCommand(ctxPayload: RuntimeMessageContext): boolean {
  const commandBody =
    normalizeEnvString(ctxPayload.BodyForCommands) ??
    normalizeEnvString(ctxPayload.CommandBody) ??
    normalizeEnvString(ctxPayload.RawBody);
  return Boolean(commandBody && /^[!/]\S/u.test(commandBody));
}

function countMedia(ctxPayload: RuntimeMessageContext): number {
  const mediaPaths = Array.isArray(ctxPayload.MediaPaths) ? ctxPayload.MediaPaths.length : 0;
  const mediaUrls = Array.isArray(ctxPayload.MediaUrls) ? ctxPayload.MediaUrls.length : 0;
  const single = ctxPayload.MediaPath || ctxPayload.MediaUrl ? 1 : 0;
  return Math.max(mediaPaths, mediaUrls, single);
}

function normalizeSafeLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}...` : trimmed;
}

function normalizeMemoryLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const lines: string[] = [];
  let total = 0;
  for (const entry of value) {
    const line = normalizeSafeLine(entry, 300);
    if (!line) {
      continue;
    }
    const nextTotal = total + line.length + 1;
    if (nextTotal > MAX_CONTEXT_CHARS) {
      break;
    }
    lines.push(line);
    total = nextTotal;
  }
  return lines;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeSafeLine(entry, 120)).filter(Boolean) as string[];
}

function buildAgentBrainContextBlock(lines: string[]): string | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  return [
    "",
    "## Agent Knowledge Brain",
    "Use the following admin-approved stable hints only as extra context.",
    "Dynamic ERP facts such as price, cost, stock, availability, credit, discounts, and substitute products must still be verified with MCP/SML tools.",
    ...lines,
  ].join("\n");
}

function appendContextBlock(ctxPayload: RuntimeMessageContext, block: string): void {
  const currentBody = typeof ctxPayload.Body === "string" ? ctxPayload.Body : "";
  const currentAgent = typeof ctxPayload.BodyForAgent === "string" ? ctxPayload.BodyForAgent : "";
  ctxPayload.Body = currentBody ? `${currentBody}\n${block}` : block.trimStart();
  ctxPayload.BodyForAgent = currentAgent ? `${currentAgent}\n${block}` : block.trimStart();
  (ctxPayload as Record<string, unknown>).AgentBrainContextApplied = true;
}

function normalizeAssistantAddendum(value: unknown): string | undefined {
  return normalizeSafeLine(value, MAX_ADDENDUM_CHARS);
}

async function postAgentBrainEvaluation(params: {
  body: Record<string, unknown>;
  token: string;
  endpoint: string;
  timeoutMs: number;
}): Promise<{ evaluation?: AgentBrainEvaluation; timedOut: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { timedOut: false };
    }
    const json = (await response.json()) as AgentBrainEvaluation;
    return { evaluation: json, timedOut: false };
  } catch (err) {
    if ((err as { name?: unknown })?.name === "AbortError") {
      return { timedOut: true };
    }
    return { timedOut: false };
  } finally {
    clearTimeout(timeout);
  }
}

export async function applyAgentBrainRuntimeContext(
  params: ApplyAgentBrainRuntimeParams,
): Promise<AgentBrainRuntimeResult> {
  const startedAt = Date.now();
  if (!isAgentBrainEnabled()) {
    return { attempted: false, applied: false, status: "disabled" };
  }
  if (isControlCommand(params.ctxPayload)) {
    return { attempted: false, applied: false, status: "skipped" };
  }
  const token = resolveAgentBrainApiToken();
  if (!token) {
    params.log?.("agent_brain_runtime status=skipped reason=missing_token");
    return { attempted: false, applied: false, status: "skipped" };
  }

  const userText =
    normalizeEnvString(params.ctxPayload.BodyForAgent) ??
    normalizeEnvString(params.ctxPayload.RawBody) ??
    normalizeEnvString(params.ctxPayload.Body) ??
    "";
  const mediaCount = countMedia(params.ctxPayload);
  if (!userText && mediaCount === 0) {
    return { attempted: false, applied: false, status: "skipped" };
  }

  const endpoint = withEndpoint(resolveAgentBrainApiBaseUrl());
  const timeoutMs = resolveAgentBrainTimeoutMs();
  const { evaluation, timedOut } = await postAgentBrainEvaluation({
    endpoint,
    token,
    timeoutMs,
    body: {
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId ?? "default",
      turnId: params.ctxPayload.MessageSid,
      userText,
      hasMedia: mediaCount > 0,
      mediaCount,
    },
  });
  const durationMs = Date.now() - startedAt;
  if (timedOut) {
    params.log?.(`agent_brain_runtime status=timeout durationMs=${durationMs}`);
    return { attempted: true, applied: false, status: "timeout", durationMs };
  }
  if (!evaluation?.ok) {
    params.log?.(
      `agent_brain_runtime status=error reason=${normalizeSafeLine(evaluation?.status, 80) ?? "request_failed"} durationMs=${durationMs}`,
    );
    return { attempted: true, applied: false, status: "error", durationMs };
  }

  const lines = normalizeMemoryLines(evaluation.memoriesToInject);
  const block = buildAgentBrainContextBlock(lines);
  if (block) {
    appendContextBlock(params.ctxPayload, block);
  }
  const assistantAddendum = normalizeAssistantAddendum(evaluation.assistantAddendum);
  const injectedChars =
    typeof evaluation.injectedChars === "number" && Number.isFinite(evaluation.injectedChars)
      ? evaluation.injectedChars
      : lines.join("\n").length;
  const includedMemoryIds = normalizeStringArray(evaluation.includedMemoryIds);
  params.log?.(
    `agent_brain_runtime status=ok applied=${Boolean(block)} injectedChars=${injectedChars} durationMs=${durationMs}`,
  );
  return {
    attempted: true,
    applied: Boolean(block),
    status: "ok",
    durationMs,
    injectedChars,
    includedMemoryIds,
    ...(assistantAddendum ? { assistantAddendum } : {}),
  };
}

export function appendAgentBrainAddendumToPayload<TPayload extends ReplyPayloadLike>(
  payload: TPayload,
  result: AgentBrainRuntimeResult | null | undefined,
  kind?: string,
): TPayload {
  const addendum = result?.assistantAddendum;
  if (
    !addendum ||
    kind !== "final" ||
    payload.isError ||
    payload.isReasoning ||
    payload.isStatusNotice
  ) {
    return payload;
  }
  const existing = typeof payload.text === "string" ? payload.text.trimEnd() : "";
  if (!existing || existing.includes(addendum)) {
    return payload;
  }
  return {
    ...payload,
    text: `${existing}\n\n${addendum}`,
  } as TPayload;
}

export function recordAgentBrainFinalPayload(
  result: AgentBrainRuntimeResult | null | undefined,
  payload: ReplyPayloadLike,
  kind?: string,
): void {
  if (
    !result ||
    kind !== "final" ||
    payload.isError ||
    payload.isReasoning ||
    payload.isStatusNotice
  ) {
    return;
  }
  const finalText = normalizeSafeLine(payload.text, 1_500);
  if (finalText) {
    result.finalText = finalText;
  }
}

export async function submitAgentBrainTurnEvidence(
  params: SubmitAgentBrainTurnEvidenceParams,
): Promise<void> {
  const startedAt = Date.now();
  const result = params.result;
  if (!isAgentBrainEnabled() || !result?.attempted || isControlCommand(params.ctxPayload)) {
    return;
  }
  const token = resolveAgentBrainApiToken();
  if (!token) {
    return;
  }
  const userText =
    normalizeEnvString(params.ctxPayload.BodyForAgent) ??
    normalizeEnvString(params.ctxPayload.RawBody) ??
    normalizeEnvString(params.ctxPayload.Body) ??
    "";
  const finalText = normalizeSafeLine(result.finalText, 1_500) ?? "";
  const mediaCount = countMedia(params.ctxPayload);
  if (!userText && !finalText && mediaCount === 0) {
    return;
  }
  const { evaluation, timedOut } = await postAgentBrainEvaluation({
    endpoint: withEndpoint(resolveAgentBrainApiBaseUrl()),
    token,
    timeoutMs: resolveAgentBrainTimeoutMs(),
    body: {
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId ?? "default",
      turnId: params.ctxPayload.MessageSid,
      userText,
      finalText,
      hasMedia: mediaCount > 0,
      mediaCount,
      evidencePhase: "post_turn",
    },
  });
  const durationMs = Date.now() - startedAt;
  if (timedOut) {
    params.log?.(`agent_brain_post status=timeout durationMs=${durationMs}`);
    return;
  }
  params.log?.(
    `agent_brain_post status=${evaluation?.ok ? "ok" : "error"} reason=${normalizeSafeLine(evaluation?.status, 80) ?? "request_failed"} durationMs=${durationMs}`,
  );
}
