// Line plugin module implements bot handlers behavior.
import type { webhook } from "@line/bot-sdk";
import { buildMentionRegexes, matchesMentionPatterns } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-auth-native";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readChannelAllowFromStore,
  resolvePairingIdLabel,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { firstDefined, normalizeLineAllowEntry } from "./bot-access.js";
import {
  buildLineMessageContext,
  buildLinePostbackContext,
  getLineSourceInfo,
  type LineInboundContext,
} from "./bot-message-context.js";
import { downloadLineMedia } from "./download.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";

type FollowEvent = webhook.FollowEvent;
type JoinEvent = webhook.JoinEvent;
type LeaveEvent = webhook.LeaveEvent;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type UnfollowEvent = webhook.UnfollowEvent;
type WebhookEvent = webhook.Event;

interface MediaRef {
  path: string;
  contentType?: string;
}

const LINE_DOWNLOADABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function isDownloadableLineMessageType(
  messageType: MessageEvent["message"]["type"],
): messageType is "image" | "video" | "audio" | "file" {
  return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}

export interface LineHandlerContext {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  mediaMaxBytes: number;
  processMessage: (ctx: LineInboundContext) => Promise<void>;
  replayCache?: LineWebhookReplayCache;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
}

const LINE_WEBHOOK_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const LINE_WEBHOOK_REPLAY_MAX_ENTRIES = 4096;
export type LineWebhookReplayCache = ClaimableDedupe;

function normalizeLineIngressEntry(value: string): string | null {
  return normalizeLineAllowEntry(value) || null;
}

export class LineRetryableWebhookError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LineRetryableWebhookError";
  }
}

export function createLineWebhookReplayCache(): LineWebhookReplayCache {
  return createClaimableDedupe({
    ttlMs: LINE_WEBHOOK_REPLAY_WINDOW_MS,
    memoryMaxSize: LINE_WEBHOOK_REPLAY_MAX_ENTRIES,
  });
}

function buildLineWebhookReplayKey(
  event: WebhookEvent,
  accountId: string,
): { key: string; eventId: string } | null {
  if (event.type === "message") {
    const messageId = event.message?.id?.trim();
    if (messageId) {
      return {
        key: `${accountId}|message:${messageId}`,
        eventId: `message:${messageId}`,
      };
    }
  }
  const eventId = (event as { webhookEventId?: string }).webhookEventId?.trim();
  if (!eventId) {
    return null;
  }

  const source = (
    event as {
      source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
    }
  ).source;
  const sourceId =
    source?.type === "group"
      ? `group:${source.groupId ?? ""}`
      : source?.type === "room"
        ? `room:${source.roomId ?? ""}`
        : `user:${source?.userId ?? ""}`;
  return { key: `${accountId}|${event.type}|${sourceId}|${eventId}`, eventId: `event:${eventId}` };
}

type LineReplayCandidate = {
  key: string;
  eventId: string;
  cache: LineWebhookReplayCache;
};

function getLineReplayCandidate(
  event: WebhookEvent,
  context: LineHandlerContext,
): LineReplayCandidate | null {
  const replay = buildLineWebhookReplayKey(event, context.account.accountId);
  const cache = context.replayCache;
  if (!replay || !cache) {
    return null;
  }
  return { key: replay.key, eventId: replay.eventId, cache };
}

async function claimLineReplayEvent(
  candidate: LineReplayCandidate,
): Promise<{ skip: true; inFlightResult?: Promise<void> } | { skip: false }> {
  const claim = await candidate.cache.claim(candidate.key);
  if (claim.kind === "claimed") {
    return { skip: false };
  }
  if (claim.kind === "inflight") {
    logVerbose(`line: skipped in-flight replayed webhook event ${candidate.eventId}`);
    return { skip: true, inFlightResult: claim.pending.then(() => undefined) };
  }
  logVerbose(`line: skipped replayed webhook event ${candidate.eventId}`);
  return { skip: true };
}

function resolveLineGroupConfig(params: {
  config: ResolvedLineAccount["config"];
  groupId?: string;
  roomId?: string;
}): LineGroupConfig | undefined {
  return resolveLineGroupConfigEntry(params.config.groups, {
    groupId: params.groupId,
    roomId: params.roomId,
  });
}

async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  await createChannelPairingChallengeIssuer({
    channel: "line",
    accountId: context.account.accountId,
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertChannelPairingRequest({
        channel: "line",
        id,
        accountId: context.account.accountId,
        meta,
      }),
  })({
    senderId,
    senderIdLine: `Your ${idLabel}: ${senderId}`,
    onCreated: () => {
      logVerbose(`line pairing request sender=${senderId}`);
    },
    sendPairingReply: async (text) => {
      if (replyToken) {
        try {
          await replyMessageLine(replyToken, [{ type: "text", text }], {
            cfg: context.cfg,
            accountId: context.account.accountId,
            channelAccessToken: context.account.channelAccessToken,
          });
          return;
        } catch (err) {
          logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
        }
      }
      try {
        await pushMessageLine(`line:${senderId}`, text, {
          cfg: context.cfg,
          accountId: context.account.accountId,
          channelAccessToken: context.account.channelAccessToken,
        });
      } catch (err) {
        logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
      }
    },
  });
}

async function shouldProcessLineEvent(
  event: MessageEvent | PostbackEvent,
  context: LineHandlerContext,
) {
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const senderId = userId ?? "";
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const rawText = resolveEventRawText(event);
  const requireMention = isGroup ? groupConfig?.requireMention !== false : false;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const { groupPolicy: runtimeGroupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.line !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
    });
  const groupPolicy: GroupPolicy =
    runtimeGroupPolicy === "disabled"
      ? "disabled"
      : groupConfig?.allowFrom !== undefined
        ? "allowlist"
        : runtimeGroupPolicy;
  const groupAllowFrom = normalizeStringEntries(
    firstDefined(
      groupConfig?.allowFrom,
      account.config.groupAllowFrom,
      account.config.allowFrom?.length ? account.config.allowFrom : undefined,
    ),
  );
  const mentionFacts = (() => {
    if (!isGroup || event.type !== "message") {
      return { canDetectMention: false, wasMentioned: false, hasAnyMention: false };
    }
    const peerId = groupId ?? roomId ?? userId ?? "unknown";
    const { agentId } = resolveAgentRoute({
      cfg,
      channel: "line",
      accountId: account.accountId,
      peer: { kind: "group", id: peerId },
    });
    const mentionRegexes = buildMentionRegexes(cfg, agentId);
    const wasMentionedByNative = isLineBotMentioned(event.message);
    const wasMentionedByPattern =
      event.message.type === "text" ? matchesMentionPatterns(rawText, mentionRegexes) : false;
    return {
      canDetectMention: event.message.type === "text",
      wasMentioned: wasMentionedByNative || wasMentionedByPattern,
      hasAnyMention: hasAnyLineMention(event.message),
    };
  })();
  const access = await resolveStableChannelMessageIngress({
    channelId: "line",
    accountId: account.accountId,
    identity: {
      key: "line-user-id",
      normalize: normalizeLineIngressEntry,
      sensitivity: "pii",
      entryIdPrefix: "line-entry",
    },
    cfg,
    readStoreAllowFrom: async () =>
      await readChannelAllowFromStore("line", undefined, account.accountId),
    subject: { stableId: senderId },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: (groupId ?? roomId ?? senderId) || "unknown",
    },
    ...(isGroup && groupConfig?.enabled === false
      ? { route: { id: "line:group-config", enabled: false } }
      : {}),
    mentionFacts:
      isGroup && event.type === "message"
        ? {
            canDetectMention: mentionFacts.canDetectMention,
            wasMentioned: mentionFacts.wasMentioned,
            hasAnyMention: mentionFacts.hasAnyMention,
            implicitMentionKinds: [],
          }
        : undefined,
    event: { kind: event.type === "postback" ? "postback" : "message" },
    dmPolicy,
    groupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      activation: {
        requireMention: isGroup && event.type === "message" && requireMention,
        allowTextCommands: true,
      },
    },
    allowFrom: normalizeStringEntries(account.config.allowFrom),
    groupAllowFrom,
    command: {
      hasControlCommand: shouldComputeCommandAuthorized(rawText, cfg),
      groupOwnerAllowFrom: "none",
    },
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "line",
    accountId: account.accountId,
    log: (message) => logVerbose(message),
  });

  if (
    access.senderAccess.decision === "allow" &&
    (access.ingress.admission === "dispatch" ||
      access.ingress.admission === "observe" ||
      access.ingress.admission === "skip")
  ) {
    return access;
  }

  if (access.senderAccess.decision === "allow") {
    logVerbose(`Blocked line event (${access.ingress.reasonCode})`);
    return null;
  }

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
      return null;
    }
    if (groupConfig?.allowFrom !== undefined) {
      if (!senderId) {
        logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
        return null;
      }
      if (access.senderAccess.reasonCode !== "group_policy_allowed") {
        logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
        return null;
      }
    }
    if (access.senderAccess.reasonCode === "group_policy_disabled") {
      logVerbose("Blocked line group message (groupPolicy: disabled)");
    } else if (!senderId && groupPolicy === "allowlist") {
      logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
    } else if (access.senderAccess.reasonCode === "group_policy_empty_allowlist") {
      logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
    } else {
      logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
    }
    return null;
  }

  if (access.senderAccess.reasonCode === "dm_policy_disabled") {
    logVerbose("Blocked line sender (dmPolicy: disabled)");
    return null;
  }

  if (access.senderAccess.decision === "pairing") {
    if (!senderId) {
      logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
      return null;
    }
    await sendLinePairingReply({
      senderId,
      replyToken: "replyToken" in event ? event.replyToken : undefined,
      context,
    });
    return null;
  }

  logVerbose(
    `Blocked line sender ${senderId || "unknown"} (dmPolicy: ${
      account.config.dmPolicy ?? "pairing"
    })`,
  );
  return null;
}

function getLineMentionees(
  message: MessageEvent["message"],
): Array<{ type?: string; isSelf?: boolean }> {
  if (message.type !== "text") {
    return [];
  }
  const mentionees = (
    message as Record<string, unknown> & {
      mention?: { mentionees?: Array<{ type?: string; isSelf?: boolean }> };
    }
  ).mention?.mentionees;
  return Array.isArray(mentionees) ? mentionees : [];
}

function isLineBotMentioned(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).some((m) => m.isSelf === true || m.type === "all");
}

function hasAnyLineMention(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).length > 0;
}

function resolveEventRawText(event: MessageEvent | PostbackEvent): string {
  if (event.type === "message") {
    const msg = event.message;
    if (msg.type === "text") {
      return msg.text;
    }
    return "";
  }
  if (event.type === "postback") {
    return event.postback?.data?.trim() ?? "";
  }
  return "";
}

type LineEventProcessDecision = NonNullable<Awaited<ReturnType<typeof shouldProcessLineEvent>>>;

type PreparedLineMessageEvent = {
  event: MessageEvent;
  decision: LineEventProcessDecision;
  allMedia: MediaRef[];
  mediaUnavailable: boolean;
  rawText: string;
  messageType: MessageEvent["message"]["type"];
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
};

type LineBurstWaiter = {
  resolve: () => void;
  reject: (err: unknown) => void;
};

type PendingLineBurst = {
  key: string;
  accountId: string;
  chatType: "direct" | "group" | "room" | "unknown";
  createdAt: number;
  candidates: PreparedLineMessageEvent[];
  waiters: LineBurstWaiter[];
  flushTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
};

type PendingLineMediaPreflight = {
  key: string;
  accountId: string;
  chatType: PendingLineBurst["chatType"];
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

type LineBurstOptions = {
  enabled: boolean;
  windowMs: number;
  textWindowMs: number;
  maxWaitMs: number;
  maxEvents: number;
};

const pendingLineBursts = new Map<string, PendingLineBurst>();
const pendingLineMediaPreflights = new Map<string, PendingLineMediaPreflight>();

function sanitizeLineBurstMarkerValue(value: unknown): string {
  const raw = String(value ?? "unknown")
    .replace(/\s+/g, "_")
    .replace(/[^\w:./-]/g, "_");
  return raw.slice(0, 120) || "unknown";
}

function logLineBurstMarker(marker: string, fields: Record<string, unknown>): void {
  const body = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${sanitizeLineBurstMarkerValue(value)}`)
    .join(" ");
  console.log(`${marker}${body ? ` ${body}` : ""}`);
}

function coerceLineBurstMs(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(Math.floor(value), max));
}

function coerceLineBurstPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(value), max));
}

function resolveLineBurstOptions(context: LineHandlerContext): LineBurstOptions {
  const rootConfig = (context.cfg.channels?.line as { messageCoalescing?: Record<string, unknown> } | undefined)
    ?.messageCoalescing;
  const accountConfig = (context.account.config as { messageCoalescing?: Record<string, unknown> })
    .messageCoalescing;
  const config = accountConfig ?? rootConfig ?? {};
  const killSwitch = process.env.OPENCLAW_LINE_COALESCING?.trim();
  const enabled =
    killSwitch === "0" || killSwitch?.toLowerCase() === "false"
      ? false
      : config.enabled !== false;
  return {
    enabled,
    windowMs: coerceLineBurstMs(config.windowMs, 3000, 15000),
    textWindowMs: coerceLineBurstMs(config.textWindowMs, 0, 5000),
    maxWaitMs: coerceLineBurstMs(config.maxWaitMs, 5000, 30000),
    maxEvents: coerceLineBurstPositiveInt(config.maxEvents, 5, 20),
  };
}

function lineBurstChatType(params: {
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
}): "direct" | "group" | "room" | "unknown" {
  if (params.groupId) {
    return "group";
  }
  if (params.roomId) {
    return "room";
  }
  if (!params.isGroup) {
    return "direct";
  }
  return "unknown";
}

function resolveLineBurstKey(
  prepared: PreparedLineMessageEvent,
  accountId: string,
): { key: string; chatType: PendingLineBurst["chatType"] } {
  return resolveLineBurstKeyFromSource(prepared.event.source, accountId);
}

function resolveLineBurstKeyFromSource(
  source: MessageEvent["source"],
  accountId: string,
): { key: string; chatType: PendingLineBurst["chatType"] } {
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(source);
  const peer = groupId ? `group:${groupId}` : roomId ? `room:${roomId}` : `user:${userId ?? "unknown"}`;
  const sender = userId ?? "unknown";
  return {
    key: `${accountId}|${peer}|sender:${sender}`,
    chatType: lineBurstChatType({ isGroup, groupId, roomId }),
  };
}

function clearLineMediaPreflight(key: string, reason?: string): void {
  const pending = pendingLineMediaPreflights.get(key);
  if (!pending) {
    return;
  }
  pendingLineMediaPreflights.delete(key);
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  if (reason) {
    logLineBurstMarker("line_burst_bypass", {
      accountId: pending.accountId,
      chatType: pending.chatType,
      eventCount: 0,
      mediaCount: 1,
      textCount: 0,
      waitMs: Date.now() - pending.startedAt,
      flushReason: reason,
    });
  }
}

function markLineMediaPreflight(
  event: MessageEvent,
  accountId: string,
  options: LineBurstOptions,
): string | null {
  if (!options.enabled || !isDownloadableLineMessageType(event.message.type)) {
    return null;
  }
  const { key, chatType } = resolveLineBurstKeyFromSource(event.source, accountId);
  clearLineMediaPreflight(key);
  const pending: PendingLineMediaPreflight = {
    key,
    accountId,
    chatType,
    startedAt: Date.now(),
  };
  pending.timer = setTimeout(() => {
    clearLineMediaPreflight(key, "media_preflight_expired");
  }, Math.max(options.windowMs, options.maxWaitMs));
  pending.timer.unref?.();
  pendingLineMediaPreflights.set(key, pending);
  logLineBurstMarker("line_burst_preflight", {
    accountId,
    chatType,
    eventCount: 1,
    mediaCount: 1,
    textCount: 0,
    waitMs: 0,
    flushReason: "media_download_pending",
  });
  return key;
}

function linePreparedHasMedia(prepared: PreparedLineMessageEvent): boolean {
  return prepared.allMedia.length > 0 || isDownloadableLineMessageType(prepared.messageType);
}

function isLineCoalesciblePreparedMessage(prepared: PreparedLineMessageEvent): boolean {
  return prepared.messageType === "text" || isDownloadableLineMessageType(prepared.messageType);
}

function isLineImmediateControlMessage(prepared: PreparedLineMessageEvent, cfg: OpenClawConfig): boolean {
  const text = prepared.rawText.trim();
  return Boolean(text && text.startsWith("/")) || shouldComputeCommandAuthorized(text, cfg);
}

function countLineBurstMedia(candidates: readonly PreparedLineMessageEvent[]): number {
  return candidates.reduce(
    (count, candidate) =>
      count + Math.max(candidate.allMedia.length, isDownloadableLineMessageType(candidate.messageType) ? 1 : 0),
    0,
  );
}

function countLineBurstText(candidates: readonly PreparedLineMessageEvent[]): number {
  return candidates.filter((candidate) => candidate.rawText.trim().length > 0).length;
}

function formatLineBurstText(texts: readonly string[]): string {
  const cleaned = texts.map((text) => text.trim()).filter(Boolean);
  if (cleaned.length <= 1) {
    return cleaned[0] ?? "";
  }
  return `ข้อความจากผู้ใช้ในช่วงเดียวกัน:\n${cleaned
    .map((text, index) => `${index + 1}. ${text}`)
    .join("\n")}`;
}

function clearLineBurstTimers(pending: PendingLineBurst): void {
  if (pending.flushTimer) {
    clearTimeout(pending.flushTimer);
  }
  if (pending.maxTimer) {
    clearTimeout(pending.maxTimer);
  }
}

function settleLineBurstWaiters(pending: PendingLineBurst, err?: unknown): void {
  const waiters = pending.waiters.splice(0);
  for (const waiter of waiters) {
    if (err) {
      waiter.reject(err);
    } else {
      waiter.resolve();
    }
  }
}

function buildCoalescedLineMessage(pending: PendingLineBurst): PreparedLineMessageEvent {
  const candidates = pending.candidates;
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (!first || !last) {
    throw new Error("LINE burst cannot be flushed without candidates");
  }
  const allMedia = candidates.flatMap((candidate) => candidate.allMedia);
  const mediaUnavailable = candidates.some((candidate) => candidate.mediaUnavailable);
  const text = formatLineBurstText(candidates.map((candidate) => candidate.rawText));
  if (!text) {
    return {
      ...last,
      allMedia,
      mediaUnavailable,
    };
  }

  const syntheticEvent = {
    ...last.event,
    message: {
      type: "text" as const,
      id: last.event.message.id || first.event.message.id,
      text,
    },
    timestamp: last.event.timestamp,
  } as MessageEvent;

  return {
    ...last,
    event: syntheticEvent,
    allMedia,
    mediaUnavailable,
    rawText: text,
    messageType: "text",
  };
}

async function flushLineBurst(
  key: string,
  reason: string,
  context: LineHandlerContext,
): Promise<void> {
  const pending = pendingLineBursts.get(key);
  if (!pending) {
    return;
  }
  pendingLineBursts.delete(key);
  clearLineBurstTimers(pending);
  const waitMs = Date.now() - pending.createdAt;
  logLineBurstMarker("line_burst_flush", {
    accountId: pending.accountId,
    chatType: pending.chatType,
    eventCount: pending.candidates.length,
    mediaCount: countLineBurstMedia(pending.candidates),
    textCount: countLineBurstText(pending.candidates),
    waitMs,
    flushReason: reason,
  });
  try {
    await dispatchPreparedLineMessage(buildCoalescedLineMessage(pending), context);
    settleLineBurstWaiters(pending);
  } catch (err) {
    settleLineBurstWaiters(pending, err);
    throw err;
  }
}

async function cancelLineBurst(
  key: string,
  reason: string,
): Promise<void> {
  const pending = pendingLineBursts.get(key);
  if (!pending) {
    return;
  }
  pendingLineBursts.delete(key);
  clearLineBurstTimers(pending);
  logLineBurstMarker("line_burst_bypass", {
    accountId: pending.accountId,
    chatType: pending.chatType,
    eventCount: pending.candidates.length,
    mediaCount: countLineBurstMedia(pending.candidates),
    textCount: countLineBurstText(pending.candidates),
    waitMs: Date.now() - pending.createdAt,
    flushReason: reason,
  });
  settleLineBurstWaiters(pending);
}

function scheduleLineBurstFlush(
  pending: PendingLineBurst,
  options: LineBurstOptions,
  context: LineHandlerContext,
  windowMs = options.windowMs,
): void {
  if (pending.flushTimer) {
    clearTimeout(pending.flushTimer);
  }
  pending.flushTimer = setTimeout(() => {
    flushLineBurst(pending.key, "window_elapsed", context).catch((err) => {
      context.runtime.error?.(danger(`line: burst flush failed: ${String(err)}`));
    });
  }, windowMs);
  pending.flushTimer.unref?.();

  if (!pending.maxTimer) {
    pending.maxTimer = setTimeout(() => {
      flushLineBurst(pending.key, "max_wait_elapsed", context).catch((err) => {
        context.runtime.error?.(danger(`line: burst max-wait flush failed: ${String(err)}`));
      });
    }, options.maxWaitMs);
    pending.maxTimer.unref?.();
  }
}

async function dispatchLineMessageWithCoalescing(
  prepared: PreparedLineMessageEvent,
  context: LineHandlerContext,
  options = resolveLineBurstOptions(context),
): Promise<void> {
  const { key, chatType } = resolveLineBurstKey(prepared, context.account.accountId);
  const existing = pendingLineBursts.get(key);
  const mediaPreflightActive = pendingLineMediaPreflights.has(key);

  if (!options.enabled || !isLineCoalesciblePreparedMessage(prepared)) {
    if (existing) {
      await flushLineBurst(key, options.enabled ? "non_coalescible" : "disabled", context);
    }
    await dispatchPreparedLineMessage(prepared, context);
    return;
  }

  if (isLineImmediateControlMessage(prepared, context.cfg)) {
    if (existing) {
      await cancelLineBurst(key, "control_command");
    }
    await dispatchPreparedLineMessage(prepared, context);
    return;
  }

  const hasMedia = linePreparedHasMedia(prepared);
  const existingHasMedia = existing ? countLineBurstMedia(existing.candidates) > 0 : false;
  const holdWindowMs =
    hasMedia || existingHasMedia || mediaPreflightActive ? options.windowMs : options.textWindowMs;
  if (!existing && !hasMedia && holdWindowMs <= 0) {
    await dispatchPreparedLineMessage(prepared, context);
    return;
  }

  if (existing && existing.candidates.length >= options.maxEvents) {
    await flushLineBurst(key, "max_events", context);
    await dispatchLineMessageWithCoalescing(prepared, context);
    return;
  }

  const pending =
    existing ??
    ({
      key,
      accountId: context.account.accountId,
      chatType,
      createdAt: Date.now(),
      candidates: [],
      waiters: [],
    } satisfies PendingLineBurst);

  if (!existing) {
    pendingLineBursts.set(key, pending);
  }
  pending.candidates.push(prepared);
  logLineBurstMarker(existing ? "line_burst_append" : "line_burst_start", {
    accountId: pending.accountId,
    chatType: pending.chatType,
    eventCount: pending.candidates.length,
    mediaCount: countLineBurstMedia(pending.candidates),
    textCount: countLineBurstText(pending.candidates),
    waitMs: Date.now() - pending.createdAt,
    flushReason: "pending",
  });
  scheduleLineBurstFlush(pending, options, context, holdWindowMs);
  await new Promise<void>((resolve, reject) => {
    pending.waiters.push({ resolve, reject });
  });
}

async function prepareLineMessageEvent(
  event: MessageEvent,
  context: LineHandlerContext,
): Promise<PreparedLineMessageEvent | null> {
  const { account, runtime, mediaMaxBytes } = context;
  const message = event.message;

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return null;
  }

  const { isGroup, groupId, roomId } = getLineSourceInfo(event.source);
  if (isGroup && decision.activationAccess.shouldSkip) {
    const rawText = message.type === "text" ? message.text : "";
    const sourceInfo = getLineSourceInfo(event.source);
    logVerbose(`line: skipping group message (requireMention, not mentioned)`);
    const historyKey = groupId ?? roomId;
    const senderId = sourceInfo.userId ?? "unknown";
    if (historyKey && context.groupHistories) {
      createChannelHistoryWindow({ historyMap: context.groupHistories }).record({
        historyKey,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
        entry: {
          sender: `user:${senderId}`,
          body: rawText || `<${message.type}>`,
          timestamp: event.timestamp,
        },
      });
    }
    return null;
  }

  const allMedia: MediaRef[] = [];
  let mediaUnavailable = false;

  if (isDownloadableLineMessageType(message.type)) {
    try {
      const originalFilename =
        message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
      const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes, {
        originalFilename,
      });
      allMedia.push({
        path: media.path,
        contentType: media.contentType,
      });
    } catch (err) {
      mediaUnavailable = true;
      const errMsg = String(err);
      if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
        logVerbose(`line: media exceeds size limit for message ${message.id}`);
      } else {
        runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
      }
    }
  }

  return {
    event,
    decision,
    allMedia,
    mediaUnavailable,
    rawText: resolveEventRawText(event),
    messageType: message.type,
    isGroup,
    groupId,
    roomId,
  };
}

async function dispatchPreparedLineMessage(
  prepared: PreparedLineMessageEvent,
  context: LineHandlerContext,
): Promise<void> {
  const { cfg, account, processMessage } = context;
  const messageContext = await buildLineMessageContext({
    event: prepared.event,
    allMedia: prepared.allMedia,
    mediaUnavailable: prepared.mediaUnavailable,
    cfg,
    account,
    commandAuthorized: prepared.decision.commandAccess.authorized,
    groupHistories: context.groupHistories,
    historyLimit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  });

  if (!messageContext) {
    logVerbose("line: skipping empty message");
    return;
  }

  await processMessage(messageContext);

  if (prepared.isGroup && context.groupHistories) {
    const historyKey = prepared.groupId ?? prepared.roomId;
    if (historyKey && context.groupHistories.has(historyKey)) {
      createChannelHistoryWindow({ historyMap: context.groupHistories }).clear({
        historyKey,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
      });
    }
  }
}

async function handleMessageEvent(event: MessageEvent, context: LineHandlerContext): Promise<void> {
  const options = resolveLineBurstOptions(context);
  const preflightKey = markLineMediaPreflight(event, context.account.accountId, options);
  let prepared: PreparedLineMessageEvent | null = null;
  try {
    prepared = await prepareLineMessageEvent(event, context);
    if (!prepared) {
      return;
    }
    await dispatchLineMessageWithCoalescing(prepared, context, options);
  } catch (err) {
    const markerKey = prepared
      ? resolveLineBurstKey(prepared, context.account.accountId)
      : resolveLineBurstKeyFromSource(event.source, context.account.accountId);
    logLineBurstMarker("line_burst_error", {
      accountId: context.account.accountId,
      chatType: markerKey.chatType,
      eventCount: 1,
      mediaCount: prepared
        ? linePreparedHasMedia(prepared)
          ? 1
          : 0
        : isDownloadableLineMessageType(event.message.type)
          ? 1
          : 0,
      textCount: prepared
        ? prepared.rawText.trim()
          ? 1
          : 0
        : event.message.type === "text" && event.message.text.trim()
          ? 1
          : 0,
      flushReason: "error",
    });
    throw err;
  } finally {
    if (preflightKey) {
      clearLineMediaPreflight(preflightKey);
    }
  }
}

async function handleFollowEvent(event: FollowEvent, _context: LineHandlerContext): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} followed`);
}

async function handleUnfollowEvent(
  event: UnfollowEvent,
  _context: LineHandlerContext,
): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}

async function handleJoinEvent(event: JoinEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handleLeaveEvent(event: LeaveEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handlePostbackEvent(
  event: PostbackEvent,
  context: LineHandlerContext,
): Promise<void> {
  const data = event.postback.data;
  logVerbose(`line: received postback: ${data}`);

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return;
  }

  const postbackContext = await buildLinePostbackContext({
    event,
    cfg: context.cfg,
    account: context.account,
    commandAuthorized: decision.commandAccess.authorized,
  });
  if (!postbackContext) {
    return;
  }

  await context.processMessage(postbackContext);
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  let firstError: unknown;
  for (const event of events) {
    const replayCandidate = getLineReplayCandidate(event, context);
    const replaySkip = replayCandidate ? await claimLineReplayEvent(replayCandidate) : null;
    if (replaySkip?.skip) {
      if (replaySkip.inFlightResult) {
        try {
          await replaySkip.inFlightResult;
        } catch (err) {
          context.runtime.error?.(danger(`line: replayed in-flight event failed: ${String(err)}`));
          firstError ??= err;
        }
      }
      continue;
    }
    try {
      switch (event.type) {
        case "message":
          await handleMessageEvent(event, context);
          break;
        case "follow":
          await handleFollowEvent(event, context);
          break;
        case "unfollow":
          await handleUnfollowEvent(event, context);
          break;
        case "join":
          await handleJoinEvent(event, context);
          break;
        case "leave":
          await handleLeaveEvent(event, context);
          break;
        case "postback":
          await handlePostbackEvent(event, context);
          break;
        default:
          logVerbose(`line: unhandled event type: ${(event as WebhookEvent).type}`);
      }
      if (replayCandidate) {
        await replayCandidate.cache.commit(replayCandidate.key);
      }
    } catch (err) {
      if (replayCandidate) {
        if (err instanceof LineRetryableWebhookError) {
          replayCandidate.cache.release(replayCandidate.key, { error: err });
        } else {
          await replayCandidate.cache.commit(replayCandidate.key);
        }
      }
      context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
      firstError ??= err;
    }
  }
  if (firstError) {
    throw toLintErrorObject(firstError, "Non-Error thrown");
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
