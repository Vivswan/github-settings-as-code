import { join } from "node:path";

/** The repository root, for tests that read committed files or spawn the scripts by path. */
export const ROOT = join(import.meta.dir, "..");
