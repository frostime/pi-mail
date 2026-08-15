import assert from "node:assert/strict";
import test from "node:test";

import { createPresenceRuntime } from "../extensions/pi-mail/presence-runtime.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dispose stops scheduling and waits for an in-flight heartbeat", async () => {
  let heartbeatCalls = 0;
  let finishHeartbeat!: () => void;
  const heartbeatFinished = new Promise<void>((resolve) => {
    finishHeartbeat = resolve;
  });
  const runtime = createPresenceRuntime({
    mailbox: {
      async heartbeat() {
        heartbeatCalls += 1;
        await heartbeatFinished;
      },
    },
    intervalMs: 5,
  });

  runtime.start();
  await delay(20);
  assert.equal(heartbeatCalls, 1);

  let disposed = false;
  const disposing = runtime.dispose().then(() => {
    disposed = true;
  });
  const concurrentDispose = runtime.dispose();
  await delay(10);
  assert.equal(disposed, false);

  finishHeartbeat();
  await Promise.all([disposing, concurrentDispose]);
  await delay(20);
  assert.equal(heartbeatCalls, 1);
});

test("start and dispose are idempotent", async () => {
  let heartbeatCalls = 0;
  const runtime = createPresenceRuntime({
    mailbox: {
      async heartbeat() {
        heartbeatCalls += 1;
      },
    },
    intervalMs: 5,
  });

  runtime.start();
  runtime.start();
  await delay(15);
  await runtime.dispose();
  await runtime.dispose();
  const callsAtDispose = heartbeatCalls;
  await delay(15);

  assert.ok(callsAtDispose > 0);
  assert.equal(heartbeatCalls, callsAtDispose);
});
