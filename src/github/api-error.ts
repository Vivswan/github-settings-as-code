/**
 * ApiError, the one shape GitHub's answer to a failed request takes (an HTTP error, errors[] inside a GraphQL 200),
 * the `failed` line of a request the transport never answered (transportFailure), and classifyApiError, the one
 * reading of an ApiError that tolerance and the library's isRateLimitError/isPermissionError consume. A secret-carrying
 * or redacted request's error is rebuilt by withheld() from the allowlist, never filtered, so GitHubApi (api.ts) and
 * sections/contract/requests.ts withhold the same way.
 */

/**
 * The one shape GitHub's answer to a failed request takes. `rateLimited` is the client's own proof that a 403 is a
 * rate limit, from signals the value cannot carry (retry-after, errors[].type RATE_LIMITED, the secondary-rate
 * phrase; the ambiguous zero-quota header only on a withheld body), recorded because the body it was read from may
 * be withheld; classifyApiError is its one reader, and withheld() copies it through. `graphqlTypes` is what
 * tolerance decisions read instead of the status, a lossy fold (FORBIDDEN and a mixed [FORBIDDEN, UNPROCESSABLE]
 * both land on 403/422); the values are structural enums, never echoes, so the field survives a withheld response.
 *
 *   every errors[] entry carries a string type  -> the types, deduped and sorted
 *   any entry untyped                           -> omitted, and the response is never tolerable
 */
export interface ApiError {
  /** The HTTP status, or the one a GraphQL errors[] folds to. */
  status: number;

  /** GitHub's message with its errors[] appended; a withholding constant for a secret-carrying or redacted request. */
  message: string;

  /** The response body as text; the same constant when withheld. */
  body: string;

  /** GitHub's documentation_url for the failing endpoint, when the body carries one. */
  documentationUrl?: string;

  /** The client's proof that a 403 is a rate limit; the doc above says where it comes from. */
  rateLimited?: true;

  /** GitHub's structured error types, for tolerance decisions; the doc above says when they are present. */
  graphqlTypes?: readonly string[];
}

/** A 4xx body can ECHO the rejected value inside its free-text message/errors, where no field name finds it and JSON escaping defeats exact-literal masking, so nothing of the body survives. */
export const SECRET_RESPONSE_WITHHELD =
  "response body withheld: the request carried a secret field and an error body may echo its value";

/** GraphQL error messages quote the slug and live state verbatim ("Could not resolve to a Repository with the name 'o/private'") where a REST denial says only "Not Found", and the output mask is exact-literal, so a re-cased mention would slip it. */
export const REDACTED_RESPONSE_WITHHELD =
  "response body withheld: the repository is redacted and a GraphQL error message may carry its name or live state";

/** Replaces a secret-carrying request's transport message: some transport failures quote request details in free text. */
export const SECRET_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)";

/** Replaces a redacted repository's transport message, for the same reason. */
export const REDACTED_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the repository is redacted)";

/** The shape of a GitHub GraphQL error `type`: a closed enum token, never free text. */
const GRAPHQL_TYPE_TOKEN = /^[A-Z][A-Z0-9_]*$/;

/** Constructed from the allowlist, never filtered, so nothing else survives; the one rebuild behind every withholding site. */
export function withheld(error: ApiError, reason: string): ApiError {
  const types =
    Array.isArray(error.graphqlTypes) &&
    error.graphqlTypes.every((type) => typeof type === "string" && GRAPHQL_TYPE_TOKEN.test(type))
      ? Object.freeze([...error.graphqlTypes])
      : undefined;
  return {
    status: error.status,
    message: reason,
    body: reason,
    ...(error.rateLimited === true ? { rateLimited: true } : {}),
    ...(types === undefined ? {} : { graphqlTypes: types }),
  };
}

export interface OctokitHttpError {
  status: number;
  response?: { data?: unknown; headers?: Record<string, unknown> };
  message: string;
}

export function isHttpError(error: unknown): error is OctokitHttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { response?: unknown }).response !== undefined
  );
}

/** GitHub's JSON error body, or null for a body without a `message`. */
function jsonErrorBody(
  body: unknown,
): { message: unknown; errors?: unknown; documentation_url?: unknown } | null {
  return typeof body === "object" && body !== null && "message" in body
    ? (body as { message: unknown; errors?: unknown; documentation_url?: unknown })
    : null;
}

/** The JSON body's `message`, else a non-empty text body, else the transport's own message. */
function messageOf(body: unknown, fallback: string): string {
  const json = jsonErrorBody(body);
  if (json !== null) {
    return String(json.message);
  }
  if (typeof body === "string" && body) {
    return body;
  }
  return fallback;
}

/** Whether any errors[] entry of the JSON body is typed RATE_LIMITED. */
function errorsRateLimited(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const errors = (body as { errors?: unknown }).errors;
  return (
    Array.isArray(errors) &&
    errors.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "RATE_LIMITED",
    )
  );
}

/**
 * A rate-limit 403's message need not say "rate limit", and one misread as a missing grant becomes permission
 * advice, so the headers and errors[] decide first.
 *   retry-after, errors[].type RATE_LIMITED, "secondary rate"  -> definitive: no documented permission 403 carries any of them
 *   a secret echoing "secondary rate"                          -> cannot spoof: a permission 403 never echoes the payload
 *   x-ratelimit-remaining: 0                                   -> rides a permission 403 on the token's last quota unit too;
 *                                                                 only a withheld body accepts it
 */
function isRateLimited(
  error: OctokitHttpError,
  body: unknown,
  text: string,
  carriesSecret: boolean,
): boolean {
  const headers = error.response?.headers ?? {};
  const definitive =
    error.status === 429 ||
    (error.status === 403 &&
      (headers["retry-after"] !== undefined ||
        errorsRateLimited(body) ||
        /\bsecondary rate\b/i.test(text)));
  return (
    definitive ||
    (carriesSecret && error.status === 403 && String(headers["x-ratelimit-remaining"]) === "0")
  );
}

/**
 * Shared by tryRequest and tryGraphql. For a secret-carrying request the response is replaced wholesale (a 4xx body may
 * echo the rejected value), so only the status and the content-free rate-limit flag survive; the classification runs FIRST.
 */
export function apiErrorFromHttp(error: OctokitHttpError, carriesSecret: boolean): ApiError {
  const body = error.response?.data;
  const json = jsonErrorBody(body);
  const classificationText = messageOf(body, error.message);
  const rateLimited = isRateLimited(error, body, classificationText, carriesSecret);
  const message = json?.errors
    ? `${classificationText} (${JSON.stringify(json.errors)})`
    : classificationText;
  const docUrl = json?.documentation_url;
  const documentationUrl = typeof docUrl === "string" && docUrl ? docUrl : undefined;
  const readable: ApiError = {
    status: error.status,
    message,
    body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
  };
  return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}

/** What the errors[] entries carry: their types, their messages, and whether every entry was typed. */
interface GraphqlErrorParts {
  readonly types: ReadonlySet<string>;
  readonly messages: readonly string[];
  readonly everyEntryTyped: boolean;
}

function graphqlErrorParts(errors: unknown[]): GraphqlErrorParts {
  const types = new Set<string>();
  const messages: string[] = [];
  let everyEntryTyped = true;
  for (const entry of errors) {
    if (typeof entry !== "object" || entry === null) {
      everyEntryTyped = false;
      continue;
    }

    const type = (entry as { type?: unknown }).type;
    if (typeof type === "string") {
      types.add(type);
    } else {
      everyEntryTyped = false;
    }

    const message = (entry as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      messages.push(message);
    }
  }
  return { types, messages, everyEntryTyped };
}

/** The status the structured types fold to; the earlier in the ladder wins, so a rate limit never reads as a permission failure, nor that as a bad payload. */
function graphqlStatus(types: ReadonlySet<string>): 403 | 404 | 422 {
  if (types.has("RATE_LIMITED") || types.has("FORBIDDEN") || types.has("INSUFFICIENT_SCOPES")) {
    return 403;
  }
  if (types.has("NOT_FOUND")) {
    return 404;
  }
  return 422;
}

/** `message` is required on every errors[] entry by GitHub's contract, so the fallback fires only off-contract; it names the structural types (safe enums, never echoes) so the reader is not left with a bare status. */
function graphqlMessage(parts: GraphqlErrorParts): string {
  const joined = parts.messages.join("; ");
  if (joined) {
    return joined;
  }
  if (parts.types.size > 0) {
    return `GraphQL request failed with no error message (error types: ${[...parts.types].sort().join(", ")})`;
  }
  return "GraphQL request failed with no error message or error type in the errors[] response";
}

/**
 * Keyed on GitHub's structured error `type`. A secret-carrying request withholds message and body (a `type` enum
 * cannot echo).
 *
 * mixed types  -> the earlier in the ladder wins: a rate limit never reads as a permission failure, nor that as a bad payload
 * NOT_FOUND    -> 404, how fine-grained tokens conceal denied resources, like REST
 */
export function apiErrorFromGraphqlErrors(errors: unknown[], carriesSecret: boolean): ApiError {
  const parts = graphqlErrorParts(errors);
  const rateLimited = parts.types.has("RATE_LIMITED");
  // graphqlTypes only when EVERY entry carried a string type: an untyped entry must make the whole response untolerable
  // rather than hide behind its typed siblings.
  const graphqlTypes =
    parts.everyEntryTyped && parts.types.size > 0
      ? { graphqlTypes: Object.freeze([...parts.types].sort()) }
      : {};
  const readable: ApiError = {
    status: graphqlStatus(parts.types),
    message: graphqlMessage(parts),
    body: JSON.stringify(errors),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...graphqlTypes,
  };
  return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}

/**
 * `reason` is the transport error's own message, or a withholding constant REPLACING it: some transport failures quote
 * request details in free text, where neither a field name nor the output mask finds a secret or a redacted slug. The
 * one renderer behind GitHubApi's transport failures and the contract layer's (sections/contract/requests.ts).
 */
export function transportFailure(label: string, reason: string, target: string): string {
  return `${label} failed: ${reason}. Check network connectivity from the runner to ${target}, then re-run`;
}

export function transportReason(error: unknown, withholdReason: string | undefined): string {
  return withholdReason ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Decided in classifyApiError alone; consumers switch on it and never re-read the status or message for the answer.
 * A 404 folds into "permission" because fine-grained tokens answer 404 on an endpoint they deny, so an absent
 * resource lands there too (failureFor's prose says so).
 */
export type ApiErrorKind = "rate-limit" | "permission" | "other";

/** GitHub's primary limit answers 403 with "API rate limit exceeded ..." and neither retry-after nor errors[].type, so a readable message is the one signal left for it, and the one channel a GitHubClient without headers has; a withheld message is a constant that never matches. */
const RATE_LIMIT_PHRASE = /rate limit/i;

export function classifyApiError(error: ApiError): ApiErrorKind {
  if (
    error.status === 429 ||
    (error.status === 403 && (error.rateLimited === true || RATE_LIMIT_PHRASE.test(error.message)))
  ) {
    return "rate-limit";
  }
  return error.status === 403 || error.status === 404 ? "permission" : "other";
}

/** The library's named views of classifyApiError (src/index.ts, docs/reference/library.md); internal code switches on the kind itself. */
export function isRateLimitError(error: ApiError): boolean {
  return classifyApiError(error) === "rate-limit";
}

export function isPermissionError(error: ApiError): boolean {
  return classifyApiError(error) === "permission";
}
