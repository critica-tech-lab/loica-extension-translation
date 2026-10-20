import { describe, expect, test } from "bun:test";
import { createGate, GateBusyError } from "../gate";

describe("translation gate", () => {
  test("holds a slot until released, queues, then rejects overflow", async () => {
    const gate = createGate({ maxActive: 1, maxQueued: 1 });
    const release1 = await gate.acquire();
    expect(gate.stats()).toEqual({ active: 1, queued: 0 });

    let gotSecond = false;
    const second = gate.acquire().then((r) => {
      gotSecond = true;
      return r;
    });
    expect(gate.stats()).toEqual({ active: 1, queued: 1 });

    await expect(gate.acquire()).rejects.toBeInstanceOf(GateBusyError);

    release1();
    release1(); // a double release must not free a second slot
    const release2 = await second;
    expect(gotSecond).toBe(true);
    expect(gate.stats()).toEqual({ active: 1, queued: 0 });

    release2();
    expect(gate.stats()).toEqual({ active: 0, queued: 0 });
  });
});
