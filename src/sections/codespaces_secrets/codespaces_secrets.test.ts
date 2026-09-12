// This family's own facts only; the shared skeleton and the engine pins live in test/sections/.

import { pinSecretFamily } from "../../../test/sections/secret-family.js";
import { codespacesSecretsSection } from "./index.js";

pinSecretFamily({
  section: codespacesSecretsSection,
  segment: "codespaces",
  keyId: "cs-key",
  noun: "Codespaces secret",
  secretName: "DOTFILES_PAT",
});
