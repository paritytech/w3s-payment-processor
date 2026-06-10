/**
 * On-chain Z-report publish. Drives `publishZReport` with injected preimage +
 * `inHost`, mocking the chain write + read-back so the encryption → CID → write
 * → read-back-guard flow is exercised without a node. The contract-side
 * immutability is covered by the registry's own tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolkadotSigner } from "polkadot-api";

const writeContractMock = vi.fn();
const readContractMock = vi.fn();

vi.mock("@/shared/api/contracts/write-contract.ts", () => ({
  writeContract: (...args: unknown[]) => writeContractMock(...args),
}));
vi.mock("@/shared/api/contracts/read.ts", () => ({
  readContract: (...args: unknown[]) => readContractMock(...args),
}));
vi.mock("@/shared/api/client.ts", () => ({ mainChainClient: () => ({}) }));
vi.mock("@/shared/api/host/host-api.ts", () => ({ preimageManager: { submit: vi.fn() } }));

import { publishZReport, ReportConflictError } from "@/features/reports/api/report-storage.ts";
import { calculateBulletinCidObject } from "@/shared/utils/wire/cid.ts";
import type { ZReportRecord } from "@/features/v1/types.ts";
import { decryptCredentialEnvelope } from "@/shared/utils/wire/credential-envelope.ts";
import { formatPlanck } from "@/shared/utils/format.ts";
import { envConfig } from "@/config.ts";

const RECORD: ZReportRecord = {
  seq: 7,
  fromBlock: 1,
  toBlock: 100,
  lines: [{ terminalId: "t1", payoutHex: `0x${"a".repeat(64)}`, totalPlanck: "3000", count: 2 }],
  grandTotalPlanck: "3000",
  count: 2,
  payments: [
    { paymentId: "0xb1:x0:0xaa", terminalId: "t1", amountPlanck: "1000", blockNumber: 5, observedAtMs: 50 },
    { paymentId: "0xb2:x1:0xaa", terminalId: "t1", amountPlanck: "2000", blockNumber: 9, observedAtMs: 90, fromHex: `0x${"b".repeat(64)}` },
  ],
  committedAtMs: 123,
  source: "v1",
  publishState: "pending",
};

const SIGNER = {
  publicKey: new Uint8Array(32),
  signTx: vi.fn(),
  signBytes: vi.fn(),
} as unknown as PolkadotSigner;

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

/** Preimage stub that returns blake2b-256(bytes) — the host's honest behaviour. */
function honestPreimage() {
  return {
    submit: async (bytes: Uint8Array): Promise<`0x${string}`> =>
      bytesToHex(calculateBulletinCidObject(bytes).multihash.digest),
  };
}

/** Queue one pre-check read answering "slot is empty" (the normal first read). */
function mockEmptySlot() {
  readContractMock.mockResolvedValueOnce([{ seq: 0n, cid: "", size: 0, committedAt: 0n, exists: false }]);
}

beforeEach(() => {
  writeContractMock.mockReset();
  readContractMock.mockReset();
});

describe("publishZReport", () => {
  it("publishes and returns the cid when the read-back matches our upload", async () => {
    mockEmptySlot();
    // The write captures the cid arg, then the read-back returns that same cid.
    writeContractMock.mockImplementation(async (_client: unknown, opts: { args: readonly unknown[] }) => {
      const [groupId, seq, cid, size] = opts.args;
      readContractMock.mockResolvedValueOnce([{ seq, cid, size, committedAt: 1n, exists: true }]);
      expect(groupId).toBe("funkhaus-zola");
      expect(seq).toBe(7n);
      return "0xhash";
    });

    const result = await publishZReport({
      groupId: "funkhaus-zola",
      record: RECORD,
      passkey: "pw",
      signer: SIGNER,
      walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      preimage: honestPreimage(),
      inHost: () => true,
    });

    expect(writeContractMock).toHaveBeenCalledTimes(1);
    const opts = writeContractMock.mock.calls[0]![1] as { functionName: string; args: readonly unknown[] };
    expect(opts.functionName).toBe("addProcessorReport");
    expect(result.cid).toMatch(/^bafk/);
    expect(result.size).toBeGreaterThan(0);
  });

  it("uploads an encrypted ProcessorReportDoc that decrypts with the group passkey", async () => {
    let uploaded: Uint8Array | undefined;
    const preimage = {
      submit: async (bytes: Uint8Array): Promise<`0x${string}`> => {
        uploaded = bytes;
        return bytesToHex(calculateBulletinCidObject(bytes).multihash.digest);
      },
    };
    mockEmptySlot();
    writeContractMock.mockImplementation(async (_client: unknown, opts: { args: readonly unknown[] }) => {
      const [, seq, cid, size] = opts.args;
      readContractMock.mockResolvedValueOnce([{ seq, cid, size, committedAt: 1n, exists: true }]);
      return "0xhash";
    });

    await publishZReport({
      groupId: "funkhaus-zola",
      record: RECORD,
      passkey: "pw",
      signer: SIGNER,
      walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      preimage,
      inHost: () => true,
    });

    // The uploaded bytes are the JSON envelope; the plaintext under it must be
    // the versioned report doc — this is the admin-side compatibility proof.
    const envelope = JSON.parse(new TextDecoder().decode(uploaded!)) as unknown;
    const plaintext = await decryptCredentialEnvelope(envelope, "pw");
    const doc = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    expect(doc.format).toBe("w3s-processor-report");
    expect(doc.version).toBe(1);
    expect(doc.kind).toBe("z");
    expect(doc.groupId).toBe("funkhaus-zola");
    expect(doc.seq).toBe(7);
    expect(doc.generatedAtMs).toBe(RECORD.committedAtMs);
    expect(doc.payments).toEqual(
      RECORD.payments.map((p) => ({ ...p, amount: formatPlanck(BigInt(p.amountPlanck), envConfig.token.decimals) })),
    );
    // Local-only lifecycle fields must not be in the published bytes.
    expect("publishState" in doc).toBe(false);
    expect("committedAtMs" in doc).toBe(false);
  });

  it("throws ReportConflictError when the slot holds a foreign cid, without writing", async () => {
    readContractMock.mockResolvedValue([
      { seq: 7n, cid: "bafkSomeoneElsesCid", size: 99, committedAt: 1n, exists: true },
    ]);

    await expect(
      publishZReport({
        groupId: "funkhaus-zola",
        record: RECORD,
        passkey: "pw",
        signer: SIGNER,
        walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        preimage: honestPreimage(),
        inHost: () => true,
      }),
    ).rejects.toBeInstanceOf(ReportConflictError);
    expect(writeContractMock).not.toHaveBeenCalled();
  });

  it("recognizes a landed previous attempt via lastAttemptCid and skips re-upload", async () => {
    readContractMock.mockResolvedValueOnce([
      { seq: 7n, cid: "bafkPreviousAttempt", size: 321, committedAt: 1n, exists: true },
    ]);
    let submitted = false;
    const result = await publishZReport({
      groupId: "funkhaus-zola",
      record: RECORD,
      passkey: "pw",
      signer: SIGNER,
      walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      lastAttemptCid: "bafkPreviousAttempt",
      preimage: {
        submit: async (): Promise<`0x${string}`> => {
          submitted = true;
          return "0x";
        },
      },
      inHost: () => true,
    });
    expect(result).toEqual({ cid: "bafkPreviousAttempt", size: 321 });
    expect(submitted).toBe(false);
    expect(writeContractMock).not.toHaveBeenCalled();
  });

  it("persists the attempt cid before the write and hands the watcher a slot oracle", async () => {
    mockEmptySlot();
    const order: string[] = [];
    let attemptCid: string | undefined;
    writeContractMock.mockImplementation(async (_client: unknown, opts: { args: readonly unknown[] }) => {
      order.push("write");
      const [, seq, cid, size] = opts.args;
      readContractMock.mockResolvedValue([{ seq, cid, size, committedAt: 1n, exists: true }]);
      return "0xhash";
    });

    const result = await publishZReport({
      groupId: "funkhaus-zola",
      record: RECORD,
      passkey: "pw",
      signer: SIGNER,
      walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      onPreimageUploaded: (cid) => {
        order.push("persist-attempt");
        attemptCid = cid;
      },
      preimage: honestPreimage(),
      inHost: () => true,
    });

    expect(order).toEqual(["persist-attempt", "write"]);
    expect(attemptCid).toBe(result.cid);

    // The oracle reads the slot and matches only our cid.
    const opts = writeContractMock.mock.calls[0]![1] as {
      waitForChainEffect: () => Promise<boolean>;
    };
    await expect(opts.waitForChainEffect()).resolves.toBe(true);
  });

  it("aborts before any upload when run outside a host", async () => {
    let submitted = false;
    const preimage = {
      submit: async (): Promise<`0x${string}`> => {
        submitted = true;
        return "0x";
      },
    };
    await expect(
      publishZReport({
        groupId: "g",
        record: RECORD,
        passkey: "pw",
        signer: SIGNER,
        walletAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        preimage,
        inHost: () => false,
      }),
    ).rejects.toThrow(/host/i);
    expect(submitted).toBe(false);
    expect(writeContractMock).not.toHaveBeenCalled();
  });
});
