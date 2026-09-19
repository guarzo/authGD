import { describe, expect, it } from "vitest";
import {
  AutomaticCommandSchema,
  AutomaticOffSchema,
  AutomaticReceiptSchema,
  AutomaticResultSchema,
  AutomaticStatusSchema,
  BrowserAutomaticViewSchema,
  BrowserOffReplySchema,
  ConsentSchema,
  SourceStopReceiptSchema,
  SourceViewSchema,
  SourcesGetSchema,
  parseAutomaticResult,
  parseBrowserOffReply,
  parseReceiptGet,
  parseSourceStartResult,
  parseSourceStopResult,
  type AutomaticCommand,
  type AutomaticResult,
  type AutomaticStatus,
  type BrowserOffReply,
  type Consent,
  type SourceStart,
  type SourceStop,
  type SourceStopResult,
} from "@/core/fleet-automatic";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";

const device = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
const sourceId = "11111111-1111-1111-8111-111111111111";
const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-09-07T12:00:00.000Z";
const expires = "2026-09-08T12:00:00.000Z";
const command: AutomaticCommand = {
  protocol: 2,
  request_id: requestId,
  intent_created_at: now,
  enabled: false,
  expected_generation: 7,
  expected_revision: 8,
};
const status: AutomaticStatus = {
  consent: {
    generation: 7,
    revision: 9,
    enabled: false,
    approving_device_id: device,
    approved_at: "2026-09-07T11:00:00.000Z",
    disabled_at: now,
    closed_reason: "explicit_off",
  },
  approver: "this_device",
  readiness: "off",
  recovery_action: "none",
  retry_at: null,
  sources: [],
};
const result: AutomaticResult = {
  protocol: 2,
  request_id: requestId,
  result: "applied",
  receipt: {
    kind: "automatic",
    command,
    accepted_at: now,
    expires_at: expires,
    result: status.consent,
  },
  status,
};
const stop: SourceStop = {
  protocol: 2,
  operation: "stop",
  request_id: requestId,
  intent_created_at: now,
  source_id: sourceId,
  expected_generation: 1,
  expected_automatic: { consent_generation: 7 },
};
const stopped: SourceStopResult = {
  protocol: 2,
  request_id: requestId,
  result: "applied",
  source: {
    source_id: sourceId,
    generation: 2,
    character_id: 42,
    state: "ended",
    reason: "stopped",
    pending_expires_at: null,
    automatic: { consent_generation: 7 },
  },
  automatic_effect: "disabled_current",
  status,
  receipt: null,
};
stopped.receipt = {
  kind: "source_stop",
  command: stop,
  accepted_at: now,
  expires_at: expires,
  source: stopped.source,
  automatic_effect: stopped.automatic_effect,
  consent: status.consent,
};
const parse = safeParseFleetV2Dto;

describe("closed control values", () => {
  it("distinguishes exact virtual Off from attributed positive consent", () => {
    const absent = {
      generation: 0,
      revision: 0,
      enabled: false,
      approving_device_id: null,
      approved_at: null,
      disabled_at: null,
      closed_reason: null,
    };
    expect(parse(ConsentSchema, absent).success).toBe(true);
    for (const patch of [{ revision: 1 }, { enabled: true }, { approved_at: now }])
      expect(parse(ConsentSchema, { ...absent, ...patch }).success).toBe(false);
    expect(parse(ConsentSchema, status.consent).success).toBe(true);
    for (const patch of [
      { revision: 6 },
      { approving_device_id: null },
      { disabled_at: null },
      { disabled_at: "2026-09-07T10:00:00.000Z" },
      { closed_reason: null },
    ])
      expect(parse(ConsentSchema, { ...status.consent, ...patch }).success).toBe(false);
  });
  it("keeps exhaustion admission separate from shape and rejects impossible receipt arithmetic", () => {
    expect(
      parse(AutomaticCommandSchema, {
        ...command,
        enabled: true,
        expected_generation: Number.MAX_SAFE_INTEGER,
        expected_revision: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    const receipt = result.receipt!;
    expect(parse(AutomaticReceiptSchema, receipt).success).toBe(true);
    expect(
      parse(AutomaticReceiptSchema, {
        ...receipt,
        command: { ...command, expected_revision: Number.MAX_SAFE_INTEGER },
      }).success,
    ).toBe(false);
    expect(
      parse(AutomaticReceiptSchema, {
        ...receipt,
        expires_at: "2026-09-08T12:00:00.001Z",
      }).success,
    ).toBe(false);
    expect(
      parse(AutomaticReceiptSchema, {
        ...receipt,
        accepted_at: "9999-12-31T00:00:00.000Z",
        expires_at: "9999-12-31T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
  it("checks historical admission time but never ages durable Off like On or Stop", () => {
    const receipt = result.receipt!;
    expect(
      parse(AutomaticReceiptSchema, {
        ...receipt,
        command: { ...command, intent_created_at: "2026-01-01T00:00:00.000Z" },
      }).success,
    ).toBe(true);
    expect(
      parse(AutomaticReceiptSchema, {
        ...receipt,
        command: { ...command, intent_created_at: "2026-09-07T12:00:00.001Z" },
      }).success,
    ).toBe(false);
    expect(
      parse(SourceStopReceiptSchema, {
        ...stopped.receipt,
        command: { ...stop, intent_created_at: "2026-09-07T11:59:00.000Z" },
      }).success,
    ).toBe(false);
    expect(
      parse(SourceStopReceiptSchema, {
        ...stopped.receipt,
        command: { ...stop, intent_created_at: "2026-09-07T11:59:00.001Z" },
      }).success,
    ).toBe(true);
  });
  it("rejects forbidden own keys at every structured browser boundary without erasing them", () => {
    expect(parse(AutomaticOffSchema, command).success).toBe(true);
    for (const patch of [
      { enabled: true },
      { accountId: device },
      { sessionId: "secret" },
      { expected_revision: true },
    ])
      expect(parse(AutomaticOffSchema, { ...command, ...patch }).success).toBe(false);
    const poisoned = structuredClone(command);
    Object.defineProperty(poisoned, "__proto__", {
      value: "untrusted",
      enumerable: true,
    });
    expect(parse(AutomaticOffSchema, poisoned).success).toBe(false);
    expect(parseAutomaticResult(result, poisoned).success).toBe(false);
    expect(Object.hasOwn(poisoned, "__proto__")).toBe(true);
  });
  it("requires canonical bounded sorted unique catalogues and exact source state/expiry pairs", () => {
    const source = stopped.source;
    expect(parse(SourceViewSchema, source).success).toBe(true);
    for (const patch of [
      { reason: null },
      { pending_expires_at: now },
      { automatic: { consent_generation: 0 } },
    ])
      expect(parse(SourceViewSchema, { ...source, ...patch }).success).toBe(false);
    expect(
      parse(SourcesGetSchema, { protocol: 2, sources: [source], characters: [] }).success,
    ).toBe(true);
    expect(
      parse(SourcesGetSchema, { protocol: 2, sources: [source, source], characters: [] })
        .success,
    ).toBe(false);
    expect(
      parse(SourcesGetSchema, {
        protocol: 2,
        sources: [{ ...source, source_id: device }, source],
        characters: [],
      }).success,
    ).toBe(false);
    expect(
      parse(SourcesGetSchema, {
        protocol: 2,
        sources: [],
        characters: [
          {
            character_id: 42,
            character_name: "\u0000",
            character_link_epoch: device,
            has_fleet_read: false,
            token_usable: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("validates readiness action precedence without manufacturing proof from DTO source counts", () => {
    expect(parse(AutomaticStatusSchema, status).success).toBe(true);
    for (const patch of [
      { readiness: "ready" },
      { recovery_action: "wait" },
      { retry_at: now },
      { approver: "none" },
    ])
      expect(parse(AutomaticStatusSchema, { ...status, ...patch }).success).toBe(false);
    const enabled = {
      ...status,
      consent: {
        ...status.consent,
        enabled: true,
        disabled_at: null,
        closed_reason: null,
      },
      approver: "revoked",
      readiness: "authorization_required",
      recovery_action: "reauthorize_automatic",
    };
    expect(parse(AutomaticStatusSchema, enabled).success).toBe(true);
    expect(parse(AutomaticStatusSchema, { ...enabled, retry_at: now }).success).toBe(
      false,
    );
    expect(
      parse(AutomaticStatusSchema, {
        ...enabled,
        readiness: "ready",
        recovery_action: "none",
      }).success,
    ).toBe(false);
    expect(
      parse(AutomaticStatusSchema, {
        ...enabled,
        readiness: "global_disabled",
        recovery_action: "wait",
      }).success,
    ).toBe(true);
  });
});

// Independent regression data, never replacements for approved wire vectors.
function manualStopReceipt(consent: Consent) {
  return {
    ...stopped.receipt!,
    command: { ...stop, expected_automatic: null },
    source: { ...stopped.source, automatic: null },
    automatic_effect: "manual_only" as const,
    consent,
  };
}
const historicalOff = status.consent;
const historicalOn: Consent = {
  ...historicalOff,
  revision: 8,
  enabled: true,
  disabled_at: null,
  closed_reason: null,
};

it.each([
  {
    name: "On with terminal reserve",
    enabled: true,
    revision: 9007199254740990,
    accept: true,
  },
  {
    name: "On without terminal reserve",
    enabled: true,
    revision: 9007199254740991,
    accept: false,
  },
  {
    name: "terminal Off at maximum",
    enabled: false,
    revision: 9007199254740991,
    accept: true,
  },
])(
  "reserved Off slot: $name in consent and inline receipt DTOs",
  ({ enabled, revision, accept }) => {
    const consent = { ...(enabled ? historicalOn : historicalOff), revision };
    expect(parse(ConsentSchema, consent).success).toBe(accept);
    expect(parse(SourceStopReceiptSchema, manualStopReceipt(consent)).success).toBe(
      accept,
    );
    // Commands remain syntactically valid at Gmax: runtime admission owns refusal.
    expect(
      parse(AutomaticCommandSchema, {
        ...command,
        enabled,
        expected_generation: 9007199254740991,
        expected_revision: 9007199254740991,
      }).success,
    ).toBe(true);
  },
);

const consentObservations: {
  name: string;
  historical: Consent;
  current: Consent;
  accept: boolean;
}[] = [
  {
    name: "unchanged Off",
    historical: historicalOff,
    current: historicalOff,
    accept: true,
  },
  {
    name: "unchanged Off UUID spelling",
    historical: historicalOff,
    current: { ...historicalOff, approving_device_id: device.toUpperCase() },
    accept: true,
  },
  {
    name: "Off no-op cannot grow revision",
    historical: historicalOff,
    current: { ...historicalOff, revision: 10 },
    accept: false,
  },
  {
    name: "Off revision gap",
    historical: historicalOff,
    current: { ...historicalOff, revision: 12 },
    accept: false,
  },
  {
    name: "Off cannot acquire later revocation",
    historical: historicalOff,
    current: { ...historicalOff, revision: 10, closed_reason: "approver_revoked" },
    accept: false,
  },
  {
    name: "Off cannot reauthorize same generation",
    historical: historicalOff,
    current: { ...historicalOn, revision: 10 },
    accept: false,
  },
  { name: "unchanged On", historical: historicalOn, current: historicalOn, accept: true },
  {
    name: "On cannot grow revision while On",
    historical: historicalOn,
    current: { ...historicalOn, revision: 9 },
    accept: false,
  },
  {
    name: "On single explicit Off",
    historical: historicalOn,
    current: historicalOff,
    accept: true,
  },
  {
    name: "On single source Stop",
    historical: historicalOn,
    current: { ...historicalOff, closed_reason: "source_stop" },
    accept: true,
  },
  {
    name: "On single revocation",
    historical: historicalOn,
    current: { ...historicalOff, closed_reason: "approver_revoked" },
    accept: true,
  },
  {
    name: "On terminal Off may occur after receipt acceptance",
    historical: historicalOn,
    current: { ...historicalOff, disabled_at: "2026-09-09T12:00:00.000Z" },
    accept: true,
  },
  {
    name: "On terminal revision gap",
    historical: historicalOn,
    current: { ...historicalOff, revision: 10 },
    accept: false,
  },
  {
    name: "On revocation revision gap",
    historical: historicalOn,
    current: { ...historicalOff, revision: 11, closed_reason: "approver_revoked" },
    accept: false,
  },
  {
    name: "On terminal revision must advance",
    historical: historicalOn,
    current: { ...historicalOff, revision: 8 },
    accept: false,
  },
  {
    name: "terminal transition preserves approver",
    historical: historicalOn,
    current: { ...historicalOff, approving_device_id: requestId },
    accept: false,
  },
  {
    name: "terminal transition preserves approval time",
    historical: historicalOn,
    current: { ...historicalOff, approved_at: "2026-09-07T11:01:00.000Z" },
    accept: false,
  },
  {
    name: "terminal transition requires canonical time",
    historical: historicalOn,
    current: { ...historicalOff, disabled_at: "2026-09-07T12:00:00Z" },
    accept: false,
  },
  {
    name: "terminal transition cannot predate approval",
    historical: historicalOn,
    current: { ...historicalOff, disabled_at: "2026-09-07T10:00:00.000Z" },
    accept: false,
  },
  {
    name: "last reserved terminal revision",
    historical: { ...historicalOn, revision: 9007199254740990 },
    current: { ...historicalOff, revision: 9007199254740991 },
    accept: true,
  },
  {
    name: "On to replacement-device newer On",
    historical: historicalOn,
    current: {
      ...historicalOn,
      generation: 8,
      revision: 9,
      approving_device_id: requestId,
      approved_at: "2026-09-07T12:01:00.000Z",
    },
    accept: true,
  },
  {
    name: "Off to replacement-device newer On",
    historical: historicalOff,
    current: {
      ...historicalOn,
      generation: 8,
      revision: 10,
      approving_device_id: requestId,
      approved_at: "2026-09-07T12:01:00.000Z",
    },
    accept: true,
  },
  {
    name: "newer generation may span unseen transitions",
    historical: historicalOff,
    current: {
      ...historicalOff,
      generation: 9,
      revision: 13,
      approving_device_id: requestId,
      approved_at: "2026-09-07T12:01:00.000Z",
      disabled_at: "2026-09-09T12:00:00.000Z",
    },
    accept: true,
  },
];
it.each(consentObservations)(
  "receipt transition: $name",
  ({ historical, current, accept }) => {
    const currentStatus: AutomaticStatus = {
      ...status,
      consent: current,
      approver: current.closed_reason === "approver_revoked" ? "revoked" : "this_device",
      readiness: current.enabled ? "waiting_for_fleet" : "off",
    };
    const receipt = manualStopReceipt(historical);
    expect(
      parseReceiptGet({ protocol: 2, receipt, status: currentStatus }, requestId).success,
    ).toBe(accept);
    expect(
      parseSourceStopResult(
        {
          ...stopped,
          result: "replayed",
          receipt,
          source: receipt.source,
          automatic_effect: receipt.automatic_effect,
          status: currentStatus,
        },
        receipt.command,
      ).success,
    ).toBe(accept);
    const automatic = {
      ...result.receipt!,
      result: historical,
      command: {
        ...command,
        enabled: historical.enabled,
        expected_generation: historical.enabled
          ? historical.generation - 1
          : historical.generation,
        expected_revision: historical.revision - 1,
      },
    };
    expect(
      parseAutomaticResult(
        { ...result, result: "replayed", receipt: automatic, status: currentStatus },
        automatic.command,
      ).success,
    ).toBe(accept);
    if (!historical.enabled) {
      expect(
        parseBrowserOffReply(
          {
            ok: true,
            request_id: requestId,
            result: "replayed",
            receipt: automatic,
            status: { ...currentStatus, approver: "account_device" },
          },
          automatic.command,
        ).success,
      ).toBe(accept);
    }
  },
);

describe("production command and receipt correlation", () => {
  it("matches all command fields, retains UUID spellings and never rebases no-op CAS", () => {
    expect(parseAutomaticResult(result, command).success).toBe(true);
    for (const patch of [
      { request_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { expected_generation: 6 },
      { expected_revision: 7 },
      { enabled: true },
      { intent_created_at: "2026-09-06T12:00:00.000Z" },
    ])
      expect(parseAutomaticResult(result, { ...command, ...patch }).success).toBe(false);
    const noop = { ...result, result: "already_off", receipt: null };
    expect(parseAutomaticResult(noop, { ...command, expected_revision: 9 }).success).toBe(
      true,
    );
    expect(parseAutomaticResult(noop, command).success).toBe(false);
    expect(
      parseAutomaticResult(noop, { ...command, enabled: true, expected_revision: 9 })
        .success,
    ).toBe(false);
  });
  it("allows historical receipts with newer current On, but not contradictory equal revisions", () => {
    const future = {
      ...status,
      consent: {
        ...status.consent,
        generation: 8,
        revision: 10,
        enabled: true,
        disabled_at: null,
        closed_reason: null,
      },
      readiness: "waiting_for_fleet",
    };
    expect(
      parseAutomaticResult({ ...result, result: "replayed", status: future }, command)
        .success,
    ).toBe(true);
    expect(
      parse(AutomaticResultSchema, {
        ...result,
        status: {
          ...status,
          consent: { ...status.consent, approving_device_id: device.toUpperCase() },
        },
      }).success,
    ).toBe(true);
    expect(
      parse(AutomaticResultSchema, {
        ...result,
        status: { ...status, consent: { ...status.consent, generation: 8 } },
      }).success,
    ).toBe(false);
    expect(
      parse(AutomaticResultSchema, {
        ...result,
        status: { ...status, consent: { ...status.consent, revision: 8 } },
      }).success,
    ).toBe(false);
  });
  it("correlates receipt GET's canonical selector as well as the complete original command", () => {
    const get = { protocol: 2, receipt: result.receipt, status };
    expect(parseReceiptGet(get, requestId).success).toBe(true);
    expect(parseReceiptGet(get, "cccccccc-cccc-4ccc-8ccc-cccccccccccc").success).toBe(
      false,
    );
    expect(parseReceiptGet(get, requestId.toUpperCase()).success).toBe(false);
    expect(parseReceiptGet(get, requestId, command).success).toBe(true);
    expect(parseReceiptGet(get, requestId, stop).success).toBe(false);
  });
  it("correlates manual Start identity/character without forcing ExistingUuid to v4", () => {
    const start: SourceStart = {
      protocol: 2,
      operation: "start",
      source_id: sourceId,
      expected_generation: 0,
      character_id: 42,
      character_link_epoch: device,
      intent_created_at: now,
    };
    const response = { protocol: 2, source: { ...stopped.source, automatic: null } };
    expect(parseSourceStartResult(response, start).success).toBe(true);
    expect(parseSourceStartResult(response, { ...start, character_id: 43 }).success).toBe(
      false,
    );
    expect(
      parseSourceStartResult(response, { ...start, source_id: device }).success,
    ).toBe(false);
    expect(
      parseSourceStartResult({ protocol: 2, source: stopped.source }, start).success,
    ).toBe(false);
  });
  it("checks Stop immutable bindings and all receipt fields, then uses exact CAS for no-op", () => {
    expect(parseSourceStopResult(stopped, stop).success).toBe(true);
    expect(
      parseSourceStopResult(stopped, { ...stop, expected_generation: 2 }).success,
    ).toBe(false);
    expect(
      parseSourceStopResult(stopped, { ...stop, expected_automatic: null }).success,
    ).toBe(false);
    expect(
      parseSourceStopResult(
        { ...stopped, source: { ...stopped.source, reason: "expired" } },
        stop,
      ).success,
    ).toBe(false);
    const noop = {
      ...stopped,
      result: "already_stopped",
      receipt: null,
      automatic_effect: "current_already_off",
    };
    expect(parseSourceStopResult(noop, { ...stop, expected_generation: 2 }).success).toBe(
      true,
    );
    expect(parseSourceStopResult(noop, stop).success).toBe(false);
    expect(
      parseSourceStopResult(
        { ...noop, automatic_effect: "disabled_current" },
        { ...stop, expected_generation: 2 },
      ).success,
    ).toBe(false);
    const caseResponse = {
      ...stopped,
      source: { ...stopped.source, source_id: device.toUpperCase() },
      receipt: {
        ...stopped.receipt!,
        source: { ...stopped.source, source_id: device },
        command: { ...stop, source_id: device },
      },
    };
    const parsed = parseSourceStopResult(caseResponse, {
      ...stop,
      source_id: device.toUpperCase(),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.source.source_id).toBe(device.toUpperCase());
  });
  it("closes browser reply errors, Off-only receipt correlation and account-device presentation", () => {
    const browserStatus = { ...status, approver: "account_device" as const };
    const reply: BrowserOffReply = {
      ok: true,
      request_id: requestId,
      result: "applied",
      receipt: result.receipt,
      status: browserStatus,
    };
    expect(parse(BrowserAutomaticViewSchema, browserStatus).success).toBe(true);
    expect(parse(BrowserAutomaticViewSchema, status).success).toBe(false);
    expect(parseBrowserOffReply(reply, command).success).toBe(true);
    expect(parseBrowserOffReply(reply, { ...command, enabled: true }).success).toBe(
      false,
    );
    expect(
      parseBrowserOffReply(reply, { ...command, expected_revision: 7 }).success,
    ).toBe(false);
    expect(
      parse(BrowserOffReplySchema, {
        ok: false,
        request_id: null,
        error: "bad_request",
        status: null,
      }).success,
    ).toBe(true);
    expect(
      parse(BrowserOffReplySchema, {
        ok: false,
        request_id: requestId,
        error: "conflict",
        status: browserStatus,
      }).success,
    ).toBe(true);
    expect(
      parse(BrowserOffReplySchema, {
        ok: false,
        request_id: requestId,
        error: "unauthorized",
        status: browserStatus,
      }).success,
    ).toBe(false);
    expect(
      parse(BrowserOffReplySchema, {
        ok: false,
        request_id: requestId,
        error: "bad_request",
        status: null,
      }).success,
    ).toBe(false);
    expect(parse(BrowserOffReplySchema, { ...reply, error: "conflict" }).success).toBe(
      false,
    );
  });
});
