import { afterEach, describe, expect, it } from "vitest";
import { truncateAddress, registerSecret, _clearSecretsForTest, scrubEvent, scrubTransaction } from "@/shared/utils/telemetry/scrub";
afterEach(() => _clearSecretsForTest());
describe("truncateAddress", () => {
  it("truncates >8 chars", () => { expect(truncateAddress("5GrwvaEF5zXb26Fz9rcQ")).toBe("5GrwvaEF…"); });
  it("passes short/falsy", () => { expect(truncateAddress("5Grwva")).toBe("5Grwva"); expect(truncateAddress(undefined)).toBeUndefined(); });
});
describe("scrubEvent", () => {
  it("redacts registered secret in message/exception/breadcrumb/extra; truncates address keys; redacts sensitive keys", () => {
    registerSecret("S3CR3T-cheque-plaintext-aaaaaaaaaa");
    const ev = { message: "leak S3CR3T-cheque-plaintext-aaaaaaaaaa",
      exception: { values: [{ value: "threw S3CR3T-cheque-plaintext-aaaaaaaaaa" }] },
      breadcrumbs: [{ message: "x", data: { decryptionKey: "zzz", payoutAddress: "5GrwvaEF5zXb26Fz" } }],
      extra: { credential: "secret-cred-here", note: "has S3CR3T-cheque-plaintext-aaaaaaaaaa" } } as any;
    const o = scrubEvent(ev) as any;
    expect(o.message).toContain("[redacted]"); expect(o.message).not.toContain("S3CR3T");
    expect(o.exception.values[0].value).not.toContain("S3CR3T");
    expect(o.breadcrumbs[0].data.decryptionKey).toBe("[redacted]");
    expect(o.breadcrumbs[0].data.payoutAddress).toBe("5GrwvaEF…");
    expect(o.extra.credential).toBe("[redacted]");
    expect(o.extra.note).not.toContain("S3CR3T");
  });
});
describe("scrubTransaction", () => {
  it("scrubs span data + trace.data", () => {
    const ev = { spans: [{ data: { "claim.note": "n", "signer.address": "5GrwvaEF5zXb26" } }],
      contexts: { trace: { data: { decryptionKey: "k", "payment.amount": "12.50" } } } } as any;
    const o = scrubTransaction(ev) as any;
    expect(o.spans[0].data["signer.address"]).toBe("5GrwvaEF…");
    expect(o.contexts.trace.data.decryptionKey).toBe("[redacted]");
    expect(o.contexts.trace.data["payment.amount"]).toBe("12.50");
  });
});
