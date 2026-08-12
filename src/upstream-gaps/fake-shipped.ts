import type { Endpoints } from "@octokit/types";
import type { MustBeNever } from "../schema.js";
import { defineGap } from "./gap.js";

/** Live-test probe: this route already exists in @octokit/types, so the tripwire must fire. */
export const GAP = defineGap({
  routes: ["GET /repos/{owner}/{repo}"],
  documentedInSpec: true,
});

/** Fires when @octokit/types gains any of these routes: DELETE THIS FILE and its two lines in index.ts. */
type _DeleteThisFileOnceOctokitShipsIt = MustBeNever<Extract<(typeof GAP.routes)[number], keyof Endpoints>>;
