/** The dependabot_secrets entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { sealedSecretConfig } from "../shared/schema-helpers.js";

export const DependabotSecretConfig = sealedSecretConfig(
  "DependabotSecretConfig",
  "One repository Dependabot secret, matched by case-insensitive name (GitHub stores secret names uppercase). Keys other than name and value are rejected: the API body is built from the sealed value alone, so an extra key would silently do nothing.",
);
export type DependabotSecretConfig = z.infer<typeof DependabotSecretConfig>;
