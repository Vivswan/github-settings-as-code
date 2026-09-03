import { type Io, maskRegistry } from "../src/io.js";

/**
 * A no-op Io for tests that only need validateSettingsDoc (or a run) to
 * proceed without @actions/core. Fresh per call, so one test's masks never
 * leak into another's registry.
 */
export function silentIo(): Io {
  return {
    annotate: () => {},
    log: () => {},
    debug: () => {},
    summary: () => {},
    output: () => {},
    ...maskRegistry(() => {}),
  };
}
