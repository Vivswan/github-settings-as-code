/**
 * Every pending upstream gap, aggregated. SCRIPT-OWNED STRICT LAYOUT: each
 * gap contributes exactly one import line and one GAPS array element line,
 * both spelling the camelCase of its file name; when a gap file's tripwire
 * fires (octokit shipped the routes), the graduate script deletes that file
 * and its two lines here. The derivations below degrade gracefully to an
 * empty set, so this file itself never needs deleting.
 */

import { GAP as agentsSecrets } from "./agents-secrets.js";
import { GAP as agentsVariables } from "./agents-variables.js";
import { GAP as codeQualitySetup } from "./code-quality-setup.js";
import { undocumentedRoutes } from "./gap.js";
import { GAP as interactionLimitPullCaps } from "./interaction-limit-pull-caps.js";
import { GAP as lfs } from "./lfs.js";
import { GAP as secretScanningCustomPatterns } from "./secret-scanning-custom-patterns.js";

const GAPS = [
  agentsSecrets,
  agentsVariables,
  codeQualitySetup,
  interactionLimitPullCaps,
  lfs,
  secretScanningCustomPatterns,
] as const;

/**
 * Routes GitHub documents but the pinned @octokit/types release does not
 * carry yet. Only the route STRING is consumed (never octokit's
 * parameter/response typing), so the literal union defineGap preserves is
 * enough; an empty GAPS degrades it to never.
 */
export type SupplementalRoute = (typeof GAPS)[number]["routes"][number];

/**
 * The supplemental routes GitHub's api.github.com OpenAPI descriptor does
 * not document either (documentedInSpec: false; LFS only today). Consumed by
 * test/e2e/openapi/paths.ts, which excludes their paths from the spec trim
 * and exempts exactly these METHOD+path pairs from the e2e unknown-route
 * check.
 */
export const UNDOCUMENTED_ROUTES: readonly SupplementalRoute[] =
  undocumentedRoutes<SupplementalRoute>(GAPS);
