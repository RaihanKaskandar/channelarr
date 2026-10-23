export type JobName = "playlist" | "epg" | "epg-rebuild";

export interface JobState {
  running: JobName | null;
  step: string | null;
  startedAt: number | null;
  last: Partial<Record<JobName, { finishedAt: number; ok: boolean; message: string }>>;
}

const state: JobState = { running: null, step: null, startedAt: null, last: {} };
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<JobName>();

export function jobState(): JobState {
  return { ...state, last: { ...state.last } };
}

export function setStep(step: string) {
  state.step = step;
}

/**
 * Runs jobs one at a time. Asking for a job that is already waiting returns the queued run
 * instead of adding another, so repeated button presses or schedule ticks don't pile up.
 */
export function runJob(name: JobName, fn: () => Promise<string>): Promise<void> {
  if (queued.has(name)) return chain.then(() => undefined);
  queued.add(name);
  const run = chain.then(async () => {
    queued.delete(name);
    state.running = name;
    state.step = null;
    state.startedAt = Date.now();
    try {
      const message = await fn();
      state.last[name] = { finishedAt: Date.now(), ok: true, message };
    } catch (err) {
      state.last[name] = { finishedAt: Date.now(), ok: false, message: err instanceof Error ? err.message : String(err) };
      console.error(`[job:${name}]`, state.last[name].message);
    } finally {
      state.running = null;
      state.step = null;
      state.startedAt = null;
    }
  });
  chain = run;
  return run;
}

let rebuildTimer: NodeJS.Timeout | undefined;

/** Coalesces bursts of edits (toggling twenty channels) into one EPG rebuild. */
export function debounce(fn: () => void, ms = 5000) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(fn, ms);
}
