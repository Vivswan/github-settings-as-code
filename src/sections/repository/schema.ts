/** The `repository:` section's entry-config declaration (see src/schema.ts). */

import type { components, operations } from "@octokit/openapi-types";
import { z } from "zod";
import type { MustBeNever } from "../../types.js";
import { conditional } from "../shared/schema-helpers.js";

/**
 * JSON.stringify on an arbitrary YAML value would throw on a cyclic alias and kill the run before
 * the normal failure path, so containers describe by kind only; strings stay quoted so a YAML "no"
 * is visibly a string.
 */
function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (typeof value === "object") {
    return "a mapping";
  }
  return String(value);
}

function repositoryToggle() {
  return z
    .boolean({
      error: (issue) =>
        issue.input === null
          ? "null is not a boolean, and a toggle has no empty state; write true or false"
          : `${describeValue(issue.input)} is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)`,
    })
    .optional();
}

/** A PATCH string field; the callers that take null as "clear it" add `.nullable()` with the hint. */
function patchString(hint = "") {
  return z.string({
    error: (issue) => `${describeValue(issue.input)} is not a string; quote the value${hint}`,
  });
}

const CLEARABLE = patchString(", or write null to clear the field").nullable().optional();

/** The repo PATCH body as GitHub documents it: the fields the passthrough can send back. */
export type RepoPatchBody = NonNullable<
  operations["repos/update"]["requestBody"]
>["content"]["application/json"];

/** PATCH fields the API accepts (verified live) that its OpenAPI descriptor omits, so the pin cannot see them. */
export type UndocumentedPatchField = "has_discussions";

/** A PATCH field the spec types as boolean; the undocumented one is a boolean by the REST reference. */
type PatchToggleKey =
  | {
      [K in keyof RepoPatchBody]-?: NonNullable<RepoPatchBody[K]> extends boolean ? K : never;
    }[keyof RepoPatchBody]
  | UndocumentedPatchField;

type FullRepository = components["schemas"]["full-repository"];

/** A field the GET reports that no write accepts: not the PATCH, and not topics' own PUT. */
type GetOnlyKey = Exclude<
  keyof FullRepository,
  keyof RepoPatchBody | UndocumentedPatchField | "topics"
>;

/**
 * Declared, a GET-only key drifts on every run: the diff sees the live value, the PATCH ignores the
 * field, and nothing converges. Pinned both ways to the vendored spec, so a GET field appearing in the
 * PATCH body drops out here at compile time and a new GET-only field fails to compile until listed.
 */
const GET_ONLY_KEYS = [
  "id",
  "node_id",
  "full_name",
  "owner",
  "html_url",
  "fork",
  "url",
  "archive_url",
  "assignees_url",
  "blobs_url",
  "branches_url",
  "collaborators_url",
  "comments_url",
  "commits_url",
  "compare_url",
  "contents_url",
  "contributors_url",
  "deployments_url",
  "downloads_url",
  "events_url",
  "forks_url",
  "git_commits_url",
  "git_refs_url",
  "git_tags_url",
  "git_url",
  "issue_comment_url",
  "issue_events_url",
  "issues_url",
  "keys_url",
  "labels_url",
  "languages_url",
  "merges_url",
  "milestones_url",
  "notifications_url",
  "pulls_url",
  "releases_url",
  "ssh_url",
  "stargazers_url",
  "statuses_url",
  "subscribers_url",
  "subscription_url",
  "tags_url",
  "teams_url",
  "trees_url",
  "clone_url",
  "mirror_url",
  "hooks_url",
  "svn_url",
  "language",
  "forks_count",
  "stargazers_count",
  "watchers_count",
  "size",
  "open_issues_count",
  "has_pages",
  "has_downloads",
  "disabled",
  "pushed_at",
  "created_at",
  "updated_at",
  "permissions",
  "template_repository",
  "temp_clone_token",
  "subscribers_count",
  "network_count",
  "license",
  "organization",
  "parent",
  "source",
  "forks",
  "master_branch",
  "open_issues",
  "watchers",
  "anonymous_access_enabled",
  "code_of_conduct",
  "custom_properties",
] as const satisfies readonly GetOnlyKey[];

type _GetOnlyKeysComplete = MustBeNever<Exclude<GetOnlyKey, (typeof GET_ONLY_KEYS)[number]>>;

/** GET-only keys another section writes; the refusal points there instead of at the API. */
const SECTION_OWNED_KEYS: Partial<Record<GetOnlyKey, string>> = {
  custom_properties: "custom_properties",
  has_pages: "pages",
};

function getOnlyKeyMessage(key: GetOnlyKey): string {
  const section = SECTION_OWNED_KEYS[key];
  return section === undefined
    ? `${key} is reported by GitHub but cannot be set through the API; remove it`
    : `${key} is reported by GitHub but cannot be set through the repository PATCH; declare it in the ${section} section instead`;
}

// --- security_and_analysis ------------------------------------------------------

type SecurityAndAnalysisPatch = NonNullable<RepoPatchBody["security_and_analysis"]>;

/** A nested key the API accepts (see the coverage notes) that the descriptor's PATCH body omits. */
type UndocumentedSecurityField = "secret_scanning_validity_checks";

type BypassReviewer = NonNullable<
  NonNullable<SecurityAndAnalysisPatch["secret_scanning_delegated_bypass_options"]>["reviewers"]
>[number];

const REVIEWER_TYPES = [
  "TEAM",
  "ROLE",
] as const satisfies readonly BypassReviewer["reviewer_type"][];
type _ReviewerTypesComplete = MustBeNever<
  Exclude<BypassReviewer["reviewer_type"], (typeof REVIEWER_TYPES)[number]>
>;

const REVIEWER_MODES = ["ALWAYS", "EXEMPT"] as const satisfies readonly NonNullable<
  BypassReviewer["mode"]
>[];
type _ReviewerModesComplete = MustBeNever<
  Exclude<NonNullable<BypassReviewer["mode"]>, (typeof REVIEWER_MODES)[number]>
>;

/** The `status` vocabulary the GET reports; the PATCH descriptor types it as a bare string. */
const FeatureStatus = z.enum(["enabled", "disabled"], {
  error: (issue) =>
    `${describeValue(issue.input)} is not a feature status; use "enabled" or "disabled"`,
});

const listKeys = (keys: readonly string[]) => keys.map((key) => JSON.stringify(key)).join(", ");

/** GitHub answers 422 to an unknown sub-key here, so the closed shape says so before any request. */
function closedKeyError(
  what: string,
  known: readonly string[],
  hint: (key: string) => string | undefined = () => undefined,
) {
  return (issue: z.core.$ZodRawIssue): string | undefined => {
    if (issue.code !== "unrecognized_keys") {
      return undefined;
    }
    return issue.keys
      .map(
        (key) =>
          hint(key) ??
          `${JSON.stringify(key)} is not a key ${what} accepts (GitHub rejects it with a 422); remove it. Known keys: ${listKeys(known)}`,
      )
      .join("; ");
  };
}

const featureToggleShape = { status: FeatureStatus.optional() };

const FeatureToggle = z
  .strictObject(featureToggleShape, {
    error: closedKeyError("a security_and_analysis feature", Object.keys(featureToggleShape)),
  })
  .meta({ id: "SecurityFeatureToggle" });

const bypassReviewerShape = {
  reviewer_id: z.int(),
  reviewer_type: z.enum(REVIEWER_TYPES),
  mode: z.enum(REVIEWER_MODES).optional(),
};

const bypassOptionsShape = {
  reviewers: z
    .array(
      z.strictObject(bypassReviewerShape, {
        error: closedKeyError("a bypass reviewer", Object.keys(bypassReviewerShape)),
      }),
    )
    .optional(),
};

const securityAndAnalysisShape = {
  advanced_security: FeatureToggle.optional(),
  code_security: FeatureToggle.optional(),
  secret_scanning: FeatureToggle.optional(),
  secret_scanning_push_protection: FeatureToggle.optional(),
  secret_scanning_ai_detection: FeatureToggle.optional(),
  secret_scanning_non_provider_patterns: FeatureToggle.optional(),
  secret_scanning_delegated_alert_dismissal: FeatureToggle.optional(),
  secret_scanning_delegated_bypass: FeatureToggle.optional(),
  secret_scanning_delegated_bypass_options: z
    .strictObject(bypassOptionsShape, {
      error: closedKeyError(
        "secret_scanning_delegated_bypass_options",
        Object.keys(bypassOptionsShape),
      ),
    })
    .optional(),
  secret_scanning_validity_checks: FeatureToggle.optional(),
} satisfies Record<keyof SecurityAndAnalysisPatch | UndocumentedSecurityField, z.ZodType>;

/** The sub-keys the PATCH accepts, in lockstep with the shape; the snapshot reads exactly these back. */
export const SECURITY_AND_ANALYSIS_PATCH_FIELDS = Object.keys(
  securityAndAnalysisShape,
) as readonly (keyof typeof securityAndAnalysisShape)[];

/** The GET's dependabot_security_updates is the automated-security-fixes toggle, which has its own key. */
const securityAndAnalysisHint = (key: string): string | undefined =>
  key === "dependabot_security_updates"
    ? `"dependabot_security_updates" is reported by GitHub here but the PATCH rejects it; declare enable_automated_security_fixes instead`
    : undefined;

const SecurityAndAnalysisConfig = z
  .strictObject(securityAndAnalysisShape, {
    error: closedKeyError(
      "security_and_analysis",
      SECURITY_AND_ANALYSIS_PATCH_FIELDS,
      securityAndAnalysisHint,
    ),
  })
  .meta({ id: "SecurityAndAnalysisConfig" });

// --- Commit message defaults ---------------------------------------------------

type CommitMessageKey =
  | "squash_merge_commit_title"
  | "squash_merge_commit_message"
  | "merge_commit_title"
  | "merge_commit_message";

type CommitMessageValue<K extends CommitMessageKey> = NonNullable<RepoPatchBody[K]>;

/** Each field's vocabulary, pinned both ways to the vendored spec: no extras by satisfies, no gaps by the pin. */
const COMMIT_MESSAGE_VOCABULARIES = {
  squash_merge_commit_title: ["PR_TITLE", "COMMIT_OR_PR_TITLE"],
  squash_merge_commit_message: ["PR_BODY", "BLANK", "COMMIT_MESSAGES"],
  merge_commit_title: ["PR_TITLE", "MERGE_MESSAGE"],
  merge_commit_message: ["PR_BODY", "BLANK", "PR_TITLE"],
} as const satisfies { [K in CommitMessageKey]: readonly CommitMessageValue<K>[] };
type _CommitMessageVocabulariesComplete = MustBeNever<
  {
    [K in CommitMessageKey]: Exclude<
      CommitMessageValue<K>,
      (typeof COMMIT_MESSAGE_VOCABULARIES)[K][number]
    >;
  }[CommitMessageKey]
>;

type Vocabulary<K extends CommitMessageKey> = (typeof COMMIT_MESSAGE_VOCABULARIES)[K][number];

/**
 * The squash pairs GitHub documents: any other title/message pair answers 422
 * (invalid_squash_commit_setting_combo). The merge family has no documented matrix, so it gets none.
 */
const SQUASH_COMMIT_PAIRS = {
  PR_TITLE: ["PR_BODY", "BLANK", "COMMIT_MESSAGES"],
  COMMIT_OR_PR_TITLE: ["COMMIT_MESSAGES"],
} as const satisfies Record<
  Vocabulary<"squash_merge_commit_title">,
  readonly Vocabulary<"squash_merge_commit_message">[]
>;

type PairTable = Readonly<Record<string, readonly string[]>>;

function legalPairs(pairs: PairTable): string {
  return Object.entries(pairs)
    .map(([title, messages]) => `${title} with ${messages.join(" or ")}`)
    .join("; ");
}

/** What the pair refinement needs of a family; the enums themselves stay typed by their vocabularies. */
interface CommitMessageFamily {
  readonly titleKey: string;
  readonly messageKey: string;
  /** Title to the messages it may pair with; undefined when GitHub documents no matrix. */
  readonly pairs: PairTable | undefined;
  readonly legalHint: string;
}

/**
 * A title/message pair of the merge settings. GitHub rejects a message declared without its title in
 * both families; the pair matrix applies only where GitHub documents one.
 */
function commitMessageFamily<
  TitleKey extends CommitMessageKey,
  MessageKey extends CommitMessageKey,
>(
  titleKey: TitleKey,
  messageKey: MessageKey,
  pairs?: Readonly<Record<Vocabulary<TitleKey>, readonly Vocabulary<MessageKey>[]>>,
) {
  const titles = COMMIT_MESSAGE_VOCABULARIES[titleKey];
  const messages = COMMIT_MESSAGE_VOCABULARIES[messageKey];
  const legalHint = pairs === undefined ? "" : `. Legal pairs: ${legalPairs(pairs)}`;
  return {
    titleKey,
    messageKey,
    pairs,
    legalHint,
    title: z.enum(titles, {
      error: (issue) =>
        `${describeValue(issue.input)} is not a ${titleKey} value; use ${listKeys(titles)}${legalHint}`,
    }),
    message: z.enum(messages, {
      error: (issue) =>
        `${describeValue(issue.input)} is not a ${messageKey} value; use ${listKeys(messages)}${legalHint}`,
    }),
  };
}

const SQUASH_COMMIT = commitMessageFamily(
  "squash_merge_commit_title",
  "squash_merge_commit_message",
  SQUASH_COMMIT_PAIRS,
);

const MERGE_COMMIT = commitMessageFamily("merge_commit_title", "merge_commit_message");

const COMMIT_MESSAGE_FAMILIES: readonly CommitMessageFamily[] = [SQUASH_COMMIT, MERGE_COMMIT];

function refineCommitMessagePairs(declared: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const family of COMMIT_MESSAGE_FAMILIES) {
    const title = declared[family.titleKey];
    const message = declared[family.messageKey];
    if (message === undefined) {
      continue;
    }
    if (title === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [family.messageKey],
        message: `${family.messageKey} needs ${family.titleKey} declared beside it (GitHub requires the pair)${family.legalHint}`,
      });
      continue;
    }
    // Both values passed their enums, or the refinement would not be running.
    const allowed = family.pairs?.[title as string];
    if (allowed !== undefined && !allowed.includes(message as string)) {
      ctx.addIssue({
        code: "custom",
        path: [family.messageKey],
        message: `${family.titleKey} ${String(title)} cannot pair with ${family.messageKey} ${String(message)} (GitHub answers 422)${family.legalHint}`,
      });
    }
  }
}

/**
 * The published-schema twins of refineCommitMessagePairs, read from the same tables: a message key requires its
 * title key beside it, and a title with a documented matrix narrows the message enum. A refinement does not reach
 * z.toJSONSchema, so these ride the section's meta (EnvironmentConfig attaches its twins the same way).
 */
function commitMessagePairRules(): Record<string, unknown>[] {
  return COMMIT_MESSAGE_FAMILIES.flatMap((family) => [
    conditional({ required: [family.messageKey] }, { required: [family.titleKey] }),
    ...Object.entries(family.pairs ?? {}).map(([title, messages]) =>
      conditional(
        { required: [family.titleKey], properties: { [family.titleKey]: { const: title } } },
        { properties: { [family.messageKey]: { enum: [...messages] } } },
      ),
    ),
  ]);
}

// --- Topics -----------------------------------------------------------------------

/**
 * GitHub's topic rule, matched on the declared spelling: 1 to 50 characters, each a letter, digit, or hyphen,
 * starting with a letter or digit. Uppercase passes and folds to lowercase on the wire (normalizeTopics), so the
 * grammar spells [A-Za-z]: the published schema cannot fold, and a lowercase-only pattern there would refuse the
 * `Copier` the runtime accepts. The pattern is the grammar on both sides; a refinement would not reach the schema.
 */
const TOPIC_GRAMMAR = "[A-Za-z0-9][A-Za-z0-9-]{0,49}";
const TOPIC_PATTERN = new RegExp(`^${TOPIC_GRAMMAR}$`);
/** The comma form: the same grammar per segment, with the whitespace around a segment trimmed away. */
const TOPIC_LIST_PATTERN = new RegExp(`^\\s*${TOPIC_GRAMMAR}\\s*(,\\s*${TOPIC_GRAMMAR}\\s*)*$`);
const MAX_TOPICS = 20;

function topicRefusal(name: string, where = ""): string {
  return name === ""
    ? `an empty topic${where} is not one GitHub accepts; drop the entry, or declare topics: [] to remove every topic`
    : `${JSON.stringify(name)}${where} is not a topic GitHub accepts: a topic is 1 to 50 characters, each a letter, digit, or hyphen, starting with a letter or digit (uppercase is lowercased on the wire)`;
}

/** Each declared topic in declaration order, trimmed in the comma form; an empty segment stays so a refusal can name it. */
function declaredTopics(raw: string | readonly string[]): string[] {
  return typeof raw === "string" ? raw.split(",").map((t) => t.trim()) : [...raw];
}

/** The wire form: lowercased and deduped. */
export function normalizeTopics(raw: string | readonly string[]): string[] {
  return [...new Set(declaredTopics(raw).map((t) => t.toLowerCase()))];
}

const topicName = z.string().regex(TOPIC_PATTERN, {
  error: (issue) => topicRefusal(String(issue.input)),
});

/** The comma form fails as one string, so the refusal names the segment at fault. */
const topicList = z.string().regex(TOPIC_LIST_PATTERN, {
  error: (issue) => {
    const segments = declaredTopics(String(issue.input));
    const index = segments.findIndex((segment) => !TOPIC_PATTERN.test(segment));
    const where = segments.length > 1 ? ` (entry ${index + 1} of the comma list)` : "";
    return topicRefusal(segments[index] ?? "", where);
  },
});

/**
 * The cap counts topics as GitHub stores them, distinct after the fold: `[ci, CI]` is one topic. JSON Schema
 * cannot count that, so the cap stays the runtime's alone; a maxItems would refuse a duplicate-laden list the
 * runtime accepts, which is the one direction the published schema must never take.
 */
function refineTopicCount(raw: string | readonly string[], ctx: z.RefinementCtx): void {
  const distinct = normalizeTopics(raw).length;
  if (distinct > MAX_TOPICS) {
    ctx.addIssue({
      code: "custom",
      message: `${distinct} topics declared; GitHub allows at most ${MAX_TOPICS}`,
    });
  }
}

// --- The PATCH body -----------------------------------------------------------------

type PullRequestCreationPolicy = NonNullable<RepoPatchBody["pull_request_creation_policy"]>;

/** The two-value vocabulary both creation policies share; pinned both ways to the PATCH's enum. */
const CREATION_POLICIES = [
  "all",
  "collaborators_only",
] as const satisfies readonly PullRequestCreationPolicy[];
type _CreationPoliciesComplete = MustBeNever<
  Exclude<PullRequestCreationPolicy, (typeof CREATION_POLICIES)[number]>
>;

function creationPolicy() {
  return z
    .enum(CREATION_POLICIES, {
      error: (issue) =>
        `${describeValue(issue.input)} is not a recognized policy. Use "all" (everyone) or "collaborators_only"`,
    })
    .optional();
}

/**
 * Every PATCH field but `name`, typed as the API takes it, so null and a quoted boolean fail at
 * parse instead of as GitHub's 422. `satisfies` pins the table both ways: a PATCH field missing here,
 * or a key the PATCH lacks, fails to compile. `name` stays passthrough and out of the snapshot: a
 * settings file reused on another repository would rename it.
 */
const patchFieldShape = {
  description: CLEARABLE,
  homepage: CLEARABLE,
  private: repositoryToggle(),
  // A free string: `internal` is valid on Enterprise, and the pinned spec omits it.
  visibility: patchString().optional(),
  // Nullable as the PATCH body documents it; the object form stays closed.
  security_and_analysis: SecurityAndAnalysisConfig.nullable().optional(),
  has_issues: repositoryToggle(),
  has_projects: repositoryToggle(),
  has_wiki: repositoryToggle(),
  has_discussions: repositoryToggle(),
  has_pull_requests: repositoryToggle(),
  pull_request_creation_policy: creationPolicy(),
  is_template: repositoryToggle(),
  default_branch: patchString().optional(),
  allow_squash_merge: repositoryToggle(),
  allow_merge_commit: repositoryToggle(),
  allow_rebase_merge: repositoryToggle(),
  allow_auto_merge: repositoryToggle(),
  delete_branch_on_merge: repositoryToggle(),
  allow_update_branch: repositoryToggle(),
  use_squash_pr_title_as_default: repositoryToggle(),
  squash_merge_commit_title: SQUASH_COMMIT.title.optional(),
  squash_merge_commit_message: SQUASH_COMMIT.message.optional(),
  merge_commit_title: MERGE_COMMIT.title.optional(),
  merge_commit_message: MERGE_COMMIT.message.optional(),
  archived: repositoryToggle(),
  allow_forking: repositoryToggle(),
  web_commit_signoff_required: repositoryToggle(),
} satisfies Record<Exclude<keyof RepoPatchBody, "name"> | UndocumentedPatchField, z.ZodType>;

/** The PATCH fields the snapshot reads back, in lockstep with the table above. */
export const PATCH_FIELDS = Object.keys(
  patchFieldShape,
) as readonly (keyof typeof patchFieldShape)[];

// --- The section --------------------------------------------------------------------

export const RepositoryConfig = z
  .looseObject({
    ...patchFieldShape,
    topics: z
      .union([topicList, z.array(topicName)])
      .superRefine(refineTopicCount)
      .optional(),
    enable_vulnerability_alerts: repositoryToggle(),
    enable_automated_security_fixes: repositoryToggle(),
    enable_private_vulnerability_reporting: repositoryToggle(),
    enable_git_lfs: repositoryToggle(),
    enable_immutable_releases: repositoryToggle(),
    enable_sponsorships: repositoryToggle(),
    issue_creation_policy: creationPolicy(),
  })
  .catchall(z.unknown())
  .superRefine((declared, ctx) => {
    // A refusal here, not a strict object: a field GitHub adds to the PATCH tomorrow must still pass through.
    for (const key of GET_ONLY_KEYS) {
      if (Object.hasOwn(declared, key)) {
        ctx.addIssue({ code: "custom", path: [key], message: getOnlyKeyMessage(key) });
      }
    }
    refineCommitMessagePairs(declared, ctx);
  })
  .meta({ id: "RepositoryConfig", allOf: commitMessagePairRules() });
export type RepositoryConfig = z.infer<typeof RepositoryConfig>;

/** The parsed commit-message fields are the spec's unions; a widened enum would type them as string. */
type _CommitMessageFieldsNarrow = MustBeNever<
  {
    [K in CommitMessageKey]: Exclude<NonNullable<RepositoryConfig[K]>, CommitMessageValue<K>>;
  }[CommitMessageKey]
>;

/** A PATCH boolean left as passthrough would parse as unknown here, so null and "true" would ride to the 422. */
type _PatchTogglesAreBooleans = MustBeNever<
  { [K in PatchToggleKey]: Exclude<NonNullable<RepositoryConfig[K]>, boolean> }[PatchToggleKey]
>;
