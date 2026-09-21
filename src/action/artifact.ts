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
    // DefaultArtifactClient emits its own core.warning before it throws on a missing runtime token; failing before
    // constructing it keeps the single warning deliverArtifactReport turns this into.
    if (!process.env.ACTIONS_RUNTIME_TOKEN) {
      return {
        failed:
          "the artifact service is unavailable: no ACTIONS_RUNTIME_TOKEN in the environment. Artifact upload needs a GitHub-hosted or self-hosted Actions runner (it is not available on GitHub Enterprise Server or outside Actions)",
      };
    }
    // The artifact client and the filesystem report their failures by throwing; the port answers them as `failed`.
    let dir: string | undefined;
    let outcome: { uploaded: true } | { failed: string };
    try {
      dir = await mkdtemp(join(tmpdir(), "settings-as-code-report-"));
      const path = join(dir, file.name);
      await writeFile(path, file.data);
      await new DefaultArtifactClient().uploadArtifact(name, [path], dir);
      outcome = { uploaded: true };
    } catch (error) {
      outcome = { failed: error instanceof Error ? error.message : String(error) };
    }
    if (dir !== undefined) {
      // A cleanup that fails changes nothing about the upload, so the outcome stands.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return outcome;
  },
};
