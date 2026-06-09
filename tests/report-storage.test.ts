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

const RECORD: ZReportRecord = {
  seq: 7,
  fromBlock: 1,
  toBlock: 100,
  lines: [{ terminalId: "t1", payoutHex: `0x${"a".repeat(64)}`, totalPlanck: "3000", count: 2 }],
  grandTotalPlanck: "3000",
  count: 2,
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

beforeEach(() => {
  writeContractMock.mockReset();
  readContractMock.mockReset();
});

describe("publishZReport", () => {
  it("publishes and returns the cid when the read-back matches our upload", async () => {
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

  it("throws ReportConflictError when the on-chain cid was pre-empted by another writer", async () => {
    writeContractMock.mockResolvedValue("0xhash");
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
