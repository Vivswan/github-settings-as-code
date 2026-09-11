/**
 * The interaction_limits section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genInteractionLimits(rng: Rng): Json | null {
  // null (a clear) is a first-class declared value, like pages: null.
  if (rng.bool(0.2)) {
    return null;
  }
  const limits: Json = {
    limit: rng.pick(["existing_users", "contributors_only", "collaborators_only"]),
  };
  if (rng.bool()) {
    limits.expiry = rng.pick(["one_day", "three_days", "one_week", "one_month", "six_months"]);
  }
  // The pulls keys are NEW draws appended after the original body, each on
  // its own forked stream, so pre-existing seeds keep producing the same
  // document above (the seed-stability convention; see genActions).
  const capRng = rng.fork("pulls-cap");
  if (capRng.bool(0.3)) {
    const cap: Json = { enabled: capRng.bool() };
    if (capRng.bool()) {
      cap.max_open_pull_requests = capRng.pick([1, 5, 100, 1000]);
    }
    limits.pull_request_creation_cap = cap;
  }
  const bypassRng = rng.fork("pulls-bypass");
  if (bypassRng.bool(0.3)) {
    // Unique under the case-insensitive login key. The uppercase draw buys
    // shape variety only: fuzz live lists originate from declared PUTs, so a
    // live/declared case mismatch never arises here; the case-insensitive
    // match is pinned by the curated bypass add-remove scenario and the
    // section's unit tests.
    const logins = Array.from({ length: bypassRng.int(3) }, (_, i) => {
      const login = `${bypassRng.pick(["octocat", "hubot", "dev"])}-${i}`;
      return bypassRng.bool(0.3) ? login.toUpperCase() : login;
    });
    limits.pull_request_creation_bypass = logins;
  }
  // A pulls-only document (no base group at all) is valid and takes the
  // apply path that skips the base PUT entirely; dropping the base keys is
  // its own forked draw so documents whose pulls forks decline are
  // untouched. Both base keys go together: expiry without limit is invalid.
  if (
    (limits.pull_request_creation_cap !== undefined ||
      limits.pull_request_creation_bypass !== undefined) &&
    rng.fork("pulls-only").bool(0.25)
  ) {
    delete limits.limit;
    delete limits.expiry;
  }
  return limits;
}
