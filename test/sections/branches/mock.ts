/**
 * The branches e2e mock fragment (aggregated in test/e2e/mock/sections.ts).
 */

import { createHash } from "node:crypto";
import { MISSING_BRANCH } from "../../../src/sections/branches/endpoints.js";
import { classicViewOfRule, RuleNode } from "../../../src/sections/branches/graphql-rules.js";
import { BOOLEAN_CONTROL_SET, NULLABLE_CONTROLS } from "../../../src/sections/branches/keys.js";
import { decodeNodeId, mintNodeId } from "../../e2e/mock/node-id.js";
import {
  allRuleNodes,
  applyRuleInput,
  applyRuleInputToLiteral,
  BYPASS_ACTOR_TEAMS,
  BYPASS_ACTOR_USERS,
  completeRule,
  type MockState,
  PROTECTION_RULE_APPS,
  protectionFromPut,
  ruleFromProtection,
  ruleWireNode,
} from "../../e2e/mock/state.js";
import {
  asObject,
  type GraphqlHandlerResult,
  integrationBody,
  type Json,
  type MockResponse,
  noContent,
  ok,
  rejected,
  repoNodeId,
  type SectionGraphqlHandlers,
  type SectionRestHandlers,
  slicePage,
} from "../../e2e/mock/support.js";

/**
 * GitHub's fnmatch (Ruby's, FNM_PATHNAME) for classic rule patterns: `*` and `?` stop at a slash,
 * only a double star followed by a slash crosses one (a bare double star is `*`), a bracket class
 * follows Ruby (`!` or `^` negates, a leading `]` closes it), a backslash escapes the next
 * character; every other character is literal. Exported for its own case table in branches.test.ts.
 */
export function wildcardMatches(pattern: string, branch: string): boolean {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      regex += "(?:[^/]*/)*";
      i += 2;
    } else if (ch === "*") {
      regex += "[^/]*";
      if (pattern[i + 1] === "*") {
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (ch === "\\") {
      // A backslash escapes the next character (Ruby has no FNM_NOESCAPE here); a trailing one is dropped.
      const next = pattern[i + 1];
      if (next !== undefined) {
        regex += next.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        i++;
      }
    } else if (ch === "[") {
      // Ruby negates on "!" or "^"; a leading "]" closes the class at once (an empty class matches nothing).
      const negated = pattern[i + 1] === "!" || pattern[i + 1] === "^";
      const start = i + (negated ? 2 : 1);
      // Members walk one at a time: a backslash escapes the next character (so an escaped "]" does
      // not close the class), an unescaped "-" keeps its range meaning, everything else is literal.
      let members = "";
      let close = -1;
      for (let j = start; j < pattern.length; j++) {
        const member = pattern[j] as string;
        if (member === "]") {
          close = j;
          break;
        }
        const escaped = member === "\\" && j + 1 < pattern.length;
        const literal = escaped ? (pattern[++j] as string) : member;
        members += !escaped && literal === "-" ? "-" : literal.replace(/[\]\\^[-]/g, "\\$&");
      }
      if (close < 0) {
        regex += "\\[";
      } else {
        // No class consumes a slash (fnmatch's FNM_PATHNAME), a positive one listing it included.
        regex += negated ? `[^/${members}]` : `(?!/)[${members}]`;
        i = close;
      }
    } else {
      regex += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`).test(branch);
}

/**
 * The REST GET shape of a wildcard rule, as GitHub serves it under a matching branch's name: the
 * classic view (routed keys and off controls dropped) through the PUT-to-GET projection every
 * stored protection takes, plus the signature sub-resource that projection leaves to its own
 * endpoint, so the flattener reads it like any other body.
 */
function restViewOfRule(rule: Json): Json {
  // The projection is parsed as the section parses a live node, so the mock cannot serve a shape the read refuses.
  const view = classicViewOfRule(RuleNode.parse(ruleWireNode(rule)));
  const payload: Json = {};
  for (const [key, value] of Object.entries(view)) {
    if (key === "force_push_bypassers" || key === "required_deployments") {
      continue;
    }
    if (value !== null && value !== false) {
      payload[key] = value as Json[string];
    }
  }
  const out = protectionFromPut(payload);
  if (view.required_signatures === true) {
    out.required_signatures = { enabled: true };
  }
  return out;
}

/**
 * What GET .../protection serves for a branch: its literal protection, else the FIRST wildcard rule
 * matching an EXISTING branch (GitHub applies rules in creation order, and a pattern protects no
 * branch that is not there), else nothing (404).
 */
function effectiveProtection(state: MockState, branch: string): Json | null {
  const literal = state.branch_protection[branch];
  if (literal) {
    return literal;
  }
  if (!state.branches.includes(branch)) {
    return null;
  }
  const rule = state.branch_protection_rules.find((candidate) =>
    wildcardMatches(String(candidate.pattern), branch),
  );
  return rule === undefined ? null : restViewOfRule(rule);
}

const ACTOR_LISTS = ["users", "teams", "apps"] as const;
type ActorHolder = Record<(typeof ACTOR_LISTS)[number], string[]>;
const isMapping = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The actor holders of a PUT body as GitHub reads them back: logins and slugs in their canonical
 * lowercase, a list the review-side holders omit served empty (the PUT takes each of theirs as
 * optional), and a review-side holder naming nobody dropped, since GitHub serves
 * dismissal_restrictions and bypass_pull_request_allowances only when they name someone.
 * `restrictions` stays whole: an all-empty one restricts pushes to nobody, a users or teams list it
 * omits never reaches here (missingRestrictionListResponse answers the 422 first), and an omitted
 * apps is served empty.
 */
function actorsAsGitHubReadsBack(payload: Json): Json {
  const canonical = (holder: Json): ActorHolder => {
    const out = { users: [], teams: [], apps: [] } as ActorHolder;
    for (const list of ACTOR_LISTS) {
      const names = holder[list];
      out[list] = Array.isArray(names) ? names.map((name) => String(name).toLowerCase()) : [];
    }
    return out;
  };
  const out: Json = { ...payload };
  if (isMapping(payload.restrictions)) {
    out.restrictions = canonical(payload.restrictions);
  }
  if (isMapping(payload.required_pull_request_reviews)) {
    const nested: Json = { ...payload.required_pull_request_reviews };
    for (const key of ["dismissal_restrictions", "bypass_pull_request_allowances"]) {
      const holder = nested[key];
      if (!isMapping(holder)) {
        continue;
      }
      const folded = canonical(holder);
      if (Object.values(folded).every((names) => names.length === 0)) {
        delete nested[key];
      } else {
        nested[key] = folded;
      }
    }
    out.required_pull_request_reviews = nested;
  }
  return out;
}

/**
 * The boolean controls the protection PUT takes: the GET-wrapped ones minus required_signatures,
 * which is its own sub-resource. GitHub 422s a non-boolean there, the {url, enabled} wrapper a
 * copied GET response carries included; null passes only under the NULLABLE_CONTROLS.
 */
const PUT_BOOLEAN_CONTROLS = [...BOOLEAN_CONTROL_SET].filter(
  (key) => key !== "required_signatures",
);

/** GitHub's "Validation Error Simple" to a PUT body off the protection schema; the validator skips only the body check. */
function validationFailed(error: string): MockResponse {
  return {
    status: 422,
    body: {
      message: "Validation Failed",
      errors: [`Invalid request.\n\n${error}`],
      documentation_url:
        "https://docs.github.com/rest/branches/branch-protection#update-branch-protection",
    },
    requestOffSpec: true,
  };
}

/** The first boolean control whose value the PUT schema refuses. */
function invalidBooleanControlResponse(payload: Json): MockResponse | null {
  for (const key of PUT_BOOLEAN_CONTROLS) {
    if (!Object.hasOwn(payload, key)) {
      continue;
    }
    const value = payload[key];
    const nullable = NULLABLE_CONTROLS.has(key);
    if (typeof value === "boolean" || (value === null && nullable)) {
      continue;
    }
    const expected = nullable ? "a boolean or null" : "a boolean";
    return validationFailed(
      `For 'properties/${key}', ${JSON.stringify(value)} is not ${expected}.`,
    );
  }
  return null;
}

/** The PUT schema requires users and teams under restrictions (apps is optional); GitHub names the first list not supplied. */
const REQUIRED_RESTRICTION_LISTS = ["users", "teams"] as const;

function missingRestrictionListResponse(payload: Json): MockResponse | null {
  if (!isMapping(payload.restrictions)) {
    return null;
  }
  const missing = REQUIRED_RESTRICTION_LISTS.find(
    (list) => !Object.hasOwn(payload.restrictions as Json, list),
  );
  return missing === undefined ? null : validationFailed(`"${missing}" wasn't supplied.`);
}

export const branchesMockHandlers: SectionRestHandlers<"branches"> = {
  "branches.listProtected": ({ state, param, query }) => {
    // A branch a wildcard rule matches is protected too, as on GitHub, where the REST view serves
    // the matching rule's protection under the branch's own name.
    const protectedNames = [
      ...new Set([...state.branches, ...Object.keys(state.branch_protection)]),
    ].filter((name) => effectiveProtection(state, name) !== null);
    // A protected branch exists even when the branches family does not list it.
    const all = [...new Set([...state.branches, ...protectedNames])];
    const names =
      query.protected === "true"
        ? all.filter((name) => protectedNames.includes(name))
        : query.protected === "false"
          ? all.filter((name) => !protectedNames.includes(name))
          : all;
    const slug = `${param("owner")}/${param("repo")}`;
    return ok(
      slicePage(
        names.map((name) => ({
          name,
          commit: {
            sha: createHash("sha1").update(name).digest("hex"),
            url: `https://api.github.com/repos/${slug}/commits/${name}`,
          },
          protected: protectedNames.includes(name),
          protection_url: `https://api.github.com/repos/${slug}/branches/${name}/protection`,
        })),
        query,
      ),
    );
  },
  "branches.getProtection": ({ state, param }) => {
    const protection = effectiveProtection(state, param("branch"));
    if (protection === null) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    return ok(protection);
  },
  "branches.putProtection": ({ state, param, body }) => {
    const branch = param("branch");
    if (!state.branches.includes(branch)) {
      return rejected(MISSING_BRANCH);
    }
    const payload = asObject(body);
    const invalid =
      invalidBooleanControlResponse(payload) ?? missingRestrictionListResponse(payload);
    if (invalid !== null) {
      return invalid;
    }
    const stored = protectionFromPut(actorsAsGitHubReadsBack(payload));
    // required_signatures is its own sub-resource and absent from the PUT's request schema. Whether
    // GitHub's PUT PRESERVES an existing requirement is undocumented; the mock carries it across as
    // the conservative reading, and the docs tell users to DECLARE the toggle, which pins the state
    // under either upstream behavior.
    const previous = state.branch_protection[branch];
    if (previous && previous.required_signatures !== undefined) {
      stored.required_signatures = previous.required_signatures;
    }
    state.branch_protection[branch] = stored;
    return ok(stored);
  },
  "branches.removeProtection": ({ state, param }) => {
    const branch = param("branch");
    state.branch_protection[branch] = null;
    // GitHub deletes the whole underlying RULE, so the GraphQL-only extras must not survive the delete.
    delete state.branch_protection_graphql[branch];
    return noContent();
  },
  "branches.sigPost": ({ state, param }) => {
    const branch = param("branch");
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    protection.required_signatures = { enabled: true };
    // The documented 200 body carries {url, enabled}; the url stays out of the stored state so the
    // flattener sees the same shape a GET serves.
    return ok({
      url: `https://api.github.com/repos/${state.slug}/branches/${branch}/protection/required_signatures`,
      enabled: true,
    });
  },
  "branches.sigDelete": ({ state, param }) => {
    const branch = param("branch");
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    // The GET shape OMITS the field when signatures are not required, so a delete removes the key
    // instead of storing {enabled: false}.
    delete protection.required_signatures;
    return noContent();
  },
  "branches.branchProbe": ({ state, param }) => {
    const branch = param("branch");
    if (!state.branches.includes(branch)) {
      return rejected(MISSING_BRANCH);
    }
    return ok({ name: branch });
  },
  "branches.appLookup": ({ param }) => {
    const slug = param("app_slug");
    // Slug matching is case-insensitive like GitHub's; the body echoes the canonical roster slug.
    const app = PROTECTION_RULE_APPS.find(
      (entry) => String(entry.slug).toLowerCase() === slug.toLowerCase(),
    );
    if (!app) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The served node_id is MINTED, never the fixture's realistic-looking one: the section feeds it
    // into bypassForcePushActorIds, and the mutation handlers reject any id the codec cannot decode.
    return ok(integrationBody(app));
  },
};

function rulesConnection(state: MockState): GraphqlHandlerResult {
  return {
    data: {
      repository: {
        branchProtectionRules: {
          nodes: allRuleNodes(state),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

export const branchesMockGraphqlHandlers: SectionGraphqlHandlers<"branches"> = {
  "branches.rulesQuery": ({ state }) => rulesConnection(state),
  // The snapshot's read serves the same union of literal and wildcard rules.
  "branches.rulesSnapshot": ({ state }) => rulesConnection(state),
  "branches.repoLookup": ({ state }) => ({
    data: { repository: { id: repoNodeId(state) } },
  }),
  "branches.actorUser": ({ state, variables }) => {
    const login = String((variables as Json).login ?? "");
    // GitHub logins are case-insensitive: any spelling resolves, and the minted id carries the
    // CANONICAL roster login so read-backs echo the canonical form like production.
    const canonical = BYPASS_ACTOR_USERS.find(
      (known) => known.toLowerCase() === login.toLowerCase(),
    );
    if (canonical === undefined) {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a User with the login of '${login}'.`,
          },
        ],
      };
    }
    const slug = state.slug;
    return {
      data: {
        repository: { id: repoNodeId(state) },
        user: { id: mintNodeId("user", slug, canonical) },
      },
    };
  },
  "branches.actorTeam": ({ state, variables }) => {
    const org = String((variables as Json).org ?? "");
    const team = String((variables as Json).team ?? "");
    const combinedFold = `${org}/${team}`.toLowerCase();
    if (
      !BYPASS_ACTOR_TEAMS.some((entry) => entry.toLowerCase().startsWith(`${org.toLowerCase()}/`))
    ) {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to an Organization with the login of '${org}'.`,
          },
        ],
      };
    }
    const repository = { id: repoNodeId(state) };
    const canonical = BYPASS_ACTOR_TEAMS.find((entry) => entry.toLowerCase() === combinedFold);
    if (canonical === undefined) {
      // A known org with an unknown team is a NULLABLE-FIELD miss, not an errors[] entry, matching
      // GitHub's Organization.team shape.
      return { data: { repository, organization: { team: null } } };
    }
    const slug = state.slug;
    return {
      data: {
        repository,
        organization: { team: { id: mintNodeId("team", slug, canonical) } },
      },
    };
  },
  "branches.createRule": ({ state, variables }) => {
    const input = asObject((variables as Json).input);
    const pattern = String(input.pattern ?? "");
    if (allRuleNodes(state).some((node) => String(node.pattern) === pattern)) {
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `A branch protection rule with the pattern '${pattern}' already exists.`,
          },
        ],
      };
    }
    const stored = completeRule({ pattern });
    const applied = applyRuleInput(stored, input, state);
    if ("bad" in applied) {
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Could not resolve to a node with the global id of '${applied.bad}'.`,
          },
        ],
      };
    }
    const slug = state.slug;
    stored.id = mintNodeId("rule", slug, String(stored.pattern));
    state.branch_protection_rules.push(stored);
    return {
      data: { createBranchProtectionRule: { branchProtectionRule: ruleWireNode(stored) } },
    };
  },
  "branches.updateRule": ({ state, variables }) => {
    const input = asObject((variables as Json).input);
    const id = String(input.branchProtectionRuleId ?? "");
    const decoded = decodeNodeId(id);
    const notFound: GraphqlHandlerResult = {
      errors: [
        {
          type: "NOT_FOUND",
          message: `Could not resolve to a node with the global id of '${id}'.`,
        },
      ],
    };
    if (decoded?.family !== "rule") {
      return notFound;
    }
    const pattern = decoded.key;
    const slug = state.slug;
    const wildcard = state.branch_protection_rules.find((rule) => rule.pattern === pattern);
    if (wildcard) {
      const applied = applyRuleInput(wildcard, input, state);
      if ("bad" in applied) {
        return {
          errors: [
            {
              type: "UNPROCESSABLE",
              message: `Could not resolve to a node with the global id of '${applied.bad}'.`,
            },
          ],
        };
      }
      // The id embeds the pattern, so a pattern change re-mints it, exactly like stampNodeIds would.
      wildcard.id = mintNodeId("rule", slug, String(wildcard.pattern));
      return {
        data: { updateBranchProtectionRule: { branchProtectionRule: ruleWireNode(wildcard) } },
      };
    }
    const protection = state.branch_protection[pattern];
    if (!protection) {
      return notFound;
    }
    const applied = applyRuleInputToLiteral(state, pattern, input);
    if ("bad" in applied) {
      return {
        errors: [
          {
            type: "UNPROCESSABLE",
            message: `Could not resolve to a node with the global id of '${applied.bad}'.`,
          },
        ],
      };
    }
    return {
      data: {
        updateBranchProtectionRule: {
          branchProtectionRule: ruleFromProtection(
            pattern,
            protection,
            state.branch_protection_graphql[pattern],
            slug,
          ),
        },
      },
    };
  },
  "branches.deleteRule": ({ state, variables }) => {
    const input = asObject((variables as Json).input);
    const id = String(input.branchProtectionRuleId ?? "");
    const decoded = decodeNodeId(id);
    if (decoded?.family !== "rule") {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a node with the global id of '${id}'.`,
          },
        ],
      };
    }
    const pattern = decoded.key;
    const index = state.branch_protection_rules.findIndex((rule) => rule.pattern === pattern);
    if (index >= 0) {
      state.branch_protection_rules.splice(index, 1);
    } else if (state.branch_protection[pattern]) {
      // Deleting a literal rule through GraphQL removes the protection the REST view serves:
      // GitHub's one underlying rule.
      state.branch_protection[pattern] = null;
      delete state.branch_protection_graphql[pattern];
    } else {
      return {
        errors: [
          {
            type: "NOT_FOUND",
            message: `Could not resolve to a node with the global id of '${id}'.`,
          },
        ],
      };
    }
    return { data: { deleteBranchProtectionRule: { clientMutationId: null } } };
  },
};
