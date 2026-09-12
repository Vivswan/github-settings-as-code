/**
 * The ArtifactUploader port over @actions/artifact: the one production
 * implementation, so the report layer never touches the artifact service.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import type { ArtifactUploader } from "../index.js";

/** @actions/artifact uploads files from disk, so the ciphertext round-trips through a private temp directory. */
export const actionsArtifactUploader: ArtifactUploader = {
  async upload(name, file) {
    // DefaultArtifactClient emits its own core.warning before it throws on a
    // missing runtime token, so invoking it without one would double-warn.
    // Fail before constructing it; deliverArtifactReport turns this into the
    // single warning callers see.
    if (!process.env.ACTIONS_RUNTIME_TOKEN) {
      throw new Error(
        "the artifact service is unavailable: no ACTIONS_RUNTIME_TOKEN in the environment. Artifact upload needs a GitHub-hosted or self-hosted Actions runner (it is not available on GitHub Enterprise Server or outside Actions)",
      );
    }
    const dir = await mkdtemp(join(tmpdir(), "settings-as-code-report-"));
    try {
      const path = join(dir, file.name);
      await writeFile(path, file.data);
      await new DefaultArtifactClient().uploadArtifact(name, [path], dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
