import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/shared/api/host/host-api.ts", () => ({
  preimageManager: { lookup: () => ({ unsubscribe() {} }) },
  hostLocalStorage: {},
}));

import {
  fetchBulletinPreimage,
  type PreimageLookup,
} from "@/shared/api/host/bulletin-content.ts";
import { calculateBulletinCidObject } from "@/shared/utils/wire/cid.ts";

const BYTES = new TextEncoder().encode("hello bulletin");
const CID_OBJ = calculateBulletinCidObject(BYTES);
const CID = CID_OBJ.toString();

function hex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const EXPECTED_KEY = hex(CID_OBJ.multihash.digest);

/**
 * Build a lookup stub. `mode` controls how the host delivers the payload:
 * the value(s) the host emits through the subscription callback.
 */
function lookupStub(
  emit: (cb: (preimage: Uint8Array | null) => void) => void,
): { lookup: PreimageLookup; unsubscribe: Mock; keys: string[] } {
  const unsubscribe = vi.fn();
  const keys: string[] = [];
  const lookup: PreimageLookup = {
    lookup(key, cb) {
      keys.push(key);
      emit(cb);
      return { unsubscribe };
    },
  };
  return { lookup, unsubscribe, keys };
}

const inHost = () => true;

describe("fetchBulletinPreimage", () => {
  it("returns no-host without touching the transport when not in a host", async () => {
    const stub = lookupStub(() => {
      throw new Error("lookup must not run outside a host");
    });
    const result = await fetchBulletinPreimage(CID, { inHost: () => false, preimage: stub.lookup });
    expect(result).toEqual({ kind: "no-host" });
    expect(stub.keys).toHaveLength(0);
  });

  it("looks up the CID multihash digest and returns the verified bytes", async () => {
    const stub = lookupStub((cb) => cb(BYTES));
    const result = await fetchBulletinPreimage(CID, { inHost, preimage: stub.lookup });
    expect(result).toEqual({ kind: "ok", bytes: BYTES });
    expect(stub.keys).toEqual([EXPECTED_KEY]);
    expect(stub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores leading null payloads and resolves on the first real one", async () => {
    const stub = lookupStub((cb) => {
      cb(null);
      cb(null);
      cb(BYTES);
    });
    const result = await fetchBulletinPreimage(CID, { inHost, preimage: stub.lookup });
    expect(result).toEqual({ kind: "ok", bytes: BYTES });
    expect(stub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects a payload that fails the content-address integrity check", async () => {
    const wrong = new TextEncoder().encode("tampered");
    const stub = lookupStub((cb) => cb(wrong));
    const result = await fetchBulletinPreimage(CID, { inHost, preimage: stub.lookup });
    expect(result).toEqual({
      kind: "unavailable",
      reason: "host preimage failed the content-address integrity check",
    });
    expect(stub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("times out to unavailable when the host never delivers", async () => {
    const stub = lookupStub((cb) => cb(null));
    const result = await fetchBulletinPreimage(CID, {
      inHost,
      preimage: stub.lookup,
      timeoutMs: 5,
    });
    expect(result).toEqual({ kind: "unavailable", reason: "preimage lookup timed out" });
    expect(stub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable for a malformed CID without subscribing", async () => {
    const stub = lookupStub(() => {
      throw new Error("must not subscribe for a bad CID");
    });
    const result = await fetchBulletinPreimage("not-a-cid", { inHost, preimage: stub.lookup });
    expect(result.kind).toBe("unavailable");
    expect(stub.keys).toHaveLength(0);
  });

  it("returns unavailable for an already-aborted signal", async () => {
    const stub = lookupStub((cb) => cb(BYTES));
    const result = await fetchBulletinPreimage(CID, {
      inHost,
      preimage: stub.lookup,
      signal: AbortSignal.abort(),
    });
    expect(result).toEqual({ kind: "unavailable", reason: "aborted" });
  });
});
