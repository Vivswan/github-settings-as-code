/**
 * The mode-agnostic input readers: inputs() wraps a caller-supplied port so every port trims and defaults by one rule,
 * and each read*() validates one input or one group of inputs into a Result the per-mode parsers compose.
 */

import { err, ok, type Result, safeTry } from "neverthrow";
import {
  AFFILIATIONS,
  ARCHIVED_FILTERS,
  DEFAULT_DISCOVERY_FILTERS,
  type DiscoveryFilters,
  FORKS_FILTERS,
  VISIBILITY_FILTERS,
} from "../discovery/discover.js";
import { compileExcludePattern, type ExcludePattern } from "../discovery/exclude-pattern.js";
import { LIST_SEPARATOR } from "../discovery/repos-input.js";
import { parseRepoSlug, type RepoRef } from "../discovery/targets.js";
import { UNDECLARED_POLICIES } from "../engine/layers.js";
import { SectionSelection } from "../engine/section-selection.js";
import type { Problem } from "../problem.js";
import { parseRecipient } from "../report/artifact-report.js";
import type { PrivateReportChannel } from "../report/delivery.js";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import type { UndeclaredPolicy } from "../types.js";
import {
  type ConfigEnv,
  FILTER_INPUTS,
  INPUT_DECLS,
  type InputName,
  type InputReader,
  type ListInput,
} from "./inputs.js";
import { PRIVATE_REPOS_POLICIES, type PrivateReposPolicy } from "./redact.js";

export interface Inputs {
  readonly value: InputReader;
  readonly orDefault: (name: InputName) => string;
  /** A declared list input, split; the default when unset. */
  readonly list: (name: ListInput) => string[];
}

export function inputs(read: InputReader): Inputs {
  // The runner's getInput trims; a CLI's port may not. Trimming here gives every port one rule.
  const value: InputReader = (name) => read(name).trim();
  const orDefault = (name: InputName): string => value(name) || INPUT_DECLS[name].default;
  return { value, orDefault, list: (name) => splitList(orDefault(name)) };
}
/**
 * An enum input: unset reads as `fallback`, which is one of the values or, for an input whose unset state means "no
 * value" (`undeclared` leaves each list its own default), undefined.
 */
export function readEnum<T extends string, F extends T | undefined>(
  input: Inputs,
  name: InputName,
  allowed: readonly T[],
  fallback: F,
  noun: string,
): Result<T | F, Problem> {
  const value = input.value(name);
  if (value === "") {
    return ok(fallback);
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    return err({
      code: "input-unsupported-value",
      input: name,
      value,
      noun,
      allowed,
      fallback: fallback ?? null,
    });
  }
  return ok(match);
}

export function readUndeclared(input: Inputs): Result<UndeclaredPolicy | undefined, Problem> {
  return readEnum(input, "undeclared", UNDECLARED_POLICIES, undefined, "undeclared policy");
}

function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}
function readSectionSelection(input: Inputs): Result<SectionSelection, Problem> {
  const sectionInputs = ["required-sections", "sections"] as const;
  const names = sectionInputs.map((name) => ({
    input: name,
    names: input.list(name),
  }));
  const knownSections = new Set<string>(SECTION_KEYS);
  const unknown = names
    .map(({ input: name, names: listed }) => ({
      input: name,
      names: [...new Set(listed)].filter((entry) => !knownSections.has(entry)),
    }))
    .filter((entry) => entry.names.length > 0);
  if (unknown.length > 0) {
    return err({ code: "input-unknown-sections", unknown, known: SECTION_KEYS });
  }
  const isSectionKey = (name: string): name is SectionKey => knownSections.has(name);
  const [required = [], only = []] = names.map((entry) => entry.names.filter(isSectionKey));
  return SectionSelection.of({ only, required });
}

/**
 * The key is required exactly when the channel is `artifact` and rejected otherwise (set for another channel it would
 * silently do nothing); it is parsed through the age library here so a malformed recipient fails before any API work.
 */
export function resolveReportPublicKey(
  input: Inputs,
  channel: PrivateReportChannel,
): Result<string, Problem> {
  const key = input.value("report-public-key");
  if (channel !== "artifact") {
    return key ? err({ code: "input-report-key-unused", channel }) : ok("");
  }
  if (!key) {
    return err({ code: "input-report-key-missing" });
  }
  return parseRecipient(key)
    .map(() => key)
    .mapErr((invalid) => ({ code: "input-report-key-invalid", reason: invalid.reason }));
}
/** The token the API modes call with: the input, else the environment's. */
export function readToken(input: Inputs, env: ConfigEnv): Result<string, Problem> {
  const token = input.value("token") || env.GITHUB_TOKEN || "";
  return token ? ok(token) : err({ code: "input-token-missing" });
}

/** The policies every API mode reads, each validated against its own vocabulary. */
export function readPolicies(input: Inputs): Result<
  {
    onMissingPermission: "fail" | "warn";
    sections: SectionSelection;
    privateRepos: PrivateReposPolicy;
  },
  Problem
> {
  return safeTry(function* () {
    const onMissingPermission = yield* readEnum(
      input,
      "on-missing-permission",
      ["fail", "warn"] as const,
      INPUT_DECLS["on-missing-permission"].default,
      "policy",
    );
    const sections = yield* readSectionSelection(input);
    const privateRepos = yield* readEnum(
      input,
      "private-repos",
      PRIVATE_REPOS_POLICIES,
      INPUT_DECLS["private-repos"].default,
      "private-repository policy",
    );
    return ok({ onMissingPermission, sections, privateRepos });
  });
}

/** The validated filters plus the names the workflow set explicitly, which the misuse rejections name. */
export function readDiscoveryFilters(
  input: Inputs,
): Result<{ discoveryFilters: DiscoveryFilters; discoveryFiltersSet: string[] }, Problem> {
  return safeTry(function* () {
    const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input.value(name) !== "");
    const visibility = yield* readEnum(
      input,
      "visibility",
      VISIBILITY_FILTERS,
      DEFAULT_DISCOVERY_FILTERS.visibility,
      "discovery filter",
    );
    const archived = yield* readEnum(
      input,
      "archived",
      ARCHIVED_FILTERS,
      DEFAULT_DISCOVERY_FILTERS.archived,
      "archived-repository policy",
    );
    const forks = yield* readEnum(
      input,
      "forks",
      FORKS_FILTERS,
      DEFAULT_DISCOVERY_FILTERS.forks,
      "fork policy",
    );
    const affiliation = [...new Set(input.list("affiliation"))];
    const unsupported = affiliation.find(
      (entry) => !(AFFILIATIONS as readonly string[]).includes(entry),
    );
    if (unsupported !== undefined) {
      return err({
        code: "input-affiliation-unsupported",
        entry: unsupported,
        allowed: AFFILIATIONS,
      });
    }
    const exclude: ExcludePattern[] = [];
    for (const pattern of input.list("exclude")) {
      exclude.push(yield* compileExcludePattern(pattern));
    }
    const discoveryFilters: DiscoveryFilters = {
      visibility,
      archived,
      forks,
      affiliation: affiliation.length > 0 ? affiliation : DEFAULT_DISCOVERY_FILTERS.affiliation,
      topics: input.list("topics").map((topic) => topic.toLowerCase()),
      exclude,
    };
    return ok({ discoveryFilters, discoveryFiltersSet });
  });
}

/** The single-repo target: the repository input, else the workflow's own repository. */
export function readSingleTarget(
  input: Inputs,
  githubRepository: string,
): Result<RepoRef, Problem> {
  const rawRepo = input.value("repository") || githubRepository;
  return parseRepoSlug(rawRepo).mapErr(
    (): Problem => ({ code: "input-repository-not-slug", value: rawRepo }),
  );
}
