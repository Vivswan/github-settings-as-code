/**
 * ApiError, the one shape GitHub's answer to a failed request takes (an HTTP error, errors[] inside a GraphQL 200),
 * the `failed` line of a request the transport never answered (transportFailure), and classifyApiError, the one
 * reading of an ApiError that tolerance and the library's isRateLimitError/isPermissionError consume. A secret-carrying
 * or redacted request's error is rebuilt by withheld() from the allowlist, never filtered, so GitHubApi (api.ts) and
 * sections/contract/requests.ts withhold the same way.
 */

export interface ApiError {
  status: number;
  message: string;
  body: string;
  /** GitHub's documentation_url for the failing endpoint, when the body carries one. */
  documentationUrl?: string;
  /**
   * The client's own proof that a 403 is a rate limit, from signals the value cannot carry (retry-after, errors[].type
   * RATE_LIMITED, the secondary-rate phrase; the ambiguous zero-quota header only on a withheld body), recorded because
   * the body it was read from may be withheld. classifyApiError is its one reader; withheld() copies it through.
   */
  rateLimited?: true;
  /**
   * Tolerance decisions read this instead of the status, which is a lossy fold (FORBIDDEN and a mixed
   * [FORBIDDEN, UNPROCESSABLE] both land on 403/422). The values are structural enums, never echoes, so the field
   * survives a withheld response.
   *
   * every errors[] entry carries a string type  -> the types, deduped and sorted
   * any entry untyped                           -> omitted, and the response is never tolerable
   */
  graphqlTypes?: readonly string[];
}

/**
 * A 4xx body can ECHO the rejected value inside its free-text message/errors, where no field name finds it and JSON
 * escaping defeats exact-literal masking, so nothing of the body survives.
 */
export const SECRET_RESPONSE_WITHHELD =
  "response body withheld: the request carried a secret field and an error body may echo its value";

/**
 * GraphQL error messages quote the slug and live state verbatim ("Could not resolve to a Repository with the name
 * 'o/private'") where a REST denial says only "Not Found", and the output mask is exact-literal, so a re-cased mention
 * would slip it.
 */
export const REDACTED_RESPONSE_WITHHELD =
  "response body withheld: the repository is redacted and a GraphQL error message may carry its name or live state";

export const SECRET_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)";

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

/**
 * Shared by tryRequest and tryGraphql. For a secret-carrying request the response is replaced wholesale (a 4xx body may
 * echo the rejected value), so only the status and the content-free rate-limit flag survive; the classification runs FIRST.
 */
export function apiErrorFromHttp(error: OctokitHttpError, carriesSecret: boolean): ApiError {
  const body = error.response?.data;
  const headers = error.response?.headers ?? {};
  const classificationText =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : typeof body === "string" && body
        ? body
        : error.message;
  // A rate-limit 403's message need not say "rate limit", and one misread as a missing grant becomes permission
  // advice, so the headers and errors[] decide first.
  //   retry-after, errors[].type RATE_LIMITED, "secondary rate"  -> definitive: no documented permission 403 carries any of them
  //   a secret echoing "secondary rate"                          -> cannot spoof: a permission 403 never echoes the payload
  //   x-ratelimit-remaining: 0                                   -> rides a permission 403 on the token's last quota unit too;
  //                                                                 only a withheld body accepts it
  const errorsRateLimited =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { errors?: unknown }).errors) &&
    ((body as { errors: unknown[] }).errors ?? []).some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "RATE_LIMITED",
    );
  const definitiveRateLimit =
    error.status === 429 ||
    (error.status === 403 &&
      (headers["retry-after"] !== undefined ||
        errorsRateLimited ||
        /\bsecondary rate\b/i.test(classificationText)));
  const rateLimited =
    definitiveRateLimit ||
    (carriesSecret && error.status === 403 && String(headers["x-ratelimit-remaining"]) === "0");
  let message: string;
  let documentationUrl: string | undefined;
  if (typeof body === "object" && body !== null && "message" in body) {
    message = String((body as { message: unknown }).message);
    const errors = (body as { errors?: unknown }).errors;
    if (errors) {
      message += ` (${JSON.stringify(errors)})`;
    }
    const docUrl = (body as { documentation_url?: unknown }).documentation_url;
    if (typeof docUrl === "string" && docUrl) {
      documentationUrl = docUrl;
    }
  } else if (typeof body === "string" && body) {
    message = body;
  } else {
    message = error.message;
  }
  const readable: ApiError = {
    status: error.status,
    message,
    body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
  };
  return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}

/**
 * Keyed on GitHub's structured error `type`. A secret-carrying request withholds message and body (a `type` enum
 * cannot echo).
 *
 * mixed types  -> the earlier in the ladder wins: a rate limit never reads as a permission failure, nor that as a bad payload
 * NOT_FOUND    -> 404, how fine-grained tokens conceal denied resources, like REST
 */
export function apiErrorFromGraphqlErrors(errors: unknown[], carriesSecret: boolean): ApiError {
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
  const rateLimited = types.has("RATE_LIMITED");
  const status =
    rateLimited || types.has("FORBIDDEN") || types.has("INSUFFICIENT_SCOPES")
      ? 403
      : types.has("NOT_FOUND")
        ? 404
        : 422;
  // graphqlTypes only when EVERY entry carried a string type: an untyped entry must make the whole response untolerable
  // rather than hide behind its typed siblings.
  const graphqlTypes =
    everyEntryTyped && types.size > 0 ? { graphqlTypes: Object.freeze([...types].sort()) } : {};
  const readable: ApiError = {
    status,
    // `message` is required on every errors[] entry by GitHub's contract, so the fallback fires only off-contract; it
    // names the structural types (safe enums, never echoes) so the reader is not left with a bare status.
    message:
      messages.join("; ") ||
      (types.size > 0
        ? `GraphQL request failed with no error message (error types: ${[...types].sort().join(", ")})`
        : "GraphQL request failed with no error message or error type in the errors[] response"),
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

/**
 * GitHub's primary limit answers 403 with "API rate limit exceeded ..." and neither retry-after nor errors[].type, so a
 * readable message is the one signal left for it, and the one channel a GitHubClient without headers has. A withheld
 * message is a constant that never matches.
 */
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
