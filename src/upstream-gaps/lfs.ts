import { defineGap, type OctokitLacks } from "./gap.js";

/** GitHub shipped the Git LFS repository toggle; @octokit/types does not carry these routes yet, nor does the published OpenAPI description. */
export const GAP = defineGap({
  routes: ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"],
  documentedInSpec: false,
});

/** Fires when @octokit/types gains any of these routes: the graduate script retires this file per its documentedInSpec lifecycle. */
type _GraduateThisFileOnceOctokitShipsIt = OctokitLacks<typeof GAP>;
