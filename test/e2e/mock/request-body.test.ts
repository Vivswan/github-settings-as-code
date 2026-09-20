/**
 * The pipeline hands a handler only what GitHub keeps of a body: the fields the trimmed spec documents.
 * An undocumented key on an open body is dropped (GitHub ignores it; the GET never echoes it), on a
 * closed body it is GitHub's 422. Pinned over the wire, since a handler unit test bypasses the pipeline.
 */

import { describe, expect, test } from "bun:test";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../constants.js";
import { sharedValidator } from "../openapi/validate.js";
import { UNDOCUMENTED_BODY_FIELDS } from "./request-body.js";
import {
  call,
  json,
  labelsPath,
  mockServerLifecycle,
  scenario,
  singleState,
} from "./server-test-support.js";

const start = mockServerLifecycle();
const repoPath = `/repos/${OWNER}/${REPO}`;

test("every undocumented-but-accepted field is still absent from the spec, or the entry retires", () => {
  const validator = sharedValidator();
  for (const [route, fields] of UNDOCUMENTED_BODY_FIELDS) {
    const documented = validator.requestBody(route);
    expect(documented, route).toBeDefined();
    for (const field of fields) {
      expect(documented?.fields.has(field), `${route} ${field}`).toBe(false);
    }
  }
});

describe("an undocumented key on an open body is dropped before the handler", () => {
  test("a label PATCH keeps color and loses the phantom key, on the echo and in state", async () => {
    const h = await start(scenario({ live_state: { labels: [{ name: "bug", color: "ededed" }] } }));
    const res = await call(h, "PATCH", `${labelsPath}/bug`, {
      body: { color: "d73a4a", colour: "ff0000" },
    });
    expect(res.status).toBe(200);
    const echoed = await json(res);
    expect(echoed.color).toBe("d73a4a");
    expect("colour" in echoed).toBe(false);
    expect(singleState(h).labels[0]).not.toHaveProperty("colour");
  });

  test("a hook PATCH no longer stores a passthrough key", async () => {
    const h = await start(
      scenario({ live_state: { hooks: [{ id: 90_000_000, config: { url: "https://h.test" } }] } }),
    );
    const res = await call(h, "PATCH", `${repoPath}/hooks/90000000`, {
      body: { active: false, name: "web", nickname: "ci" },
    });
    expect(res.status).toBe(200);
    expect(singleState(h).hooks[0]).not.toHaveProperty("nickname");
    expect(singleState(h).hooks[0]?.active).toBe(false);
  });

  test("a variable POST and PATCH store name and value only", async () => {
    const h = await start(scenario());
    const created = await call(h, "POST", `${repoPath}/actions/variables`, {
      body: { name: "region", value: "eu", scope: "repo" },
    });
    expect(created.status).toBe(201);
    expect(singleState(h).actions_variables[0]).not.toHaveProperty("scope");
    const updated = await call(h, "PATCH", `${repoPath}/actions/variables/REGION`, {
      body: { value: "us", scope: "org" },
    });
    expect(updated.status).toBe(204);
    expect(singleState(h).actions_variables[0]).toMatchObject({ name: "REGION", value: "us" });
    expect(singleState(h).actions_variables[0]).not.toHaveProperty("scope");
  });

  test("the repository PATCH keeps has_discussions, which GitHub accepts though its descriptor omits it", async () => {
    const h = await start(scenario());
    const res = await call(h, "PATCH", repoPath, {
      body: { has_discussions: true, has_downloads: false },
    });
    expect(res.status).toBe(200);
    expect(singleState(h).repo.has_discussions).toBe(true);
    // has_downloads is GET-only: the PATCH drops it, so the stored fixture value stands.
    expect(singleState(h).repo.has_downloads).not.toBe(false);
  });
});

describe("an undocumented key on a closed body is GitHub's 422", () => {
  test("the code scanning setup PATCH names the key and stores nothing", async () => {
    const h = await start(scenario({ live_state: { code_scanning: { state: "not-configured" } } }));
    const res = await call(h, "PATCH", `${repoPath}/code-scanning/default-setup`, {
      body: { state: "configured", query_suit: "extended" },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toBe(
      'Invalid request.\n\n"query_suit" is not a permitted key.',
    );
    expect(singleState(h).code_scanning).toEqual({ state: "not-configured" });
    // The body is deliberately off the request schema, so the validator skips only that check.
    expect(h.requests.find((r) => r.method === "PATCH")?.requestOffSpec).toBe(true);
  });

  test("several unknown keys are listed together", async () => {
    const h = await start(scenario());
    const res = await call(h, "PATCH", `${repoPath}/code-quality/setup`, {
      body: { state: "configured", a: 1, b: 2 },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toBe('Invalid request.\n\n"a", "b" are not permitted keys.');
  });

  test("an environment PUT with a GET-shape key is refused instead of stored", async () => {
    const h = await start(scenario());
    const res = await call(h, "PUT", `${repoPath}/environments/prod`, {
      body: { wait_timer: 5, protection_rules: [] },
    });
    expect(res.status).toBe(422);
    expect(singleState(h).environments.prod).toBeUndefined();
  });
});
