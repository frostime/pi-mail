import type { MailService } from "./mail-service.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export interface PresenceRuntime {
  start(): void;
  dispose(): Promise<void>;
}

export function createPresenceRuntime(options: {
  mailbox: Pick<MailService, "heartbeat">;
  intervalMs?: number;
}): PresenceRuntime {
  const { mailbox } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeHeartbeat: Promise<void> | null = null;
  let disposeTask: Promise<void> | null = null;

  function heartbeat(): void {
    if (!running || activeHeartbeat) return;

    const task = mailbox.heartbeat()
      .catch((error) => {
        if (running) console.error("[pi-mail] heartbeat failed:", error);
      })
      .finally(() => {
        if (activeHeartbeat === task) activeHeartbeat = null;
      });
    activeHeartbeat = task;
  }

  return {
    start() {
      if (disposeTask) throw new Error("Pi Mail presence runtime is disposed");
      if (running) return;
      running = true;
      timer = setInterval(heartbeat, intervalMs);
      timer.unref();
    },

    dispose() {
      if (disposeTask) return disposeTask;
      running = false;
      if (timer) clearInterval(timer);
      timer = null;

      const heartbeat = activeHeartbeat;
      disposeTask = (async () => {
        await heartbeat?.catch(() => {});
        if (activeHeartbeat === heartbeat) activeHeartbeat = null;
      })();
      return disposeTask;
    },
  };
}
