/**
 * An octokit gap: its routes are declarable (SupplementalRoute) though the pinned @octokit/types lacks them, and
 * stay out of the descriptor slice the e2e validator loads while GitHub's OpenAPI description lacks them too.
 * ./gap.ts states how the file graduates.
 */

import { defineGap, type OctokitLacks } from "./gap.js";

/** GitHub shipped the Git LFS repository toggle; @octokit/types does not carry these routes yet, nor does the published OpenAPI description. */
export const GAP = defineGap({
  routes: ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"],
  documentedInSpec: false,
});

/** Fires when @octokit/types gains any of these routes: the graduate script retires this file per its documentedInSpec lifecycle. */
type _GraduateThisFileOnceOctokitShipsIt = OctokitLacks<typeof GAP>;
