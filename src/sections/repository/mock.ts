/**
 * The repository e2e mock fragment (aggregated in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { decodeNodeId } from "../../../test/e2e/mock/node-id.js";
import { restRepoSurface } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  booleanToggleGet,
  IMMUTABLE_OWNER_CONFLICT,
  noContent,
  ok,
  repoFeatureFields,
  repoNodeId,
  type SectionGraphqlHandlers,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

// Every repo body a REST handler serves, and the PATCH body it accepts, goes through
// restRepoSurface, which strips the GraphQL-only fields, so the REST paths stay as blind to them as GitHub's.
export const repositoryMockHandlers: SectionRestHandlers<"repository"> = {
  "repository.get": ({ state }) => ok(restRepoSurface(state.repo)),
  "repository.update": ({ state, body }) => {
    Object.assign(state.repo, restRepoSurface(asObject(body)));
    return ok(restRepoSurface(state.repo));
  },
  "repository.topics": ({ state, body }) => {
    const names = asObject(body).names;
    state.repo.topics = Array.isArray(names) ? names : [];
    return ok({ names: state.repo.topics });
  },
  "repository.vulnerabilityAlertsGet": ({ state }) =>
    booleanToggleGet(state.repo.vulnerability_alerts_enabled === true),
  "repository.vulnerabilityAlertsPut": ({ state }) => {
    state.repo.vulnerability_alerts_enabled = true;
    return noContent();
  },
  "repository.vulnerabilityAlertsRemove": ({ state }) => {
    state.repo.vulnerability_alerts_enabled = false;
    return noContent();
  },
  "repository.automatedSecurityFixesGet": ({ state }) => {
    if (state.repo.automated_security_fixes_enabled === undefined) {
      // The spec documents this 404 (feature not enabled) with NO content.
      return { status: 404, body: null };
    }
    return ok({ enabled: state.repo.automated_security_fixes_enabled === true, paused: false });
  },
  "repository.automatedSecurityFixesPut": ({ state }) => {
    state.repo.automated_security_fixes_enabled = true;
    return noContent();
  },
  "repository.automatedSecurityFixesRemove": ({ state }) => {
    state.repo.automated_security_fixes_enabled = false;
    return noContent();
  },
  "repository.privateVulnerabilityReportingGet": ({ state }) => {
    // Where the feature is not applicable (observed on private repos) the GET answers its declared
    // 404, which the section reads as "not enabled"; the flag is set via live_state.repo.
    if (state.repo.private_vulnerability_reporting_not_applicable === true) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok({ enabled: state.repo.private_vulnerability_reporting_enabled === true });
  },
  "repository.privateVulnerabilityReportingPut": ({ state }) => {
    state.repo.private_vulnerability_reporting_enabled = true;
    return noContent();
  },
  "repository.privateVulnerabilityReportingRemove": ({ state }) => {
    // Disabling where the feature does not apply answers the declared 404 ("already off") rather
    // than 204, which the section tolerates.
    if (state.repo.private_vulnerability_reporting_not_applicable === true) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.repo.private_vulnerability_reporting_enabled = false;
    return noContent();
  },
  "repository.immutableReleasesGet": ({ state }) => {
    const enforced = state.repo.immutable_releases_enforced_by_owner === true;
    if (state.repo.immutable_releases_enabled !== true && !enforced) {
      // The spec documents this 404 (feature not enabled) with NO content.
      return { status: 404, body: null };
    }
    return ok({ enabled: true, enforced_by_owner: enforced });
  },
  "repository.immutableReleasesPut": ({ state }) => {
    if (state.repo.immutable_releases_enforced_by_owner === true) {
      return IMMUTABLE_OWNER_CONFLICT;
    }
    state.repo.immutable_releases_enabled = true;
    return noContent();
  },
  "repository.immutableReleasesRemove": ({ state }) => {
    if (state.repo.immutable_releases_enforced_by_owner === true) {
      return IMMUTABLE_OWNER_CONFLICT;
    }
    state.repo.immutable_releases_enabled = false;
    return noContent();
  },
  "repository.lfsPut": () => ({ status: 202, body: null }),
  "repository.lfsRemove": () => noContent(),
};

// The two GraphQL-only repo settings are stored on state.repo but invisible to every REST handler.
export const repositoryMockGraphqlHandlers: SectionGraphqlHandlers<"repository"> = {
  "repository.featuresQuery": ({ state }) => ({
    data: { repository: { id: repoNodeId(state), ...repoFeatureFields(state) } },
  }),
  "repository.updateFeatures": ({ state, variables }) => {
    const { repositoryId, hasSponsorshipsEnabled, issueCreationPolicy } = variables as {
      repositoryId?: unknown;
      hasSponsorshipsEnabled?: unknown;
      issueCreationPolicy?: unknown;
    };
    // The pipeline already resolved the id to this state's slug; the family is this handler's own
    // concern, since a decodable non-repo id (an environment's, say) would silently update the wrong resource.
    const decoded = decodeNodeId(String(repositoryId ?? ""));
    if (decoded?.family !== "repo") {
      throw new Error(
        `E2E MOCK: UpdateRepositoryFeatures got repositoryId of family "${String(decoded?.family)}", expected a repo node id`,
      );
    }
    if (typeof hasSponsorshipsEnabled === "boolean") {
      state.repo.has_sponsorships_enabled = hasSponsorshipsEnabled;
    }
    if (issueCreationPolicy === "ALL" || issueCreationPolicy === "COLLABORATORS_ONLY") {
      state.repo.issue_creation_policy = issueCreationPolicy;
    }
    return { data: { updateRepository: { repository: repoFeatureFields(state) } } };
  },
};
