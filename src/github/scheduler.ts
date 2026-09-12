/**
 * The limiter class the throttling plugin schedules through, injectable so a test run keeps the plugin's rate-limit
 * decisions while skipping Bottleneck's pacing: each Bottleneck limiter yields through several zero-delay timers per
 * job, around 11 ms on every request across the plugin's three limiters, and the notification limiter spaces issue
 * creates by three real seconds whatever the plugin's time unit.
 *
 * TIMERS_SCHEDULER     -> Bottleneck itself: real pacing, real Retry-After sleeps
 * IMMEDIATE_SCHEDULER  -> every job runs at once; a request the plugin decides to retry is retried without sleeping
 *
 * The plugin's own limiter groups (global, auth, search, notifications) are process-wide singletons built from the
 * FIRST instance's scheduler; a process mixing schedulers paces those groups by whichever came first.
 */

import Bottleneck from "bottleneck/light.js";

/**
 * Bottleneck's "failed" contract: a numeric return is the wait before a retry; anything else, a handler that throws
 * included, fails the job with the ORIGINAL error. The throttling plugin's handler reads `error.response.headers` on
 * a transport error that has no response, so a propagated handler exception would replace "socket hang up".
 */
type FailedHandler = (
  error: unknown,
  info: { retryCount: number; args: unknown[]; options: unknown },
) => unknown;

interface SchedulerLimiter {
  on(name: string, handler: FailedHandler): unknown;
  /** Both Bottleneck call shapes: `schedule(fn, ...args)` and `schedule(options, fn, ...args)`. */
  schedule(...call: unknown[]): Promise<unknown>;
}

/**
 * The slice of Bottleneck's class the throttling plugin calls on the class it is handed, declared structurally so the
 * library's public declarations never name `bottleneck/light.js`, which publishes no types of its own.
 */
export interface Scheduler {
  new (): SchedulerLimiter;
  Group: new (options: {
    id: string;
    maxConcurrent?: number;
    minTime?: number;
  }) => {
    key(id: string): SchedulerLimiter;
  };
  /** The plugin attaches its rate-limit listeners to a plain object through this emitter. */
  Events: new (
    target: object,
  ) => unknown;
}

export const TIMERS_SCHEDULER: Scheduler = Bottleneck;

type Job = (...args: unknown[]) => unknown;

class ImmediateGroup {
  private readonly limiter = new ImmediateLimiter();

  key(): ImmediateLimiter {
    return this.limiter;
  }
}

class ImmediateLimiter implements SchedulerLimiter {
  static Group = ImmediateGroup;
  static Events = Bottleneck.Events;

  private onFailed: FailedHandler | undefined;

  on(name: string, handler: FailedHandler): this {
    if (name === "failed") {
      this.onFailed = handler;
    }
    return this;
  }

  private async failedWait(error: unknown, info: Parameters<FailedHandler>[1]): Promise<unknown> {
    try {
      return await this.onFailed?.(error, info);
    } catch {
      return undefined;
    }
  }

  async schedule(...call: unknown[]): Promise<unknown> {
    const [options, job, ...args] = typeof call[0] === "function" ? [{}, ...call] : call;
    for (let retryCount = 0; ; retryCount++) {
      try {
        return await (job as Job)(...args);
      } catch (error) {
        const wait = await this.failedWait(error, { retryCount, args, options });
        if (typeof wait !== "number") {
          throw error;
        }
      }
    }
  }
}

export const IMMEDIATE_SCHEDULER: Scheduler = ImmediateLimiter;
