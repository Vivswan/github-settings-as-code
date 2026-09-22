import { describe, expect, test } from "bun:test";
import { autolinksSection } from "../../../src/sections/autolinks/index.js";
import type { SectionInput } from "../../../src/sections/contract/module.js";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../mock-api.js";
import { fragmentFake } from "../fragment-fake.js";
import { provePlanIdempotent } from "../plan-idempotence.js";
import { REPO, unwrap } from "../section-run.js";
import { validatedInput } from "../validated-input.js";
import { autolinksMockHandlers } from "./mock.js";

/** The list is unpaginated: one bare GET, no page params. */
const LIST = "GET /repos/o/r/autolinks";
const liveAutolinks = [
  { id: 1, key_prefix: "JIRA-", url_template: "https://x.test/<num>", is_alphanumeric: true },
  { id: 2, key_prefix: "OLD-", url_template: "https://y.test/<num>", is_alphanumeric: true },
];
const KEEP_NOTE =
  'autolink "OLD-" exists on the repo but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply DELETE it';
const plan = async (api: MockApi, desired: SectionInput<"autolinks">) =>
  unwrap(
    await autolinksSection.plan(
      planContext(autolinksSection, api, REPO),
      validatedInput("autolinks", desired),
    ),
  );

describe("autolinks", () => {
  test("plans a delete-and-recreate for a changed autolink, a create for a missing one, and a delete for the undeclared one, reading once", async () => {
    const api = new MockApi({ [LIST]: { data: liveAutolinks } });
    const result = await plan(api, [
      { key_prefix: "JIRA-", url_template: "https://z.test/<num>", is_alphanumeric: true },
      { key_prefix: "NEW-", url_template: "https://n.test/<num>" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          params: { autolink_id: "2" },
          describe: 'deleting undeclared autolink "OLD-"',
          drift: [
            "autolinks[OLD-]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared autolink "OLD-"',
        },
        {
          role: "remove",
          params: { autolink_id: "1" },
          describe: 'deleting autolink "JIRA-" before recreating it',
          drift: [
            "autolinks[JIRA-]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it",
          ],
          change: 'deleted autolink "JIRA-" to recreate it with the declared settings',
        },
        {
          role: "create",
          payload: {
            key_prefix: "JIRA-",
            url_template: "https://z.test/<num>",
            is_alphanumeric: true,
          },
          describe: 'recreating autolink "JIRA-"',
          drift: [
            'autolinks[JIRA-].url_template: declared "https://z.test/<num>" != live "https://x.test/<num>"',
          ],
          change: 'recreated autolink "JIRA-"',
        },
        {
          // An undeclared is_alphanumeric is left to GitHub's default (true).
          role: "create",
          payload: { key_prefix: "NEW-", url_template: "https://n.test/<num>" },
          describe: 'creating autolink "NEW-"',
          drift: [
            "autolinks[NEW-]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created autolink "NEW-"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a matching autolink plans nothing, and an omitted is_alphanumeric is not compared", async () => {
    const api = new MockApi({ [LIST]: { data: liveAutolinks } });
    const result = await plan(api, [
      { key_prefix: "JIRA-", url_template: "https://x.test/<num>" },
      { key_prefix: "OLD-", url_template: "https://y.test/<num>", is_alphanumeric: true },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared key the live autolink lacks is drift on the recreate plus a phantom note", async () => {
    const api = new MockApi({ [LIST]: { data: liveAutolinks } });
    const result = await plan(api, {
      _undeclared: "keep",
      entries: [
        {
          key_prefix: "JIRA-",
          url_template: "https://x.test/<num>",
          is_alphanumerc: true,
        } as never,
      ],
    });
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "remove",
        [
          "autolinks[JIRA-]: live settings differ from the settings file, and autolinks cannot be edited; apply will delete and recreate it",
        ],
      ],
      [
        "create",
        [
          "autolinks[JIRA-].is_alphanumerc: declared true but the API response has no such field (new or write-only field?)",
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      'autolinks[JIRA-]: declared key "is_alphanumerc" does not exist on the live autolink, so if GitHub ignores it this delete-and-recreate will repeat on every apply without converging. Fix the key name, or remove it from the settings file',
      KEEP_NOTE,
    ]);
  });

  test("duplicate prefixes inside the wrapper are a validate issue under .entries, so the document fails before any API call", () => {
    expect(
      autolinksSection.validate({
        entries: [
          { key_prefix: "JIRA-", url_template: "https://x.test/<num>" },
          { key_prefix: "JIRA-", url_template: "https://y.test/<num>" },
        ],
      }),
    ).toEqual([
      {
        path: ".entries[1].key_prefix",
        message:
          '"JIRA-" names the same autolink as "JIRA-" declared earlier; keep exactly one entry per autolink',
      },
    ]);
  });

  test("a prefix that begins another prefix is refused as a pair before any API call: GitHub rejects the second create, which would half-apply the run", () => {
    expect(
      autolinksSection.validate([
        { key_prefix: "TICKET-A", url_template: "https://a.test/<num>" },
        { key_prefix: "JIRA-", url_template: "https://j.test/<num>" },
        { key_prefix: "TICKET-", url_template: "https://t.test/<num>" },
      ]),
    ).toEqual([
      {
        path: "[2].key_prefix",
        message:
          'the key_prefix "TICKET-" begins the key_prefix "TICKET-A", and GitHub rejects an autolink whose prefix begins or extends another, ' +
          "so the second create would fail - choose prefixes where neither begins the other",
      },
    ]);
  });

  test.each<[entry: Record<string, unknown>, issues: [path: string, message: string][]]>([
    [
      { key_prefix: "TICKET-", url_template: "https://example.com/TICKET" },
      [
        [
          "[0].url_template",
          'url_template "https://example.com/TICKET" has no "<num>" placeholder, so GitHub rejects the create; put "<num>" where the reference number goes, e.g. "https://example.com/TICKET/<num>"',
        ],
      ],
    ],
    [
      { key_prefix: "", url_template: "https://example.com/<num>" },
      [
        [
          "[0].key_prefix",
          'key_prefix is empty; it is the text GitHub matches before the reference number, e.g. "TICKET-"',
        ],
      ],
    ],
    [
      { key_prefix: "TICKET ", url_template: "https://example.com/<num>" },
      [
        [
          "[0].key_prefix",
          'key_prefix "TICKET " may only contain letters, digits, and . - _ + = : / #, which is all GitHub accepts; remove the other characters',
        ],
      ],
    ],
    [{ key_prefix: "TICKET_1.x:/#=+-", url_template: "https://example.com/<num>?x=<num>" }, []],
  ])(
    "the shape refuses what GitHub 422s on the create, naming the key and the fix: %j",
    (entry, issues) => {
      const parsed = autolinksSection.shape.safeParse([entry]);
      expect(
        parsed.success
          ? []
          : parsed.error.issues.map((issue) => [
              issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join(""),
              issue.message,
            ]),
      ).toEqual(issues);
    },
  );

  test("executing the plan against the derived mock converges: DELETE then POST for the replace, and the re-plan is empty", async () => {
    const api = fragmentFake(autolinksSection, autolinksMockHandlers, {
      autolinks: [
        {
          id: 10,
          key_prefix: "TICKET-",
          url_template: "https://old.example.com/<num>",
          is_alphanumeric: true,
        },
        {
          id: 20,
          key_prefix: "JIRA-",
          url_template: "https://jira.example.com/<num>",
          is_alphanumeric: true,
        },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(autolinksSection, api, [
      {
        key_prefix: "TICKET-",
        url_template: "https://example.com/TICKET?q=<num>",
        is_alphanumeric: false,
      },
    ]);
    expect(changes).toEqual([
      'DELETED undeclared autolink "JIRA-"',
      'deleted autolink "TICKET-" to recreate it with the declared settings',
      'recreated autolink "TICKET-"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/autolinks/20",
      "DELETE /repos/o/r/autolinks/10",
      "POST /repos/o/r/autolinks",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(
      api.state.autolinks.map((a) => [a.key_prefix, a.url_template, a.is_alphanumeric]),
    ).toEqual([["TICKET-", "https://example.com/TICKET?q=<num>", false]]);
  });

  test("a recreate with is_alphanumeric undeclared re-sends the live flag: the create default is true, so replacing the template would otherwise flip a false flag with no drift line", async () => {
    const api = fragmentFake(autolinksSection, autolinksMockHandlers, {
      autolinks: [
        {
          id: 10,
          key_prefix: "TICKET-",
          url_template: "https://old.example.com/<num>",
          is_alphanumeric: false,
        },
      ],
    });
    const { first, second, changes } = await provePlanIdempotent(autolinksSection, api, [
      { key_prefix: "TICKET-", url_template: "https://example.com/TICKET/<num>" },
    ]);
    expect(first.ops.map((op) => (op.role === "create" ? op.payload : op.role))).toEqual([
      "remove",
      {
        key_prefix: "TICKET-",
        url_template: "https://example.com/TICKET/<num>",
        is_alphanumeric: false,
      },
    ]);
    expect(changes).toEqual([
      'deleted autolink "TICKET-" to recreate it with the declared settings',
      'recreated autolink "TICKET-"',
    ]);
    expect(api.writes).toEqual(["DELETE /repos/o/r/autolinks/10", "POST /repos/o/r/autolinks"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(
      api.state.autolinks.map((a) => [a.key_prefix, a.url_template, a.is_alphanumeric]),
    ).toEqual([["TICKET-", "https://example.com/TICKET/<num>", false]]);
  });
});
