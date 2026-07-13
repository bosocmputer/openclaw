// Tests for Agent Brain runtime helper safety.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAgentBrainToolEvidenceCapture,
  clearAgentBrainToolEvidenceForTests,
  recordAgentBrainToolEvidence,
} from "../../src/agents/agent-brain-tool-evidence.js";
import {
  appendAgentBrainAddendumToPayload,
  applyAgentBrainRuntimeContext,
  recordAgentBrainFinalPayload,
  submitAgentBrainTurnEvidence,
} from "./agent-brain-runtime.js";

const ORIGINAL_ENV = { ...process.env };

type TestRuntimeMessageContext = Record<string, unknown> & {
  Body?: string;
  BodyForAgent?: string;
  BodyForCommands?: string;
  RawBody?: string;
  CommandBody?: string;
};

function createCtx(overrides: Partial<TestRuntimeMessageContext> = {}): TestRuntimeMessageContext {
  return {
    Body: "LINE body",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: "line:user:u1",
    To: "line:user:u1",
    SessionKey: "agent:sale:line:direct:u1",
    AgentId: "sale",
    AccountId: "admin",
    ChatType: "direct",
    Provider: "line",
    Surface: "line",
    CommandAuthorized: false,
    CommandTurn: { kind: "none" },
    ...overrides,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

afterEach(() => {
  clearAgentBrainToolEvidenceForTests();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("applyAgentBrainRuntimeContext", () => {
  it("stays disabled unless explicitly enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await applyAgentBrainRuntimeContext({
      ctxPayload: createCtx(),
      agentId: "sale",
      channel: "line",
      accountId: "admin",
    });

    expect(result).toMatchObject({ attempted: false, applied: false, status: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Brain for control commands", async () => {
    process.env.AGENT_BRAIN_ENABLED = "1";
    process.env.API_TOKEN = "test-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await applyAgentBrainRuntimeContext({
      ctxPayload: createCtx({
        BodyForAgent: "/reset",
        BodyForCommands: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
      }),
      agentId: "sale",
      channel: "line",
      accountId: "admin",
    });

    expect(result).toMatchObject({ attempted: false, applied: false, status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects approved Brain context while preserving command text", async () => {
    process.env.AGENT_BRAIN_ENABLED = "1";
    process.env.API_TOKEN = "test-token";
    process.env.AGENT_BRAIN_API_URL = "http://brain.local/api";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        status: "ok",
        memoriesToInject: ["- โช๊ค = โช้คอัพ", "- แสดงรหัสสินค้าก่อนชื่อสินค้า"],
        injectedChars: 48,
        includedMemoryIds: ["mem_1"],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createCtx();

    const result = await applyAgentBrainRuntimeContext({
      ctxPayload: ctx,
      agentId: "sale",
      channel: "line",
      accountId: "admin",
    });

    expect(result).toMatchObject({
      attempted: true,
      applied: true,
      status: "ok",
      injectedChars: 48,
      includedMemoryIds: ["mem_1"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://brain.local/api/agent-brain/evaluate-turn",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
    expect(ctx.BodyForAgent).toContain("## Agent Knowledge Brain");
    expect(ctx.BodyForAgent).toContain("โช๊ค = โช้คอัพ");
    expect(ctx.AgentBrainOriginalUserText).toBe("hello");
    expect(ctx.BodyForCommands).toBe("hello");
  });
});

describe("appendAgentBrainAddendumToPayload", () => {
  it("appends staff-only description suggestions only to final text replies", () => {
    const result = {
      attempted: true,
      applied: false,
      status: "ok" as const,
      assistantAddendum: "คำแนะนำสำหรับ staff: เติมคำว่า โช้คอัพ ใน description",
    };

    expect(appendAgentBrainAddendumToPayload({ text: "ตอบหลัก" }, result, "tool")).toEqual({
      text: "ตอบหลัก",
    });
    expect(appendAgentBrainAddendumToPayload({ text: "ตอบหลัก" }, result, "final")).toEqual({
      text: "ตอบหลัก\n\nคำแนะนำสำหรับ staff: เติมคำว่า โช้คอัพ ใน description",
    });
    expect(
      appendAgentBrainAddendumToPayload({ text: "error", isError: true }, result, "final"),
    ).toEqual({ text: "error", isError: true });
  });
});

describe("submitAgentBrainTurnEvidence", () => {
  it("submits bounded structured tool evidence with secrets redacted", async () => {
    process.env.AGENT_BRAIN_ENABLED = "1";
    process.env.AGENT_BRAIN_V2_ENABLED = "1";
    process.env.API_TOKEN = "test-token";
    process.env.AGENT_BRAIN_API_URL = "http://brain.local";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ok" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    beginAgentBrainToolEvidenceCapture({ agentId: "sale", sessionKey: "session-1" });
    for (let index = 0; index < 25; index += 1) {
      recordAgentBrainToolEvidence({
        agentId: "sale",
        sessionKey: "session-1",
        event: {
          toolCallId: `call-${index}`,
          toolName: "sale__search_product",
          status: "ok",
          input: { keyword: "widget", authorization: "Bearer secret" },
          result: {
            schema_version: "search_product.v2",
            status: "resolved",
            selected: { code: "SKU-001" },
            apiKey: "secret",
          },
        },
      });
    }
    const result = {
      attempted: true,
      applied: false,
      status: "ok" as const,
      lookupId: "lookup-1",
      userUtterance: "widget",
    };

    await submitAgentBrainTurnEvidence({
      ctxPayload: createCtx({ MessageSid: "turn-structured" }),
      agentId: "sale",
      channel: "line",
      accountId: "admin",
      sessionKey: "session-1",
      result,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      toolEvents?: Array<Record<string, unknown>>;
    };
    expect(body.toolEvents).toHaveLength(20);
    expect(body.toolEvents?.[0]).toMatchObject({
      toolName: "sale__search_product",
      input: { keyword: "widget", authorization: "[redacted]" },
      result: { apiKey: "[redacted]" },
    });
  });

  it("posts final answer evidence after a turn without changing the reply payload", async () => {
    process.env.AGENT_BRAIN_ENABLED = "1";
    process.env.API_TOKEN = "test-token";
    process.env.AGENT_BRAIN_API_URL = "http://brain.local";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ok" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = {
      attempted: true,
      applied: false,
      status: "ok" as const,
    };

    const payload = { text: "รหัส A0101 ราคา 100 บาท", mediaUrls: ["https://example.test/a.jpg"] };
    recordAgentBrainFinalPayload(result, { text: "tool search selected A0101 ผ้าเบรค" }, "tool");
    recordAgentBrainFinalPayload(result, payload, "final");
    expect(result.finalText).toContain("รหัส A0101");
    expect(result.toolEvidence).toEqual(["tool search selected A0101 ผ้าเบรค"]);
    expect(payload.mediaUrls).toEqual(["https://example.test/a.jpg"]);

    await submitAgentBrainTurnEvidence({
      ctxPayload: createCtx({ MessageSid: "turn-1" }),
      agentId: "sale",
      channel: "telegram",
      accountId: "admin",
      result,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://brain.local/api/agent-brain/evaluate-turn",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"evidencePhase":"post_turn"'),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"finalText":"รหัส A0101 ราคา 100 บาท"');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain(
      '"toolEvidence":["tool search selected A0101 ผ้าเบรค"]',
    );
  });

  it("posts original user text instead of injected Brain context", async () => {
    process.env.AGENT_BRAIN_ENABLED = "1";
    process.env.API_TOKEN = "test-token";
    process.env.AGENT_BRAIN_API_URL = "http://brain.local";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "ok" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = {
      attempted: true,
      applied: true,
      status: "ok" as const,
    };
    recordAgentBrainFinalPayload(result, { text: "รับทราบครับ" }, "final");

    await submitAgentBrainTurnEvidence({
      ctxPayload: createCtx({
        MessageSid: "turn-2",
        AgentBrainOriginalUserText: "จำไว้ว่า ลูกปืนดุม แทน ดุมล้อ",
        BodyForAgent: "จำไว้ว่า ลูกปืนดุม แทน ดุมล้อ\n\n## Agent Knowledge Brain\n- [term] โช๊ค = โช้คอัพ",
        Body: "จำไว้ว่า ลูกปืนดุม แทน ดุมล้อ\n\n## Agent Knowledge Brain\n- [term] โช๊ค = โช้คอัพ",
      }),
      agentId: "stock",
      channel: "telegram",
      accountId: "stock",
      result,
    });

    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain('"userText":"จำไว้ว่า ลูกปืนดุม แทน ดุมล้อ"');
    expect(body).not.toContain("Agent Knowledge Brain");
  });
});
