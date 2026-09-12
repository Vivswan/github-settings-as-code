import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DefaultArtifactClient } from "@actions/artifact";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { actionsArtifactUploader } from "../../src/action/artifact.js";
import { deliverArtifactReport } from "../../src/report/artifact-report.js";

describe("the action's uploader without a runtime token", () => {
  const savedToken = process.env.ACTIONS_RUNTIME_TOKEN;

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.ACTIONS_RUNTIME_TOKEN;
    } else {
      process.env.ACTIONS_RUNTIME_TOKEN = savedToken;
    }
  });

  test("missing token yields exactly ONE warning and never invokes the artifact client", async () => {
    delete process.env.ACTIONS_RUNTIME_TOKEN;
    // Reaching the client would double-warn (it warns before it throws); its @actions/core import is a named binding a namespace spy cannot observe,
    // so the client's entry point is watched.
    const uploadSpy = spyOn(DefaultArtifactClient.prototype, "uploadArtifact");
    try {
      const recipient = await identityToRecipient(await generateX25519Identity());
      const result = await deliverArtifactReport(
        actionsArtifactUploader,
        "secret document",
        recipient,
      );

      expect(result).toEqual({
        warning:
          "could not upload the private report artifact: the artifact service is unavailable: no " +
          "ACTIONS_RUNTIME_TOKEN in the environment. Artifact upload needs a GitHub-hosted or " +
          "self-hosted Actions runner (it is not available on GitHub Enterprise Server or outside " +
          "Actions). Re-run the workflow, or set private-report: none if it persists",
      });
      expect(uploadSpy).toHaveBeenCalledTimes(0);
    } finally {
      uploadSpy.mockRestore();
    }
  });
});
