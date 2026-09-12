/**
 * The branches e2e mock fragment (aggregated in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { createHash } from "node:crypto";
import { decodeNodeId, mintNodeId } from "../../../test/e2e/mock/node-id.js";
import {
  allRuleNodes,
  applyRuleInput,
  applyRuleInputToLiteral,
  BYPASS_ACTOR_TEAMS,
  BYPASS_ACTOR_USERS,
  completeRule,
  PROTECTION_RULE_APPS,
  protectionFromPut,
  ruleFromProtection,
  ruleWireNode,
} from "../../../test/e2e/mock/state.js";
import {
  asObject,
  type GraphqlHandlerResult,
  integrationBody,
  type Json,
  noContent,
  ok,
  rejected,
  repoNodeId,
  type SectionGraphqlHandlers,
  type SectionRestHandlers,
  slicePage,
} from "../../../test/e2e/mock/support.js";
import { MISSING_BRANCH } from "./endpoints.js";

export const branchesMockHandlers: SectionRestHandlers<"branches"> = {
  "branches.listProtected": ({ state, param, query }) => {
    const protectedNames = Object.entries(state.branch_protection)
      .filter(([, protection]) => protection !== null)
      .map(([name]) => name);
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
    const branch = param("branch");
    const protection = state.branch_protection[branch];
    if (!protection) {
      return { status: 404, body: { message: "Branch not protected" } };
    }
    return ok(protection);
  },
  "branches.putProtection": ({ state, param, body }) => {
    const branch = param("branch");
    if (!state.branches.includes(branch)) {
      return rejected(MISSING_BRANCH);
    }
    const stored = protectionFromPut(asObject(body));
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

export const branchesMockGraphqlHandlers: SectionGraphqlHandlers<"branches"> = {
  "branches.rulesQuery": ({ state }) => ({
    data: {
      repository: {
        branchProtectionRules: {
          nodes: allRuleNodes(state),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }),
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
