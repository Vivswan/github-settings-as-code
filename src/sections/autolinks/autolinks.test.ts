import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { autolinksSection } from "./index.js";

describe("autolinks undeclared policy", () => {
  const liveAutolinks = [
    { id: 1, key_prefix: "JIRA-", url_template: "https://x.test/<num>", is_alphanumeric: true },
    { id: 2, key_prefix: "OLD-", url_template: "https://y.test/<num>", is_alphanumeric: true },
  ];

  test("the delete default removes the undeclared autolink", async () => {
    const api = new MockApi({
      "GET /repos/o/r/autolinks": { data: liveAutolinks },
    }).allowMutations("DELETE /repos/o/r/autolinks/*");
    const result = await autolinksSection.run(ctx(api), [
      { key_prefix: "JIRA-", url_template: "https://x.test/<num>", is_alphanumeric: true },
    ]);
    expect(result.changes).toEqual(["DELETED undeclared autolink OLD-"]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/autolinks/2",
    ]);
  });

  test("wrapped undeclared:keep notes the undeclared autolink, never a DELETE", async () => {
    const api = new MockApi({
      "GET /repos/o/r/autolinks": { data: liveAutolinks },
    });
    const result = await autolinksSection.run(ctx(api), {
      undeclared: "keep",
      entries: [
        { key_prefix: "JIRA-", url_template: "https://x.test/<num>", is_alphanumeric: true },
      ],
    });
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      'autolink OLD- exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:keep in check mode notes instead of drifting", async () => {
    const api = new MockApi({
      "GET /repos/o/r/autolinks": { data: liveAutolinks },
    });
    const result = await autolinksSection.run(ctx(api, true), {
      undeclared: "keep",
      entries: [
        { key_prefix: "JIRA-", url_template: "https://x.test/<num>", is_alphanumeric: true },
      ],
    });
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });

  test("duplicate prefixes inside the wrapper are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      autolinksSection.run(ctx(api), {
        entries: [
          { key_prefix: "JIRA-", url_template: "https://x.test/<num>" },
          { key_prefix: "JIRA-", url_template: "https://y.test/<num>" },
        ],
      }),
    ).rejects.toThrow(/same autolinks entry/);
    expect(api.calls).toHaveLength(0);
  });
});
