import { afterEach, describe, expect, it, vi } from "vitest";

class FakeGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class FakeOscillator {
  type = "";
  frequency = { value: 0 };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  currentTime = 1;
  destination = { sink: true };
  oscillators: FakeOscillator[] = [];
  gains: FakeGainNode[] = [];
  resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillator {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }
}

function fakeDocument() {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
  };
}

async function freshChime() {
  vi.resetModules();
  return import("@/shared/utils/chime.ts");
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioContext.instances = [];
});

describe("playPaymentChime", () => {
  it("no-ops without an AudioContext implementation", async () => {
    const chime = await freshChime();
    expect(() => chime.playPaymentChime()).not.toThrow();
    expect(() => chime.armPaymentChime()).not.toThrow();
  });

  it("synthesizes a bounded bell routed to the destination on a running context", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const chime = await freshChime();

    chime.playPaymentChime();

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.oscillators.length).toBeGreaterThan(0);
    for (const osc of ctx.oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
      const startAt = osc.start.mock.calls[0]![0] as number;
      const stopAt = osc.stop.mock.calls[0]![0] as number;
      expect(stopAt).toBeGreaterThan(startAt);
    }
    const envelope = ctx.gains[0]!;
    expect(envelope.connect).toHaveBeenCalledWith(ctx.destination);
    expect(envelope.gain.exponentialRampToValueAtTime).toHaveBeenCalled();
  });

  it("reuses a single context across chimes", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const chime = await freshChime();

    chime.playPaymentChime();
    chime.playPaymentChime();

    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("drops the ding on a suspended context instead of queueing it, and nudges resume", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const chime = await freshChime();

    chime.playPaymentChime();
    const ctx = FakeAudioContext.instances[0]!;
    ctx.state = "suspended";
    ctx.resume.mockReturnValue(Promise.reject(new Error("needs gesture")));

    chime.playPaymentChime();

    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it("re-arms gesture unlock when it finds the context suspended", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const doc = fakeDocument();
    vi.stubGlobal("document", doc);
    const chime = await freshChime();

    chime.playPaymentChime();
    const ctx = FakeAudioContext.instances[0]!;
    ctx.state = "suspended";
    ctx.resume.mockReturnValue(Promise.reject(new Error("needs gesture")));

    chime.playPaymentChime();

    expect(doc.listeners.has("pointerdown")).toBe(true);
    expect(doc.listeners.has("keydown")).toBe(true);
  });
});

describe("armPaymentChime", () => {
  it("unlocks on the first effective gesture and removes its listeners", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const doc = fakeDocument();
    vi.stubGlobal("document", doc);
    const chime = await freshChime();

    chime.armPaymentChime();
    chime.armPaymentChime();
    expect(doc.addEventListener).toHaveBeenCalledTimes(2);
    expect(doc.listeners.has("pointerdown")).toBe(true);

    doc.listeners.get("pointerdown")!();
    await Promise.resolve();
    await Promise.resolve();

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.resume).toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
  });

  it("keeps listening when a gesture fails to unlock the context", async () => {
    class StubbornContext extends FakeAudioContext {
      override state = "suspended";
      override resume = vi.fn(() => Promise.resolve());
    }
    vi.stubGlobal("AudioContext", StubbornContext);
    const doc = fakeDocument();
    vi.stubGlobal("document", doc);
    const chime = await freshChime();

    chime.armPaymentChime();
    doc.listeners.get("pointerdown")!();
    await Promise.resolve();
    await Promise.resolve();

    expect(doc.listeners.has("pointerdown")).toBe(true);
    expect(doc.listeners.has("keydown")).toBe(true);
  });

  it("does not install listeners when audio is unsupported", async () => {
    const doc = fakeDocument();
    vi.stubGlobal("document", doc);
    const chime = await freshChime();

    chime.armPaymentChime();

    expect(doc.addEventListener).not.toHaveBeenCalled();
  });
});
