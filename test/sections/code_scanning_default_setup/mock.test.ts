import { describe, expect, test } from "bun:test";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../../e2e/constants.js";
import { call, json, mockServerLifecycle, scenario } from "../../e2e/mock/server-test-support.js";

const start = mockServerLifecycle();

describe("code-scanning 200-vs-202 rule", () => {
  const path = `/repos/${OWNER}/${REPO}/code-scanning/default-setup`;
  const configured = { state: "configured", languages: ["python"] };
  // A 202 carries the configuration run; the spec's 200 body is an empty object
  // (additionalProperties: false), NOT the stored config.
  test.each([
    [
      "a payload changing languages answers 202 with run_id",
      configured,
      { languages: ["javascript"] },
      202,
    ],
    [
      "a payload leaving languages alone answers 200 with an empty body",
      configured,
      { state: "configured" },
      200,
    ],
    [
      "languages added over a live seed that declares none answer 202",
      { state: "configured" },
      { languages: ["javascript"] },
      202,
    ],
  ] as const)("%s", async (_name, seed, body, status) => {
    const h = await start(scenario({ live_state: { code_scanning: seed } }));
    const res = await call(h, "PATCH", path, { body });
    expect(res.status).toBe(status);
    const answered = await json(res);
    expect(answered).toEqual(
      status === 202
        ? {
            run_id: expect.any(Number),
            run_url: `https://api.github.com${path}/runs/${String(answered.run_id)}`,
          }
        : {},
    );
  });
});
