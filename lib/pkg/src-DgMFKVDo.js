import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Result, ResultAsync, err, ok, safeTry } from "neverthrow";
import { Octokit } from "@octokit/core";
import { requestLog } from "@octokit/plugin-request-log";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import Bottleneck from "bottleneck/light.js";
import { z } from "zod";
import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { Encrypter } from "age-encryption";
import { parse, stringify } from "yaml";
//#region src/discovery/targets.ts
/**
* The multi-repo target model. Central files WIN over repos-input entries for the same repository: the checked-in
* file is a curated, code-reviewed artifact; the remote file is self-service.
*/
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
/**
* The smart constructor lives beside SLUG_RE so every boundary (the repository input, the repos list, discovery's
* full_name) validates and splits through the same definition.
*/
function parseRepoSlug(raw) {
	if (!SLUG_RE.test(raw)) return err({
		code: "repo-slug-invalid",
		value: raw
	});
	const separator = raw.indexOf("/");
	return ok({
		owner: raw.slice(0, separator),
		name: raw.slice(separator + 1),
		slug: raw
	});
}
/**
* A central file wins over a repos-input entry for the same repository (noticed, not an error). The notice renders the
* slug through `display`; a CENTRAL origin is a repos-dir FILE PATH that can embed the real repository name, so for a
* redacted target it is rendered generically ("a repos-dir file") to keep the name away from its placeholder.
*/
function dedupeTargets(central, remote, notice, display, isRedacted = () => false) {
	const centralBySlug = /* @__PURE__ */ new Map();
	for (const target of central) {
		const key = target.slug.toLowerCase();
		if (!centralBySlug.has(key)) centralBySlug.set(key, target);
	}
	const out = [...central];
	for (const target of remote) {
		const winner = centralBySlug.get(target.slug.toLowerCase());
		if (winner) {
			const centralOrigin = isRedacted(target.slug) ? "a repos-dir file" : winner.origin;
			notice(`${display(target.slug)}: using the central file ${centralOrigin}; the entry for the same repository from ${target.origin} is ignored`);
			continue;
		}
		out.push(target);
	}
	return out;
}
//#endregion
//#region src/discovery/central.ts
/**
* Central-mode target resolution: per-repo settings files checked into the
* admin repository under repos-dir.
*/
const YAML_EXT = /\.ya?ml$/;
function resolveCentralTargets(reposDir, adminOwner) {
	if (!existsSync(reposDir)) return err({
		code: "repos-dir-missing",
		reposDir
	});
	const targets = [];
	const warnings = [];
	const errors = [];
	const seen = /* @__PURE__ */ new Map();
	const addTarget = (slug, filePath) => {
		if (!SLUG_RE.test(slug)) {
			errors.push({
				kind: "not-a-slug",
				filePath,
				slug
			});
			return;
		}
		const key = slug.toLowerCase();
		const existing = seen.get(key);
		if (existing) {
			errors.push({
				kind: "duplicate",
				slug,
				first: existing,
				second: filePath
			});
			return;
		}
		seen.set(key, filePath);
		targets.push({
			slug,
			source: "central",
			origin: filePath,
			filePath
		});
	};
	const scanOwnerDir = (dirPath, owner) => {
		for (const inner of readdirSync(dirPath).sort()) {
			const innerPath = join(dirPath, inner);
			if (statSync(innerPath).isDirectory()) {
				warnings.push(`ignoring ${innerPath}: repos-dir supports only <name>.yml and <owner>/<name>.yml, nothing deeper. Move the files up or remove the directory`);
				continue;
			}
			if (!YAML_EXT.test(inner)) {
				warnings.push(`ignoring ${innerPath}: not a .yml/.yaml file, so it defines no target repository`);
				continue;
			}
			addTarget(`${owner}/${inner.replace(YAML_EXT, "")}`, innerPath);
		}
	};
	try {
		const ownerlessFiles = [];
		for (const entry of readdirSync(reposDir).sort()) {
			const entryPath = join(reposDir, entry);
			if (statSync(entryPath).isDirectory()) {
				scanOwnerDir(entryPath, entry);
				continue;
			}
			if (!YAML_EXT.test(entry)) {
				warnings.push(`ignoring ${entryPath}: not a .yml/.yaml file, so it defines no target repository`);
				continue;
			}
			if (!adminOwner) {
				ownerlessFiles.push(entryPath);
				continue;
			}
			addTarget(`${adminOwner}/${entry.replace(YAML_EXT, "")}`, entryPath);
		}
		if (ownerlessFiles.length > 0) errors.push({
			kind: "ownerless",
			files: ownerlessFiles
		});
	} catch (error) {
		return err({
			code: "repos-dir-unreadable",
			reposDir,
			reason: String(error)
		});
	}
	if (errors.length > 0) return err({
		code: "repos-dir-invalid-files",
		reposDir,
		files: errors
	});
	return ok({
		targets,
		warnings
	});
}
//#endregion
//#region src/io.ts
const MASK_PAIR = Symbol("Io.maskPair");
function mint(member) {
	return Object.assign(member, { [MASK_PAIR]: true });
}
function maskRegistry(sink) {
	const masked = /* @__PURE__ */ new Set();
	return {
		mask: mint((value) => {
			masked.add(value);
			sink(value);
		}),
		masked: mint(() => masked)
	};
}
/**
* `text` with every occurrence of every masked value replaced by `***`: the
* one redactor for the Ios that mask text themselves (collectingIo, the CLI's
* streams) where the action leaves it to the runner. Occurrences are located
* in the original text and overlapping or touching ones are merged, so two
* values that overlap (a prefix of another, or "ABC" and "BCD" across "ABCD")
* leave no fragment, as replacing one value after another would.
*/
function redactRanges(text, masked) {
	const ranges = [];
	for (const value of masked) {
		if (value === "") continue;
		for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) ranges.push([at, at + value.length]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	let out = "";
	let cursor = 0;
	let open;
	for (const [start, end] of ranges) {
		if (open !== void 0 && start <= open[1]) {
			open[1] = Math.max(open[1], end);
			continue;
		}
		if (open !== void 0) {
			out += `${text.slice(cursor, open[0])}***`;
			cursor = open[1];
		}
		open = [start, end];
	}
	if (open !== void 0) {
		out += `${text.slice(cursor, open[0])}***`;
		cursor = open[1];
	}
	return out + text.slice(cursor);
}
/**
* Only annotate and log take the prefix: the debug trace, summary, and outputs are rendered by their writers, and the
* mask pair registers raw values, not rendered lines.
*/
function prefixedIo(io, prefix) {
	if (prefix === "") return io;
	return {
		annotate: (level, message) => io.annotate(level, `${prefix}${message}`),
		log: (line) => io.log(`${prefix}${line}`),
		debug: (line) => io.debug(line),
		summary: (markdown) => io.summary(markdown),
		output: (name, value) => io.output(name, value),
		mask: io.mask,
		masked: io.masked
	};
}
/**
* An Io that records instead of printing. Every captured line, output, and summary block is redacted against the
* values registered so far, as a runner masks its log, so a library caller that prints the capture cannot leak
* a secret. The debug trace is dropped, as a runner without step debugging drops it.
*/
function collectingIo() {
	const lines = [];
	const outputs = {};
	const summary = [];
	const registry = maskRegistry(() => {});
	const redact = (text) => redactRanges(text, registry.masked());
	return {
		io: {
			annotate: (level, message) => lines.push({
				level,
				line: redact(message)
			}),
			log: (line) => lines.push({ line: redact(line) }),
			debug: () => {},
			summary: (markdown) => summary.push(redact(markdown)),
			output: (name, value) => {
				outputs[name] = redact(value);
			},
			...registry
		},
		lines,
		outputs,
		summary
	};
}
/** An Io that drops everything. Fresh per call, so one caller's masks never reach another's registry. */
function silentIo() {
	return {
		annotate: () => {},
		log: () => {},
		debug: () => {},
		summary: () => {},
		output: () => {},
		...maskRegistry(() => {})
	};
}
//#endregion
//#region src/github/scheduler.ts
/**
* The limiter class the throttling plugin schedules through, injectable so a test run keeps the plugin's rate-limit
* decisions while skipping Bottleneck's pacing: each Bottleneck limiter yields through several zero-delay timers per
* job, around 11 ms on every request across the plugin's three limiters, and the notification limiter spaces issue
* creates by three real seconds whatever the plugin's time unit.
*
* TIMERS_SCHEDULER     -> Bottleneck itself: real pacing, real Retry-After sleeps
* IMMEDIATE_SCHEDULER  -> every job runs at once; a request the plugin decides to retry is retried without sleeping
*/
const TIMERS_SCHEDULER = Bottleneck;
const groupsByScheduler = /* @__PURE__ */ new WeakMap();
/**
* The plugin builds these groups once per process from the FIRST client's scheduler and hands them to every later
* client, so a process mixing schedulers would pace a client by a limiter it never chose.
*/
function throttleGroups(scheduler) {
	const cached = groupsByScheduler.get(scheduler);
	if (cached) return cached;
	const timeout = 12e4;
	const groups = {
		global: new scheduler.Group({
			id: "octokit-global",
			maxConcurrent: 10,
			timeout
		}),
		auth: new scheduler.Group({
			id: "octokit-auth",
			maxConcurrent: 1,
			timeout
		}),
		search: new scheduler.Group({
			id: "octokit-search",
			maxConcurrent: 1,
			minTime: 2e3,
			timeout
		}),
		notifications: new scheduler.Group({
			id: "octokit-notifications",
			maxConcurrent: 1,
			minTime: 3e3,
			timeout
		})
	};
	groupsByScheduler.set(scheduler, groups);
	return groups;
}
var ImmediateGroup = class {
	limiter = new ImmediateLimiter();
	key() {
		return this.limiter;
	}
};
var ImmediateLimiter = class {
	static Group = ImmediateGroup;
	static Events = Bottleneck.Events;
	onFailed;
	on(name, handler) {
		if (name === "failed") this.onFailed = handler;
		return this;
	}
	async failedWait(error, info) {
		try {
			return await this.onFailed?.(error, info);
		} catch {
			return;
		}
	}
	async schedule(...call) {
		const [options, job, ...args] = typeof call[0] === "function" ? [{}, ...call] : call;
		for (let retryCount = 0;; retryCount++) try {
			return await job(...args);
		} catch (error) {
			if (typeof await this.failedWait(error, {
				retryCount,
				args,
				options
			}) !== "number") throw error;
		}
	}
};
const IMMEDIATE_SCHEDULER = ImmediateLimiter;
//#endregion
//#region src/plain-data.ts
/**
* The one plain-mapping test and the rejection prose, shared by the boundaries that refuse tagged values
* (engine/validate.ts, github/secret-scan.ts), so no two of them describe the same value differently.
*/
/**
* A YAML tag (!!timestamp, !!set) parses to a Date or Set, an object too; spread as a mapping it would become `{}` and
* hand the merge a document nobody wrote. Non-plain objects replace like scalars and survive for validation to reject.
*/
function isPlainObject$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
/** Prototype comparison only, the same reflective read the callers already perform; no payload method is ever dispatched. */
function nonPlainKind(value) {
	if (typeof value !== "object" || value === null) return `a ${typeof value}`;
	const proto = Object.getPrototypeOf(value);
	if (proto === Date.prototype) return "a Date, e.g. from a YAML !!timestamp tag";
	if (proto === Uint8Array.prototype) return "binary data, e.g. from a YAML !!binary tag";
	if (proto === Set.prototype) return "a set, e.g. from a YAML !!set tag";
	return "a non-plain object";
}
//#endregion
//#region src/github/secret-scan.ts
/**
* Plain-data normalization and secret-field scanning for outgoing payloads, dependency-free on purpose: the guarantees
* (no payload-supplied method or accessor is ever invoked, the scanned tree IS the sent tree, secret fields are masked
* in traces) must hold independent of any transport.
*/
const SECRET_FIELD_PLACEHOLDER = "***";
/**
* Octokit's own body rule: only plain objects and arrays are stringified. An array subclass can override map and
* iteration, which is foreign code the normalizer must never invoke.
*/
function isPlainJsonContainer(value) {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (Array.isArray(value)) return proto === Array.prototype;
	return proto === Object.prototype || proto === null;
}
/**
* Carries WHERE (the key path: field names only, never a value) and WHAT (the value class). redactSecretPayloadSafe
* reports only THIS class's information; anything else a hostile object throws is swallowed so no foreign message leaks.
*/
var NotPlainDataError = class extends Error {
	path;
	kind;
	constructor(path, kind) {
		super("not plain JSON data");
		this.path = path;
		this.kind = kind;
	}
};
function renderKeyPath(path) {
	return path.map((segment, index) => /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`).join("");
}
/**
* Built BY HAND, never via JSON.stringify: it honors toJSON, and a toJSON can return a container that hides a secret
* under no field name ({secret, toJSON: () => [value]}). No payload method, accessor, or toJSON is ever invoked.
*
* a property         -> read through its descriptor; an enumerable accessor is rejected UNREAD (a getter could sabotage globals)
* an object's keys   -> only Object.keys are copied, so symbol and non-enumerable keys never reach the copy (array indices do)
* the wire           -> only the copy is sent
*/
function normalizePlainData(value, path = []) {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean": return value;
		case "number": return Number.isFinite(value) ? value : null;
		case "object": break;
		default: throw new NotPlainDataError(path, nonPlainKind(value));
	}
	if (!isPlainJsonContainer(value)) throw new NotPlainDataError(path, nonPlainKind(value));
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Array.isArray(value)) {
		const items = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = descriptors[index];
			if (descriptor === void 0) {
				items.push(null);
				continue;
			}
			if (!("value" in descriptor)) throw new NotPlainDataError([...path, String(index)], "an accessor property");
			const item = descriptor.value;
			items.push(item === void 0 ? null : normalizePlainData(item, [...path, String(index)]));
		}
		return items;
	}
	const out = Object.create(null);
	for (const key of Object.keys(value)) {
		const descriptor = descriptors[key];
		if (descriptor === void 0) continue;
		if (!("value" in descriptor)) throw new NotPlainDataError([...path, key], "an accessor property");
		const item = descriptor.value;
		if (item === void 0) continue;
		out[key] = normalizePlainData(item, [...path, key]);
	}
	return out;
}
/**
* One read, one truth: normalizePlainData reads the input once into a plain-data tree; the scan walks it, the trace
* prints it masked, and the request SENDS it, so no exotic object can make the scan, the trace, and the wire disagree.
*
* undefined (no body), or a JSON primitive  -> passes through: no named fields, and a bare-value secret is unsupported by design
* plain objects and arrays throughout       -> normalized, scanned, sent
* a non-plain value, at any depth           -> `ok: false`, never sent: normalizing a non-plain container would change what reaches fetch
*/
function redactSecretPayloadSafe(payload) {
	if (payload === void 0) return {
		ok: true,
		payload: void 0,
		traced: void 0,
		carriesSecret: false
	};
	try {
		if (typeof payload !== "object" || payload === null) return payload === null || typeof payload === "string" || typeof payload === "boolean" || typeof payload === "number" && Number.isFinite(payload) ? {
			ok: true,
			payload,
			traced: payload,
			carriesSecret: false
		} : { ok: false };
		if (!isPlainJsonContainer(payload)) return {
			ok: false,
			reason: describeNotPlain(new NotPlainDataError([], nonPlainKind(payload)))
		};
		const normalized = normalizePlainData(payload);
		return {
			ok: true,
			payload: normalized,
			...redactSecretPayload(normalized)
		};
	} catch (error) {
		return error instanceof NotPlainDataError ? {
			ok: false,
			reason: describeNotPlain(error)
		} : { ok: false };
	}
}
function describeNotPlain(error) {
	return `${error.path.length > 0 ? `the value at "${renderKeyPath(error.path)}"` : "the value"} is not plain JSON data (${error.kind})`;
}
const SECRET_FIELD_NAMES = /* @__PURE__ */ new Set(["secret", "encrypted_value"]);
/**
* Keys on the FIELD NAMES alone, recursing over objects and arrays, so a consumer nesting one level deeper, or a new
* consumer entirely, is covered without declaring anything (an unenforced "declare your shape" contract is how a leak
* happens).
*
* an UNNAMED value (a bare string body)  -> uncovered: a secret must never be the whole payload
* a hit                                  -> `traced` is a masked copy; the request still sends the unmasked tree
*/
function redactSecretPayload(payload) {
	if (typeof payload !== "object" || payload === null) return {
		traced: payload,
		carriesSecret: false
	};
	if (Array.isArray(payload)) {
		let hit = false;
		const traced = [];
		for (let index = 0; index < payload.length; index++) {
			const scanned = redactSecretPayload(payload[index]);
			hit = hit || scanned.carriesSecret;
			traced.push(scanned.traced);
		}
		return hit ? {
			traced,
			carriesSecret: true
		} : {
			traced: payload,
			carriesSecret: false
		};
	}
	const record = payload;
	let hit = false;
	const traced = Object.create(null);
	for (const [key, value] of Object.entries(record)) if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
		traced[key] = SECRET_FIELD_PLACEHOLDER;
		hit = true;
	} else {
		const scanned = redactSecretPayload(value);
		hit = hit || scanned.carriesSecret;
		traced[key] = scanned.traced;
	}
	return hit ? {
		traced,
		carriesSecret: true
	} : {
		traced: payload,
		carriesSecret: false
	};
}
//#endregion
//#region src/github/api.ts
/**
* GitHub REST client on @octokit/core with the retry and throttling plugins; only `octokit.request` is used. Payloads
* pass through with every field intact: the JSON body is the payload's own serialization (redactSecretPayloadSafe),
* never an endpoint typing that could drop an unknown field.
*
* request-log plugin  -> kept: its per-attempt trace line carries GitHub's request id, which support asks for
*/
/**
* The single source for the header default here, the action.yml `api-version` default, and the inputs fallback; the
* action-yml contract test asserts the three stay equal.
*/
const DEFAULT_API_VERSION = "2022-11-28";
const REPO_SLUG = /\/repos\/([\w.-]+\/[\w.-]+)/i;
function repoSlugOf(path) {
	return path.match(REPO_SLUG)?.[1];
}
/**
* A slug is redacted while it is masked through the Io port or held by an in-flight request (the visibility probe). A
* traced payload is private content no mask covers, so it is dropped.
*/
var TraceRedaction = class {
	io;
	holds = /* @__PURE__ */ new Set();
	constructor(io) {
		this.io = io;
	}
	debug(line) {
		this.io.debug(line);
	}
	hold(slug) {
		const token = { slug: slug.toLowerCase() };
		this.holds.add(token);
		return () => {
			this.holds.delete(token);
		};
	}
	isRedacted(slug) {
		const key = slug.toLowerCase();
		for (const needle of this.needles()) if (needle === key) return true;
		return false;
	}
	/**
	* The ENTIRE path collapses: the prefix can carry a team slug and the tail live state (branches, labels), so
	* anything but a constant leaks what redaction hides.
	*/
	path(path) {
		const slug = repoSlugOf(path);
		if (slug && this.isRedacted(slug)) return {
			path: "<redacted>",
			redacted: true
		};
		return {
			path,
			redacted: false
		};
	}
	/**
	* For octokit's free-text log lines, where a slug can sit anywhere ("retrying request to o/private after 429"): any
	* needle as a case-insensitive substring collapses the whole line.
	*/
	message(message) {
		const lower = message.toLowerCase();
		for (const needle of this.needles()) if (lower.includes(needle)) return "<redacted>";
		return message;
	}
	*needles() {
		for (const token of this.holds) yield token.slug;
		for (const value of this.io.masked()) if (value !== "") yield value.toLowerCase();
	}
};
/**
* A 4xx body can ECHO the rejected value inside its free-text message/errors, where no field name finds it and JSON
* escaping defeats exact-literal masking, so nothing of the body survives.
*/
const SECRET_RESPONSE_WITHHELD = "response body withheld: the request carried a secret field and an error body may echo its value";
/**
* GraphQL error messages quote the slug and live state verbatim ("Could not resolve to a Repository with the name
* 'o/private'") where a REST denial says only "Not Found", and the output mask is exact-literal, so a re-cased mention
* would slip it.
*/
const REDACTED_RESPONSE_WITHHELD = "response body withheld: the repository is redacted and a GraphQL error message may carry its name or live state";
/** The shape of a GitHub GraphQL error `type`: a closed enum token, never free text. */
const GRAPHQL_TYPE_TOKEN = /^[A-Z][A-Z0-9_]*$/;
/** Constructed from the allowlist, never filtered, so nothing else survives; the one rebuild behind every withholding site. */
function withheld(error, reason) {
	const types = Array.isArray(error.graphqlTypes) && error.graphqlTypes.every((type) => typeof type === "string" && GRAPHQL_TYPE_TOKEN.test(type)) ? Object.freeze([...error.graphqlTypes]) : void 0;
	return {
		status: error.status,
		message: reason,
		body: reason,
		...error.rateLimited === true ? { rateLimited: true } : {},
		...types === void 0 ? {} : { graphqlTypes: types }
	};
}
/** The primary and secondary limits are handled identically but for the log `label`, so one factory keeps them from drifting. */
function throttleCallback(label, trace) {
	return (retryAfter, options, _octokit, retryCount) => {
		trace.debug(`${label} on ${options.method} ${trace.path(options.url).path}; retry ${retryCount + 1}/2 after ${retryAfter}s`);
		return retryAfter <= 60 && retryCount < 2;
	};
}
function redactingOctokitLog(trace) {
	const redact = (message) => {
		trace.debug(trace.message(String(message)));
	};
	return {
		debug: redact,
		info: redact,
		warn: redact,
		error: redact
	};
}
const ActionOctokit = Octokit.plugin(requestLog, retry, throttling);
function isHttpError(error) {
	return typeof error === "object" && error !== null && typeof error.status === "number" && error.response !== void 0;
}
/** RETRY_BASE_MS is the one knob the e2e runner sets: millisecond plugin units and the immediate scheduler for the spawned bundle. */
function envRetryBaseMs() {
	const value = Number(process.env.RETRY_BASE_MS ?? "");
	return Number.isFinite(value) && value > 0 ? value : void 0;
}
/** Among the 4xx only 408 is retried here; 429 and the rate-limit 403s belong to the throttling plugin, which honors Retry-After. */
const DO_NOT_RETRY = Array.from({ length: 100 }, (_, i) => 400 + i).filter((s) => s !== 408);
/**
* Shared by tryRequest and tryGraphql. For a secret-carrying request the response is replaced wholesale (a 4xx body may
* echo the rejected value), so only the status and the content-free rate-limit flag survive; the classification runs FIRST.
*/
function apiErrorFromHttp(error, carriesSecret) {
	const body = error.response?.data;
	const headers = error.response?.headers ?? {};
	const classificationText = typeof body === "object" && body !== null && "message" in body ? String(body.message) : typeof body === "string" && body ? body : error.message;
	const errorsRateLimited = typeof body === "object" && body !== null && Array.isArray(body.errors) && (body.errors ?? []).some((entry) => typeof entry === "object" && entry !== null && entry.type === "RATE_LIMITED");
	const rateLimited = error.status === 429 || error.status === 403 && (headers["retry-after"] !== void 0 || errorsRateLimited || /\bsecondary rate\b/i.test(classificationText)) || carriesSecret && error.status === 403 && String(headers["x-ratelimit-remaining"]) === "0";
	let message;
	let documentationUrl;
	if (typeof body === "object" && body !== null && "message" in body) {
		message = String(body.message);
		const errors = body.errors;
		if (errors) message += ` (${JSON.stringify(errors)})`;
		const docUrl = body.documentation_url;
		if (typeof docUrl === "string" && docUrl) documentationUrl = docUrl;
	} else if (typeof body === "string" && body) message = body;
	else message = error.message;
	const readable = {
		status: error.status,
		message,
		body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
		...rateLimited ? { rateLimited: true } : {},
		...documentationUrl === void 0 ? {} : { documentationUrl }
	};
	return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}
/**
* `withholdReason`, when given, REPLACES the transport error's own message: some transport failures quote request
* details in free text, where neither a field name nor the output mask finds a secret or a redacted slug.
*/
function transportFailure(label, error, withholdReason, baseUrl) {
	const reason = withholdReason ?? (error instanceof Error ? error.message : String(error));
	return /* @__PURE__ */ new Error(`${label} failed: ${reason}. Check network connectivity from the runner to ${baseUrl}, then re-run the workflow`);
}
const SECRET_TRANSPORT_WITHHELD = "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)";
const REDACTED_TRANSPORT_WITHHELD = "the transport failed before an HTTP response arrived (details withheld: the repository is redacted)";
const SILENT_TRACE = {
	debug() {},
	masked: maskRegistry(() => {}).masked
};
/** The Octokit instance is built here and never injected: a consumer needing control over transport or plugins implements GithubClient directly. */
var GithubApi = class {
	octokit;
	trace;
	baseUrl;
	apiVersion;
	constructor(options) {
		this.baseUrl = options.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
		this.apiVersion = options.apiVersion ?? "2022-11-28";
		this.trace = new TraceRedaction(options.io ?? SILENT_TRACE);
		const envKnob = envRetryBaseMs();
		const retryBaseMs = options.retryBaseMs ?? envKnob ?? 1e3;
		const scheduler = options.scheduler ?? (envKnob === void 0 ? TIMERS_SCHEDULER : IMMEDIATE_SCHEDULER);
		this.octokit = new ActionOctokit({
			auth: options.token,
			baseUrl: this.baseUrl,
			userAgent: options.userAgent,
			log: redactingOctokitLog(this.trace),
			request: { retryAfterBaseValue: retryBaseMs },
			retry: {
				doNotRetry: DO_NOT_RETRY,
				retries: 2,
				retryAfterBaseValue: retryBaseMs
			},
			throttle: {
				Bottleneck: scheduler,
				retryAfterBaseValue: retryBaseMs,
				...throttleGroups(scheduler),
				write: new scheduler.Group({
					id: "octokit-write",
					maxConcurrent: 1,
					minTime: retryBaseMs
				}),
				onRateLimit: throttleCallback("rate limit", this.trace),
				onSecondaryRateLimit: throttleCallback("secondary rate limit", this.trace)
			}
		});
	}
	async tryRequest(method, path, payload, options) {
		if (!options?.redactTrace) return this.request(method, path, payload, options);
		const slug = repoSlugOf(path);
		if (slug === void 0) throw new Error(`internal: redactTrace needs a /repos/<owner>/<repo> path, got ${path}`);
		const release = this.trace.hold(slug);
		try {
			return await this.request(method, path, payload, options);
		} finally {
			release();
		}
	}
	async request(method, path, payload, options) {
		const started = Date.now();
		const secretScan = redactSecretPayloadSafe(payload);
		if (!secretScan.ok) {
			const reason = secretScan.reason ?? "its payload is not plain JSON data (a cyclic value, or a value carrying a function or exotic prototype)";
			throw new Error(`${method} ${path} was not sent: ${reason}, so it could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`);
		}
		const trace = (status) => {
			const safe = this.trace.path(path);
			this.trace.debug(`${method} ${safe.path} -> ${status} (${Date.now() - started}ms)` + (safe.redacted || payload === void 0 ? "" : ` payload: ${JSON.stringify(secretScan.traced)}`));
		};
		try {
			const response = await this.octokit.request({
				method,
				url: path,
				headers: {
					accept: options?.accept ?? "application/vnd.github+json",
					"x-github-api-version": this.apiVersion
				},
				...payload === void 0 ? {} : { data: secretScan.payload }
			});
			trace(response.status);
			const data = response.data;
			if (options?.raw) return { data: typeof data === "string" ? data : "" };
			return { data: data === void 0 || data === "" ? null : data };
		} catch (error) {
			if (isHttpError(error)) {
				trace(error.status);
				return { error: apiErrorFromHttp(error, secretScan.carriesSecret) };
			}
			throw transportFailure(`${method} ${path}`, error, secretScan.carriesSecret ? SECRET_TRANSPORT_WITHHELD : void 0, this.baseUrl);
		}
	}
	/**
	* The load-bearing difference from REST: GraphQL failures arrive as an HTTP 200 carrying a non-empty errors[].
	*
	* any errors[] entry, even beside partial data   -> { error }, so a section never acts on a half-answered query
	* `extensions.warnings` (legacy node-ID notices)  -> the debug trace only
	*/
	async tryGraphql(op, variables, slug) {
		const started = Date.now();
		const scan = redactSecretPayloadSafe(variables);
		if (!scan.ok) {
			const reason = scan.reason ?? "its variables are not plain JSON data (a cyclic value, or a value carrying a function or exotic prototype)";
			throw new Error(`GRAPHQL ${op.name} was not sent: ${reason}, so they could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`);
		}
		const redacted = () => this.trace.isRedacted(slug);
		const trace = (status, suffix = "") => {
			this.trace.debug(redacted() ? "<redacted>" : this.trace.message(`GRAPHQL ${op.name} -> ${status} (${Date.now() - started}ms) variables: ${JSON.stringify(scan.traced)}${suffix}`));
		};
		const withholdContent = () => scan.carriesSecret || redacted();
		const forRedacted = (error) => redacted() ? withheld(error, REDACTED_RESPONSE_WITHHELD) : error;
		let response;
		try {
			response = await this.octokit.request({
				method: "POST",
				url: "/graphql",
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": this.apiVersion
				},
				data: {
					query: op.query,
					operationName: op.name,
					variables: scan.payload
				}
			});
		} catch (error) {
			if (isHttpError(error)) {
				trace(error.status);
				return { error: forRedacted(apiErrorFromHttp(error, withholdContent())) };
			}
			const rethrownErrors = error?.response?.data?.errors;
			if (Array.isArray(rethrownErrors) && rethrownErrors.length > 0) {
				trace(200);
				return { error: forRedacted(apiErrorFromGraphqlErrors(rethrownErrors, withholdContent())) };
			}
			throw transportFailure(`GRAPHQL ${op.name}`, error, scan.carriesSecret ? SECRET_TRANSPORT_WITHHELD : redacted() ? REDACTED_TRANSPORT_WITHHELD : void 0, this.baseUrl);
		}
		const body = response.data ?? {};
		const warnings = body.extensions?.warnings;
		trace(response.status, Array.isArray(warnings) && warnings.length > 0 ? scan.carriesSecret ? ` warnings: ${warnings.length} (details withheld: the request carried a secret field)` : ` warnings: ${JSON.stringify(warnings)}` : "");
		if (body.errors !== void 0 && (!Array.isArray(body.errors) || body.errors.length === 0)) throw new Error(`GRAPHQL ${op.name} returned a malformed errors value (not a non-empty list); the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run the workflow, and retry later if it persists`);
		const errors = Array.isArray(body.errors) ? body.errors : [];
		if (errors.length > 0) return { error: forRedacted(apiErrorFromGraphqlErrors(errors, withholdContent())) };
		const data = body.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`GRAPHQL ${op.name} returned a response carrying neither errors nor a data object; the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run the workflow, and retry later if it persists`);
		return { data };
	}
};
/**
* Keyed on GitHub's structured error `type`. A secret-carrying request withholds message and body (a `type` enum
* cannot echo).
*
* mixed types  -> the earlier in the ladder wins: a rate limit never reads as a permission failure, nor that as a bad payload
* NOT_FOUND    -> 404, how fine-grained tokens conceal denied resources, like REST
*/
function apiErrorFromGraphqlErrors(errors, carriesSecret) {
	const types = /* @__PURE__ */ new Set();
	const messages = [];
	let everyEntryTyped = true;
	for (const entry of errors) {
		if (typeof entry !== "object" || entry === null) {
			everyEntryTyped = false;
			continue;
		}
		const type = entry.type;
		if (typeof type === "string") types.add(type);
		else everyEntryTyped = false;
		const message = entry.message;
		if (typeof message === "string" && message) messages.push(message);
	}
	const rateLimited = types.has("RATE_LIMITED");
	const status = rateLimited || types.has("FORBIDDEN") || types.has("INSUFFICIENT_SCOPES") ? 403 : types.has("NOT_FOUND") ? 404 : 422;
	const graphqlTypes = everyEntryTyped && types.size > 0 ? { graphqlTypes: Object.freeze([...types].sort()) } : {};
	const readable = {
		status,
		message: messages.join("; ") || (types.size > 0 ? `GraphQL request failed with no error message (error types: ${[...types].sort().join(", ")})` : "GraphQL request failed with no error message or error type in the errors[] response"),
		body: JSON.stringify(errors),
		...rateLimited ? { rateLimited: true } : {},
		...graphqlTypes
	};
	return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}
/**
* Rate limiting in a 403 costume: primary exhaustion and secondary limits arrive as 403 once the throttling plugin gives
* up. A withheld response has no message to read, so its `rateLimited` flag stands in, as does a GraphQL RATE_LIMITED
* error, whose 200 the mapper rewrites to 403.
*/
function isRateLimitError(error) {
	return error.status === 429 || error.status === 403 && (error.rateLimited === true || /rate limit/i.test(error.message));
}
/**
* True when an error means the token lacks access, as opposed to a bad payload: a status fold, blind
* to the body. A message an endpoint declares as a definitive rejection (sections/contract/endpoints.ts)
* is classified ahead of this in throwFor, where the endpoint is known.
*/
function isPermissionError(error) {
	if (isRateLimitError(error)) return false;
	return error.status === 403 || error.status === 404;
}
//#endregion
//#region src/github/paginate.ts
async function paginate(api, path, extract = (data) => Array.isArray(data) ? data : null, stop, perPage = 100) {
	const items = [];
	const separator = path.includes("?") ? "&" : "?";
	for (let page = 1;; page++) {
		const result = await api.tryRequest("GET", `${path}${separator}per_page=${perPage}&page=${page}`);
		if ("error" in result) return { error: result.error };
		const chunk = extract(result.data);
		if (chunk === null) return { malformed: true };
		items.push(...chunk);
		if (stop?.(items) || chunk.length < perPage) return { items };
	}
}
//#endregion
//#region src/private-open.ts
const PRIVATE = Symbol("private");
function revealPrivate(value) {
	return value[PRIVATE];
}
//#endregion
//#region src/private.ts
/**
* The seal on private-repository data. A sealed value is NOT a T, so no sink
* or template accepts it; only the projections allowed to import
* private-open.ts can open it.
*/
/** Seal a value at the boundary where it is learned to be private. */
function markPrivate(value) {
	return { [PRIVATE]: value };
}
/** The guard consumers branch on instead of a parallel "redacted" flag. */
function isPrivate(value) {
	return typeof value === "object" && value !== null && PRIVATE in value;
}
//#endregion
//#region src/discovery/discover.ts
function sealFiltered(ref) {
	return ref.visibility === "public" ? {
		slug: ref.slug,
		visibility: "public"
	} : {
		slug: markPrivate(ref.slug),
		visibility: ref.visibility
	};
}
/**
* Fails closed for the REDACTION decision. `visibility` is a plain string in the API schema and optional on GHES, so
* the always-present `private` flag is the authority: private === true wins over any `visibility` (even a stale
* "public"), and with BOTH fields missing the repo is hidden, never exposed.
*/
function normalizeVisibility(repo) {
	if (repo.private === true) return "internal" === repo.visibility ? "internal" : "private";
	const visibility = repo.visibility;
	if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
	return repo.private === false ? "public" : "private";
}
/** Allowed values per discovery-filter input; the single source the input validation and types derive from. */
const VISIBILITY_FILTERS = [
	"all",
	"public",
	"private",
	"internal"
];
const ARCHIVED_FILTERS = [
	"skip",
	"include",
	"only"
];
const FORKS_FILTERS = [
	"include",
	"exclude",
	"only"
];
const AFFILIATIONS = [
	"owner",
	"collaborator",
	"organization_member"
];
/**
* Shared by the rule that emits it and formatSkipNotice, which special-cases it for the unarchive-to-manage prose; a
* literal in one place and not the other would silently drop that guidance.
*/
const ARCHIVED_REASON = "archived";
const DEFAULT_DISCOVERY_FILTERS = {
	visibility: "all",
	archived: "skip",
	forks: "include",
	affiliation: ["owner"],
	topics: [],
	exclude: []
};
function compileExcludePattern(pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}
function excludeMatches(pattern, slug) {
	const candidate = pattern.includes("/") ? slug : slug.split("/")[1] ?? slug;
	return compileExcludePattern(pattern).test(candidate);
}
function discoverRepos(api, filters) {
	const params = [`affiliation=${filters.affiliation.join(",")}`];
	if (filters.visibility === "public" || filters.visibility === "private") params.push(`visibility=${filters.visibility}`);
	const path = `/user/repos?${params.join("&")}`;
	return ResultAsync.fromPromise(paginate(api, path), (error) => ({
		code: "discovery-transport-failed",
		reason: error instanceof Error ? error.message : String(error)
	})).andThen((page) => {
		if ("error" in page) return err({
			code: "discovery-request-failed",
			path,
			status: page.error.status,
			message: page.error.message,
			denied: isPermissionError(page.error) || page.error.status === 401
		});
		if ("malformed" in page) return err({
			code: "discovery-response-not-a-list",
			path
		});
		return ok(applyFilters(page.items, filters));
	});
}
function applyFilters(repos, filters) {
	const rules = [
		(repo) => {
			const isInternal = repo.visibility === "internal";
			if (filters.visibility === "internal" && !isInternal) return "visibility=internal";
			if (filters.visibility === "private" && isInternal) return "visibility=private";
			return null;
		},
		(repo) => {
			if (filters.archived === "skip" && repo.archived) return ARCHIVED_REASON;
			if (filters.archived === "only" && !repo.archived) return "archived=only";
			return null;
		},
		(repo) => {
			if (filters.forks === "exclude" && repo.fork) return "forks=exclude";
			if (filters.forks === "only" && !repo.fork) return "forks=only";
			return null;
		},
		(repo) => {
			if (filters.topics.length > 0 && !(repo.topics ?? []).some((topic) => filters.topics.includes(topic.toLowerCase()))) return `topics (has none of: ${filters.topics.join(", ")})`;
			return null;
		},
		(repo) => {
			const hit = filters.exclude.find((pattern) => excludeMatches(pattern, repo.full_name));
			return hit ? `exclude pattern "${hit}"` : null;
		}
	];
	const kept = [];
	const filtered = /* @__PURE__ */ new Map();
	for (const repo of repos) {
		let reason = null;
		for (const rule of rules) {
			reason = rule(repo);
			if (reason) break;
		}
		const ref = {
			slug: repo.full_name,
			visibility: normalizeVisibility(repo)
		};
		if (!reason) {
			kept.push(ref);
			continue;
		}
		const group = filtered.get(reason);
		if (group) group.push(sealFiltered(ref));
		else filtered.set(reason, [sealFiltered(ref)]);
	}
	return {
		repos: kept,
		filtered: [...filtered.entries()].map(([reason, group]) => ({
			reason,
			repos: group
		}))
	};
}
/**
* One aggregate notice per filter reason: per-repo notices for a "*" fleet would flood the annotations UI (GitHub caps
* annotations per step). Under `redactPrivate` only public slugs are listed and hidden ones become a count; under
* `show` the operator opted into naming them, so the seal opens here.
*/
function formatSkipNotice(group, redactPrivate) {
	const named = redactPrivate ? group.repos.flatMap((repo) => repo.visibility === "public" ? [repo.slug] : []) : group.repos.map((repo) => isPrivate(repo.slug) ? revealPrivate(repo.slug) : repo.slug);
	const hidden = group.repos.length - named.length;
	const hiddenCount = `${hidden} private or internal ${hidden === 1 ? "repository" : "repositories"}`;
	const shown = named.slice(0, 20).join(", ");
	const more = named.length > 20 ? `, and ${named.length - 20} more` : "";
	const hiddenTail = hidden > 0 ? `, and ${hiddenCount}` : "";
	const names = named.length > 0 ? `: ${shown}${more}${hiddenTail}` : "";
	const count = named.length === 0 && hidden > 0 ? hiddenCount : `${group.repos.length} ${group.repos.length === 1 ? "repository" : "repositories"}`;
	if (group.reason === ARCHIVED_REASON) return `repos: "*" discovery skipped ${count} because settings writes fail on archived repositories; unarchive them to manage them${names}`;
	return `repos: "*" discovery skipped ${count} by ${group.reason}${names}`;
}
//#endregion
//#region src/discovery/repos-input.ts
function parseReposInput(raw) {
	const items = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
	if (items.includes("*")) {
		if (items.length > 1) return err({ code: "repos-input-wildcard-mixed" });
		return ok({
			slugs: [],
			discover: true
		});
	}
	const seen = /* @__PURE__ */ new Set();
	const invalid = /* @__PURE__ */ new Set();
	const duplicated = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!SLUG_RE.test(item)) {
			invalid.add(item);
			continue;
		}
		const key = item.toLowerCase();
		if (seen.has(key)) duplicated.add(item);
		seen.add(key);
	}
	if (invalid.size > 0 || duplicated.size > 0) return err({
		code: "repos-input-invalid-entries",
		invalid: [...invalid],
		duplicated: [...duplicated]
	});
	return ok({
		slugs: items,
		discover: false
	});
}
//#endregion
//#region src/sections/actions/schema.ts
/** The `actions:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const ActionsConfig = z.object({
	enabled: z.boolean().optional(),
	allowed_actions: z.enum([
		"all",
		"local_only",
		"selected"
	]).optional(),
	selected_actions: z.record(z.string(), z.unknown()).optional(),
	default_workflow_permissions: z.enum(["read", "write"]).optional(),
	can_approve_pull_request_reviews: z.boolean().optional(),
	access_level: z.enum([
		"none",
		"user",
		"organization"
	]).optional(),
	artifact_and_log_retention: z.object({ days: z.number() }).optional(),
	cache: z.strictObject({
		max_cache_retention_days: z.number().optional(),
		max_cache_size_gb: z.number().optional()
	}).optional(),
	oidc_customization_sub: z.object({
		use_default: z.boolean(),
		include_claim_keys: z.array(z.string()).optional(),
		use_immutable_subject: z.boolean().optional()
	}).optional(),
	fork_pr_contributor_approval: z.object({ approval_policy: z.string() }).optional(),
	fork_pr_workflows_private_repos: z.object({
		run_workflows_from_fork_pull_requests: z.boolean(),
		send_write_tokens_to_workflows: z.boolean(),
		send_secrets_and_variables: z.boolean(),
		require_approval_for_fork_pr_workflows: z.boolean()
	}).optional()
}).superRefine((declared, refineCtx) => {
	if (declared.selected_actions === void 0 || declared.allowed_actions === void 0) return;
	if (declared.allowed_actions !== "selected") refineCtx.addIssue({
		code: "custom",
		path: ["selected_actions"],
		message: `selected_actions is declared together with allowed_actions: "${declared.allowed_actions}", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions`
	});
}).meta({ id: "ActionsConfig" });
//#endregion
//#region src/sections/shared/renamed-key.ts
/** For `z.strictObject(shape, { error })`; `what` and `tail` are the prose around the two keys. */
function renamedKeyError(what, oldKey, newKey, tail) {
	return (issue) => {
		if (issue.code !== "unrecognized_keys" || !issue.keys.includes(oldKey)) return;
		const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
		return `Unrecognized key${issue.keys.length === 1 ? "" : "s"}: ${keys}; the ${what} key ${JSON.stringify(oldKey)} was renamed to ${JSON.stringify(newKey)} ${tail}`;
	};
}
//#endregion
//#region src/sections/shared/schema-helpers.ts
/**
* Imports ONLY zod and renamed-key.ts: a section schema importing src/schema.ts back would be a cycle
* whose top-level consts TDZ-crash at import time, so everything both sides need lives here.
* The smoke selector (.github/scripts/changed-sections.ts) derives this file's section fan-out from the import graph.
*/
const UndeclaredPolicySchema = z.enum(["keep", "delete"]).meta({ id: "UndeclaredPolicy" });
/**
* engine/layers.ts declares the same value set in its own Layering type and acts on the parsed value, so a
* new value lands in both. Described in shared.docs.yml and src/schema.docs.yml.
*/
const LayeringSchema = z.enum(["merge", "replace"]);
const wrapperKeyError = renamedKeyError("wrapper's policy", "undeclared", "_undeclared", "in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete");
/**
* loosen() (../contract/module.ts) recognizes this union and rewraps it with the routed check that keeps
* per-entry issue paths. The wrapper's definition name derives from the entry's own .meta({id}), so the
* document composition and a section's runtime derivation can never label one entry differently.
*
*   entry without an id                        -> throws at MODULE LOAD, not typecheck
*   z.toJSONSchema(SettingsFile)               -> fine: it resolves metadata by schema identity
*   a generator over z.globalRegistry's ids    -> sees only the last-registered wrapper (each call mints a fresh one under the same id)
*/
function knobbedList(entry, shape) {
	const entryName = z.globalRegistry.get(entry)?.id;
	if (entryName === void 0) throw new Error("knobbed(): the entry schema carries no .meta({id}) name to derive the wrapper's definition name from; give the entry config a .meta({id})");
	const wrapper = z.strictObject(shape({
		_undeclared: UndeclaredPolicySchema.optional(),
		entries: z.array(entry)
	}), { error: wrapperKeyError }).meta({ id: `UndeclaredPolicyList<${entryName}>` });
	return z.union([z.array(entry), wrapper]);
}
/**
* Only a TOP-LEVEL wrapper takes `_layering`: the layered merge combines sections, so only a
* section-level wrapper has layers below it to address.
*/
function knobbed(entry) {
	return knobbedList(entry, (knobs) => ({
		...knobs,
		_layering: LayeringSchema.optional()
	}));
}
/**
* A nested list (environments[].variables) is replaced wholesale by a higher layer, so `_layering`
* would be accepted and never act; the wrapper rejects it.
*/
function nestedKnobbed(entry) {
	return knobbedList(entry, (knobs) => knobs);
}
/** A repository-scope sealed secret entry (name + `$NAME` reference value). */
function sealedSecretConfig(id) {
	return z.object({
		name: z.string(),
		value: z.string()
	}).meta({ id });
}
//#endregion
//#region src/sections/actions_secrets/schema.ts
const ActionsSecretConfig = sealedSecretConfig("ActionsSecretConfig");
//#endregion
//#region src/sections/actions_variables/schema.ts
/** The actions_variables entry-config declaration (see index.ts for the section). */
const ActionsVariableConfig = z.object({
	name: z.string(),
	value: z.string()
}).meta({ id: "ActionsVariableConfig" });
//#endregion
//#region src/sections/agents_secrets/schema.ts
const AgentsSecretConfig = sealedSecretConfig("AgentsSecretConfig");
//#endregion
//#region src/sections/agents_variables/schema.ts
/** The agents_variables entry-config declaration (see index.ts for the section). */
const AgentsVariableConfig = z.object({
	name: z.string(),
	value: z.string()
}).meta({ id: "AgentsVariableConfig" });
//#endregion
//#region src/sections/autolinks/schema.ts
/** The `autolinks:` section's entry-config declaration (see src/schema.ts). */
const AutolinkConfig = z.object({
	key_prefix: z.string(),
	url_template: z.string(),
	is_alphanumeric: z.boolean().optional()
}).meta({ id: "AutolinkConfig" });
//#endregion
//#region src/sections/branches/schema.ts
/** The `branches:` section's entry-config declaration (see src/schema.ts). */
const NAME_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;
/** The lowercase "app" head is reserved for GitHub Apps. */
function parseBypassActor(raw) {
	const parts = raw.split("/");
	if (parts.length === 1) {
		const login = parts[0];
		return NAME_SEGMENT.test(login) ? {
			kind: "user",
			login
		} : null;
	}
	if (parts.length !== 2) return null;
	const [head, tail] = parts;
	if (!NAME_SEGMENT.test(head) || !NAME_SEGMENT.test(tail)) return null;
	return head === "app" ? {
		kind: "app",
		slug: tail
	} : {
		kind: "team",
		org: head,
		team: tail
	};
}
const ACTOR_FORM_ERROR = "each force_push_bypassers actor must be a bare user login (\"octocat\"), \"org/team-slug\" for a team, or \"app/slug\" for a GitHub App";
function duplicateIn(list) {
	const seen = /* @__PURE__ */ new Set();
	for (const item of list) {
		const key = item.toLowerCase();
		if (seen.has(key)) return item;
		seen.add(key);
	}
	return null;
}
const BranchProtectionConfig = z.looseObject({
	required_signatures: z.boolean({ error: "required_signatures must be an unquoted true or false (YAML parses \"no\"/\"off\"/\"yes\" as strings, not booleans), so the toggle direction is unambiguous" }).optional(),
	force_push_bypassers: z.array(z.string().refine((raw) => parseBypassActor(raw) !== null, { error: ACTOR_FORM_ERROR })).optional(),
	required_deployments: z.strictObject({ environments: z.array(z.string()) }).nullable().optional()
}).meta({ id: "BranchProtectionConfig" });
const BranchConfig = z.object({
	name: z.string(),
	protection: BranchProtectionConfig.nullable()
}).superRefine((entry, refineCtx) => {
	const routed = entry.protection;
	if (routed !== null) {
		const duplicateActor = duplicateIn(routed.force_push_bypassers ?? []);
		if (duplicateActor !== null) refineCtx.addIssue({
			code: "custom",
			path: ["protection", "force_push_bypassers"],
			message: `force_push_bypassers lists "${duplicateActor}" more than once (actor names are case-insensitive); keep one entry per actor`
		});
		const duplicateEnv = duplicateIn(routed.required_deployments === null ? [] : routed.required_deployments?.environments ?? []);
		if (duplicateEnv !== null) refineCtx.addIssue({
			code: "custom",
			path: [
				"protection",
				"required_deployments",
				"environments"
			],
			message: `required_deployments.environments lists "${duplicateEnv}" more than once (environment names are case-insensitive); keep one entry per environment`
		});
	}
}).meta({ id: "BranchConfig" });
const BranchesConfig = z.array(BranchConfig);
//#endregion
//#region src/sections/check_suite_preferences/schema.ts
/** The `check_suite_preferences:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const AutoTriggerCheckConfig = z.object({
	app_id: z.int(),
	setting: z.boolean()
}).meta({ id: "AutoTriggerCheckConfig" });
const CheckSuitePreferencesConfig = z.looseObject({ auto_trigger_checks: z.array(AutoTriggerCheckConfig) }).catchall(z.unknown()).meta({ id: "CheckSuitePreferencesConfig" });
//#endregion
//#region src/sections/code_quality_setup/schema.ts
/** The `code_quality_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const CodeQualitySetupConfig = z.object({
	state: z.enum(["configured", "not-configured"]).optional(),
	languages: z.array(z.string()).optional(),
	runner_type: z.enum(["standard", "labeled"]).optional(),
	runner_label: z.string().nullable().optional(),
	ai_findings_option: z.enum(["disabled", "on_push"]).optional()
}).meta({ id: "CodeQualitySetupConfig" });
//#endregion
//#region src/sections/code_scanning_default_setup/schema.ts
/** The `code_scanning_default_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const CodeScanningDefaultSetupConfig = z.object({
	state: z.enum(["configured", "not-configured"]).optional(),
	query_suite: z.enum(["default", "extended"]).optional(),
	languages: z.array(z.string()).optional(),
	runner_type: z.enum(["standard", "labeled"]).optional(),
	runner_label: z.string().nullable().optional(),
	threat_model: z.enum(["remote", "remote_and_local"]).optional()
}).meta({ id: "CodeScanningDefaultSetupConfig" });
//#endregion
//#region src/sections/codespaces_secrets/schema.ts
const CodespacesSecretConfig = sealedSecretConfig("CodespacesSecretConfig");
//#endregion
//#region src/sections/collaborators/schema.ts
/** The `collaborators:` section's entry-config declaration (see src/schema.ts). */
const CollaboratorConfig = z.object({
	username: z.string(),
	permission: z.string().optional()
}).meta({ id: "CollaboratorConfig" });
//#endregion
//#region src/sections/custom_properties/schema.ts
/** The `custom_properties:` section's entry-config declaration (see src/schema.ts). */
const CustomPropertyConfig = z.object({
	property_name: z.string(),
	value: z.union([
		z.string(),
		z.array(z.string()),
		z.boolean(),
		z.number(),
		z.null()
	])
}).meta({ id: "CustomPropertyConfig" });
//#endregion
//#region src/sections/dependabot_secrets/schema.ts
const DependabotSecretConfig = sealedSecretConfig("DependabotSecretConfig");
//#endregion
//#region src/sections/deploy_keys/schema.ts
/** The `deploy_keys:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const DeployKeyConfig = z.object({
	title: z.string(),
	key: z.string(),
	read_only: z.boolean().optional()
}).meta({ id: "DeployKeyConfig" });
//#endregion
//#region src/sections/environments/schema.ts
/**
* The `environments:` schema slice. Imports only zod and the leaf shared helpers, never root
* schema.ts: that cycle TDZ-crashes at import time on a top-level const.
*/
const DeploymentBranchPolicyConfig = z.object({
	name: z.string(),
	type: z.string().optional().meta({ enum: ["branch", "tag"] })
}).meta({ id: "DeploymentBranchPolicyConfig" });
const DeploymentProtectionRuleConfig = z.strictObject({ app: z.string() }).meta({ id: "DeploymentProtectionRuleConfig" });
const EnvironmentVariableConfig = z.object({
	name: z.string(),
	value: z.string()
}).meta({ id: "EnvironmentVariableConfig" });
const EnvironmentSecretConfig = z.strictObject({
	name: z.string(),
	value: z.string()
}).meta({ id: "EnvironmentSecretConfig" });
const EnvironmentConfig = z.object({
	name: z.string(),
	pinned: z.boolean().optional(),
	wait_timer: z.number().optional(),
	prevent_self_review: z.boolean().optional(),
	reviewers: z.array(z.object({
		type: z.enum(["User", "Team"]),
		id: z.number()
	})).optional(),
	deployment_branch_policy: z.object({
		protected_branches: z.boolean(),
		custom_branch_policies: z.boolean()
	}).nullable().optional(),
	deployment_branch_policies: nestedKnobbed(DeploymentBranchPolicyConfig).optional(),
	deployment_protection_rules: nestedKnobbed(DeploymentProtectionRuleConfig).optional(),
	variables: nestedKnobbed(EnvironmentVariableConfig).optional(),
	secrets: nestedKnobbed(EnvironmentSecretConfig).optional()
}).superRefine((entry, refineCtx) => {
	if (entry.secret !== void 0) refineCtx.addIssue({
		code: "custom",
		path: ["secret"],
		message: "environment secrets belong under the entry's `secrets` list, not a singular `secret` key; here it would pass through to the environment PUT verbatim and configure nothing"
	});
	if (entry.deployment_branch_policies === void 0) return;
	if (entry.deployment_branch_policy?.custom_branch_policies !== true) refineCtx.addIssue({
		code: "custom",
		path: ["deployment_branch_policies"],
		message: `the "${entry.name}" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off`
	});
}).meta({
	id: "EnvironmentConfig",
	if: { required: ["deployment_branch_policies"] },
	then: {
		required: ["deployment_branch_policy"],
		properties: { deployment_branch_policy: {
			type: "object",
			required: ["custom_branch_policies"],
			properties: { custom_branch_policies: { const: true } }
		} }
	}
});
const EnvironmentsConfig = z.array(EnvironmentConfig).superRefine((entries, refineCtx) => {
	const pinnedIndexes = entries.flatMap((entry, index) => entry.pinned === true ? [index] : []);
	if (pinnedIndexes.length > 10) refineCtx.addIssue({
		code: "custom",
		path: [pinnedIndexes[10], "pinned"],
		message: `the settings file declares ${pinnedIndexes.length} environments with pinned: true, but GitHub allows at most 10 pinned environments per repository. Declare pinned: true on at most 10 entries`
	});
});
const INTERACTION_LIMITS_ROUTED_KEYS = /* @__PURE__ */ new Set(["pull_request_creation_cap", "pull_request_creation_bypass"]);
const InteractionLimitsConfig = z.object({
	limit: z.string().optional(),
	expiry: z.string().optional(),
	pull_request_creation_cap: z.object({
		enabled: z.boolean({ error: "enabled must be an unquoted true or false (YAML parses \"no\"/\"off\"/\"yes\" as strings, not booleans), so the cap direction is unambiguous" }),
		max_open_pull_requests: z.number().optional()
	}).optional(),
	pull_request_creation_bypass: z.array(z.string()).optional()
}).superRefine((declared, refineCtx) => {
	const record = declared;
	const baseKeys = Object.keys(record).filter((key) => !INTERACTION_LIMITS_ROUTED_KEYS.has(key));
	if (baseKeys.length === 0 && record.pull_request_creation_cap === void 0 && record.pull_request_creation_bypass === void 0) refineCtx.addIssue({
		code: "custom",
		message: "declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass (or declare interaction_limits: null to clear the base limit)"
	});
	if (baseKeys.length > 0 && record.limit === void 0) refineCtx.addIssue({
		code: "custom",
		path: ["limit"],
		message: `key(s) [${baseKeys.join(", ")}] ride the base interaction-limits PUT, which requires a limit; declare limit alongside them, or remove them`
	});
	const bypass = record.pull_request_creation_bypass;
	if (!Array.isArray(bypass)) return;
	if (bypass.length > 100) refineCtx.addIssue({
		code: "custom",
		path: ["pull_request_creation_bypass"],
		message: `GitHub caps the bypass list at 100 users, but ${bypass.length} logins are declared; trim the list`
	});
	const seen = /* @__PURE__ */ new Map();
	for (const login of bypass) {
		const key = login.toLowerCase();
		const first = seen.get(key);
		if (first === void 0) seen.set(key, login);
		else refineCtx.addIssue({
			code: "custom",
			path: ["pull_request_creation_bypass"],
			message: `"${first}" and "${login}" name the same login (logins are case-insensitive); keep exactly one`
		});
	}
}).meta({ id: "InteractionLimitsConfig" }).nullable();
//#endregion
//#region src/sections/labels/schema.ts
/** The `labels:` section's entry-config declaration (see src/schema.ts). */
const LabelConfig = z.object({
	name: z.string(),
	color: z.string().optional(),
	description: z.string().optional(),
	new_name: z.string().optional()
}).meta({ id: "LabelConfig" });
//#endregion
//#region src/sections/milestones/schema.ts
/** The `milestones:` section's entry-config declaration (see src/schema.ts). */
const MilestoneConfig = z.object({
	title: z.string(),
	description: z.string().optional(),
	state: z.enum(["open", "closed"]).optional()
}).meta({ id: "MilestoneConfig" });
const PagesConfig = z.object({
	build_type: z.enum(["workflow", "legacy"]).optional(),
	source: z.object({
		branch: z.string(),
		path: z.string().optional()
	}).optional(),
	cname: z.string().nullable().optional(),
	https_enforced: z.boolean().optional(),
	public: z.boolean().optional()
}).meta({ id: "PagesConfig" }).nullable();
//#endregion
//#region src/sections/repository/schema.ts
/** The `repository:` section's entry-config declaration (see src/schema.ts). */
/**
* JSON.stringify on an arbitrary YAML value would throw on a cyclic alias and kill the run before
* the normal failure path, so containers describe by kind only; strings stay quoted so a YAML "no"
* is visibly a string.
*/
function describeToggleValue(value) {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return "a list";
	if (typeof value === "object") return "a mapping";
	return String(value);
}
function repositoryToggle() {
	return z.boolean({ error: (issue) => `${describeToggleValue(issue.input)} is not a boolean, so the toggle direction is ambiguous. Use unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans)` }).optional();
}
const RepositoryConfig = z.looseObject({
	topics: z.union([z.string(), z.array(z.string())]).optional(),
	enable_vulnerability_alerts: repositoryToggle(),
	enable_automated_security_fixes: repositoryToggle(),
	enable_private_vulnerability_reporting: repositoryToggle(),
	enable_git_lfs: repositoryToggle(),
	enable_immutable_releases: repositoryToggle(),
	enable_sponsorships: repositoryToggle(),
	issue_creation_policy: z.enum(["all", "collaborators_only"], { error: (issue) => `${describeToggleValue(issue.input)} is not a recognized policy. Use "all" (everyone) or "collaborators_only"` }).optional()
}).catchall(z.unknown()).meta({ id: "RepositoryConfig" });
//#endregion
//#region src/sections/rulesets/schema.ts
/** The `rulesets:` section's entry-config declaration (see src/schema.ts). */
const RulesetConfig = z.object({
	name: z.string(),
	target: z.enum([
		"branch",
		"tag",
		"push"
	]).optional(),
	enforcement: z.string().optional(),
	conditions: z.object({ ref_name: z.object({
		include: z.array(z.string()).optional(),
		exclude: z.array(z.string()).optional()
	}).optional() }).optional(),
	rules: z.array(z.object({
		type: z.string(),
		parameters: z.record(z.string(), z.unknown()).optional()
	})).optional(),
	bypass_actors: z.array(z.record(z.string(), z.unknown())).optional()
}).meta({ id: "RulesetConfig" });
//#endregion
//#region src/sections/secret_scanning_custom_patterns/schema.ts
/** The `secret_scanning_custom_patterns:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const DELIMITER_CLEAR_ERROR = "a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead";
const SecretScanningPatternConfig = z.object({
	name: z.string(),
	pattern: z.string(),
	start_delimiter: z.string().min(1, DELIMITER_CLEAR_ERROR).optional(),
	end_delimiter: z.string().min(1, DELIMITER_CLEAR_ERROR).optional(),
	must_match: z.array(z.string()).optional(),
	must_not_match: z.array(z.string()).optional()
}).meta({ id: "SecretScanningPatternConfig" });
//#endregion
//#region src/sections/teams/schema.ts
/** The `teams:` section's entry-config declaration (see src/schema.ts). */
const TeamConfig = z.object({
	name: z.string(),
	permission: z.string().optional()
}).meta({ id: "TeamConfig" });
const TeamsConfig = z.array(TeamConfig);
//#endregion
//#region src/sections/webhooks/schema.ts
/** The `webhooks:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const WebhookDeliveryConfig = z.looseObject({
	url: z.string(),
	content_type: z.string().optional(),
	secret: z.string().optional(),
	insecure_ssl: z.union([z.string(), z.number()]).optional()
}).catchall(z.unknown()).meta({ id: "WebhookDeliveryConfig" });
const WebhookConfig = z.object({
	name: z.literal("web").optional(),
	config: WebhookDeliveryConfig,
	events: z.array(z.string()).optional(),
	active: z.boolean().optional()
}).superRefine((entry, refineCtx) => {
	if (entry.secret !== void 0) refineCtx.addIssue({
		code: "custom",
		path: ["secret"],
		message: "a webhook secret belongs under config.secret, not at the entry level; here it would pass through verbatim and the hook would be created without a working secret"
	});
}).meta({ id: "WebhookConfig" });
//#endregion
//#region src/sections/workflows/schema.ts
/** The `workflows:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */
const WorkflowConfig = z.object({
	path: z.string(),
	state: z.enum(["active", "disabled"])
}).meta({ id: "WorkflowConfig" });
const WorkflowsConfig = z.array(WorkflowConfig);
//#endregion
//#region src/schema.ts
/**
* The settings document composed from the per-section slices (src/sections/<key>/schema.ts); this file adds only the
* document-level wrappers (the undeclared knob, .optional()), so an org/user document can compose its own from the same
* slices. Only DECLARED keys are ever applied or compared. The sections in PROBOT_PARITY_KEYS keep the Probot Settings
* app's plain-array form so an existing Probot config applies to them unchanged; every other section is an addition.
*
* descriptions                            -> the docs files (src/schema.docs.yml, each <key>.docs.yml)
* refine checks                           -> runtime-only, invisible to toJSONSchema, and they survive loosen()
* z.object (the default)                  -> published OPEN; loosen() makes it a passthrough looseObject at runtime
* z.strictObject                          -> additionalProperties: false, and loosen() keeps it strict (the wrapper, nested shapes)
* z.looseObject                           -> where the config type carries an index signature, so the inferred type keeps it
* runtime checks reading UNDECLARED keys  -> see them only through loosen()'s passthrough clone; the authored strip parse never runs at runtime
*/
const SettingsFile = z.object({
	repository: RepositoryConfig.optional(),
	labels: knobbed(LabelConfig).optional(),
	rulesets: knobbed(RulesetConfig).optional(),
	branches: BranchesConfig.optional(),
	environments: EnvironmentsConfig.optional(),
	autolinks: knobbed(AutolinkConfig).optional(),
	actions: ActionsConfig.optional(),
	actions_secrets: knobbed(ActionsSecretConfig).optional(),
	dependabot_secrets: knobbed(DependabotSecretConfig).optional(),
	codespaces_secrets: knobbed(CodespacesSecretConfig).optional(),
	agents_secrets: knobbed(AgentsSecretConfig).optional(),
	workflows: WorkflowsConfig.optional(),
	check_suite_preferences: CheckSuitePreferencesConfig.optional(),
	pages: PagesConfig.optional(),
	code_scanning_default_setup: CodeScanningDefaultSetupConfig.optional(),
	code_quality_setup: CodeQualitySetupConfig.optional(),
	collaborators: knobbed(CollaboratorConfig).optional(),
	teams: TeamsConfig.optional(),
	milestones: knobbed(MilestoneConfig).optional(),
	interaction_limits: InteractionLimitsConfig.optional(),
	actions_variables: knobbed(ActionsVariableConfig).optional(),
	agents_variables: knobbed(AgentsVariableConfig).optional(),
	webhooks: knobbed(WebhookConfig).optional(),
	custom_properties: knobbed(CustomPropertyConfig).optional(),
	deploy_keys: knobbed(DeployKeyConfig).optional(),
	secret_scanning_custom_patterns: knobbed(SecretScanningPatternConfig).optional(),
	_layering: LayeringSchema.optional()
}).meta({ id: "SettingsFile" });
/** Every recognized top-level section, in execution order. */
const SECTION_KEYS = [
	"repository",
	"labels",
	"rulesets",
	"environments",
	"branches",
	"autolinks",
	"actions",
	"actions_secrets",
	"dependabot_secrets",
	"codespaces_secrets",
	"agents_secrets",
	"workflows",
	"check_suite_preferences",
	"pages",
	"code_scanning_default_setup",
	"code_quality_setup",
	"collaborators",
	"teams",
	"milestones",
	"interaction_limits",
	"actions_variables",
	"agents_variables",
	"webhooks",
	"custom_properties",
	"deploy_keys",
	"secret_scanning_custom_patterns"
];
const UNDECLARED_POLICY_SECTIONS = [
	"labels",
	"rulesets",
	"autolinks",
	"actions_secrets",
	"dependabot_secrets",
	"codespaces_secrets",
	"agents_secrets",
	"collaborators",
	"milestones",
	"actions_variables",
	"agents_variables",
	"webhooks",
	"custom_properties",
	"deploy_keys",
	"secret_scanning_custom_patterns"
];
/** Sections whose plain form (no wrapper) matches the Probot Settings app schema; docs/start/migrating-from-probot.md is pinned against this list. */
const PROBOT_PARITY_KEYS = [
	"repository",
	"labels",
	"branches",
	"collaborators",
	"teams",
	"milestones"
];
/**
* Directives to the merge, not sections: declared on the document so the published schema types them.
* validateSectionShapes copies only SECTION_KEYS, so none of them reaches the apply path.
*/
const DOCUMENT_DIRECTIVE_KEYS = ["_layering"];
//#endregion
//#region src/sections/contract/endpoints.ts
function matchesRejection(rejection, error) {
	return error.status === rejection.status && error.message === rejection.message;
}
/** The declaration an error matches, if the endpoint declares one; a withheld message matches nothing. */
function definitiveRejection(endpoint, error) {
	return endpoint.rejections?.find((rejection) => matchesRejection(rejection, error));
}
function endpointMethod(route) {
	return route.slice(0, route.indexOf(" "));
}
function endpointPath(route) {
	return route.slice(route.indexOf(" ") + 1);
}
/** An accessGrade override wins: GitHub gates some reads at write. */
function endpointKind(endpoint) {
	return endpoint.accessGrade ?? (endpointMethod(endpoint.route) === "GET" ? "read" : "write");
}
/**
* A status the endpoint declares as a normal outcome must not throw, so the tolerant helpers default to
* this set and no call site restates the declaration.
*/
function toleratedStatuses(endpoint) {
	return Object.keys(endpoint.statuses).filter((key) => /^4\d\d$/.test(key)).map(Number).filter((status) => status !== 401 && status !== 429);
}
/**
* The one place a SECTION's path values are URL-encoded (github/repo-file.ts encodes its own). Only the
* RepoRef half of the context is read, so non-section callers (the private-report module) can pass a bare `{ repo }`.
*/
function expand(endpoint, ctx, params, query) {
	const route = endpoint.route;
	const supplied = new Set(Object.keys(params ?? {}));
	const path = endpointPath(route).replace(/{([a-z_]+)}/g, (_match, token) => {
		if (token === "owner") return encodeURIComponent(ctx.repo.owner);
		if (token === "repo") return encodeURIComponent(ctx.repo.name);
		const value = params?.[token];
		if (value === void 0) throw new Error(`BUG: ${route} needs a "${token}" param, but none was supplied`);
		supplied.delete(token);
		return encodeURIComponent(value);
	});
	if (supplied.size > 0) throw new Error(`BUG: ${route} was given unused param(s) [${[...supplied].join(", ")}]; they match no {token} in the route`);
	if (query && Object.keys(query).length > 0) return `${path}?${Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
	return path;
}
/** Read off the parsed RepoRef where expand() reads the REST halves, so no GraphQL section re-derives them. */
function repoVariables(ctx) {
	return {
		owner: ctx.repo.owner,
		repo: ctx.repo.name
	};
}
//#endregion
//#region src/sections/contract/permissions.ts
function samePermission(a, b) {
	if (a === "none" || b === "none") return a === b;
	const resources = new Set(a.repo);
	const others = new Set(b.repo);
	return a.org === b.org && resources.size === others.size && [...resources].every((resource) => others.has(resource));
}
/** Human-facing label for each PAT resource, as shown in the token UI. */
const RESOURCE_LABEL = {
	administration: "Administration",
	issues: "Issues",
	environments: "Environments",
	actions: "Actions",
	pages: "Pages",
	code_scanning_alerts: "Code scanning alerts",
	contents: "Contents",
	variables: "Variables",
	webhooks: "Webhooks",
	secrets: "Secrets",
	dependabot_secrets: "Dependabot secrets",
	codespaces_secrets: "Codespaces secrets",
	custom_properties: "Custom properties",
	secret_scanning_alerts: "Secret scanning alerts",
	agent_secrets: "Agent secrets",
	agent_variables: "Agent variables",
	checks: "Checks"
};
const RESOURCE_LABEL_ORG = { members: "Members" };
/**
* `access` defaults to "write" (a section both reads and writes), and a denial on an override endpoint
* passes overrideAdviceLevel (./errors.ts) so the advice asks for exactly the level the section needs.
* The output is user-facing: EXPECTED_GRANT in test/sections/registry.test.ts pins every grant character for character.
*/
function grantFor(permission, caveat, access = "write") {
	const level = access === "read" ? "read" : "read and write";
	const resources = permission.repo.map((resource) => `"${RESOURCE_LABEL[resource]}"`).join(" or ");
	const repoClause = permission.org ? `${resources} (${level}) under its Repository permissions` : `${resources} (${level}) under the PAT's Repository permissions`;
	const grant = `grant ${permission.org ? `"${RESOURCE_LABEL_ORG[permission.org]}" (read) under the PAT's Organization permissions and ` : ""}${repoClause}`;
	return caveat ? `${grant}; ${caveat}` : grant;
}
//#endregion
//#region src/sections/contract/module.ts
/** Used verbatim in permission errors; the Sections table on docs/reference/sections.md mirrors it in its PAT permission column. */
function sectionGrant(section) {
	return grantFor(section.permission, section.grantCaveat);
}
function endpointPermission(section, op) {
	return op.permission ?? section.permission;
}
/**
* REST and GraphQL flattened, so a derivation over "everything this section can call" cannot skip the
* GraphQL dictionary; _OperationDictionariesFlattened pins the flattening total.
*/
function sectionOperations(section) {
	return [...Object.entries(section.endpoints).map(([role, endpoint]) => ({
		role,
		wire: endpointMethod(endpoint.route) === "GET" ? "read" : "write",
		grade: endpointKind(endpoint),
		permission: endpointPermission(section, endpoint),
		phase: endpoint.phase ?? "plan"
	})), ...Object.entries(section.graphql ?? {}).map(([role, op]) => ({
		role,
		wire: op.kind,
		grade: op.kind,
		permission: endpointPermission(section, op),
		phase: op.phase ?? "plan"
	}))];
}
/** Execution-phase reads are excluded: only a thunk reaches them, so neither check mode nor preflight meets them. */
function planningReads(section) {
	return sectionOperations(section).filter((op) => op.wire === "read" && op.phase === "plan");
}
function readGating(section) {
	const reads = planningReads(section);
	const gated = reads.filter((op) => op.grade === "write").length;
	if (gated === 0) return "plain";
	return gated === reads.length ? "write-gated" : "mixed";
}
/** GraphQL reads are never here: a GraphQL read is gated at read (its kind IS the gate), so the REST dictionary is complete. */
function writeGatedReads(section) {
	return Object.values(section.endpoints).filter((endpoint) => endpoint.accessGrade === "write").map((endpoint) => ({
		route: endpoint.route,
		permission: endpointPermission(section, endpoint)
	}));
}
/**
* A section with no planning read classifies nothing before its first write, so it is "absent".
* Read by the fuzz oracle and the e2e mock.
*/
function denialPosture(section) {
	const primaries = Object.values(section.endpoints).flatMap((endpoint) => endpoint.primaryRead === void 0 ? [] : [endpoint]);
	if (primaries.length > 1) throw new Error(`BUG: ${section.key} declares primaryRead on ${primaries.length} endpoints; at most one read carries the 404 posture`);
	const primary = primaries[0];
	if (primary !== void 0 && primary.phase === "execution") throw new Error(`BUG: ${section.key} declares primaryRead on the execution-phase read ${primary.route}; plan() never issues it, so no denied first read can be classified from it`);
	const posture = primary?.primaryRead?.notFound;
	if (posture !== void 0) return posture;
	if (planningReads(section).length > 0) throw new Error(`BUG: ${section.key} reads but declares no primaryRead posture, so a denied first read cannot be classified`);
	return "absent";
}
/**
* Derived from the section's operation list rather than restated per section: a planning read added
* later would make the cannot-verify claim false, so the helper throws instead of letting the prose drift
* (an execution-phase read, which check mode never issues, does not count).
*/
function writeOnlyCheckNote(section, opts) {
	if (planningReads(section).length > 0) throw new Error(`BUG: ${section.key} declares a read operation, so it is not write-only and the cannot-verify note would be false; diff against the read instead`);
	return `${section.key}: GitHub exposes no read endpoint for ${opts.resource}, so check mode cannot verify them; apply re-asserts ${opts.reasserts} on every run`;
}
/**
* zod's object schemas accept any non-array object, so a YAML-tagged scalar like !!timestamp (a Date)
* would validate as an empty mapping and silently configure nothing.
*
*   scalars, arrays, null    -> pass through, so the piped shape reports its own error
*   applied by               -> the sections whose whole value is one mapping (repository, the setups, interaction_limits)
*   document-wide backstop   -> findNonPlain in engine/validate.ts
*/
function requirePlainMapping(shape) {
	return z.unknown().superRefine((value, ctx) => {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) ctx.addIssue({
				code: "custom",
				message: "Invalid input: expected a plain mapping (a YAML-tagged value like !!timestamp parses to another type)"
			});
		}
	}).pipe(shape);
}
function defOf$1(schema) {
	return schema._zod.def;
}
function cloneWith(schema, patch) {
	const def = schema._zod.def;
	return z.util.clone(schema, {
		...def,
		...patch
	});
}
/**
* Every plain (strip) object becomes a passthrough looseObject, so unknown keys ride through to GitHub
* and superRefine checks reading undeclared keys can see them. Preserved as authored:
*
*   strictObject             -> stays strict
*   refine/superRefine       -> survives (clones carry the checks); one on the knobbed union itself throws instead
*   knobbed-section union    -> rewrapped as a container-routed check, so a failing entry keeps its issue path
*                               (`labels[2].name`) instead of a plain union's pathless "Invalid input"
*   unrecognized CONTAINER   -> throws, rather than ship a shape that silently skipped loosening
*/
function loosen(schema) {
	const def = defOf$1(schema);
	switch (def.type) {
		case "object": {
			const shape = def.shape ?? {};
			return cloneWith(schema, {
				shape: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, loosen(value)])),
				catchall: def.catchall === void 0 ? z.unknown() : loosen(def.catchall)
			});
		}
		case "array": return cloneWith(schema, { element: loosen(def.element) });
		case "record": return cloneWith(schema, { valueType: loosen(def.valueType) });
		case "optional":
		case "nullable": return cloneWith(schema, { innerType: loosen(def.innerType) });
		case "union": {
			const options = def.options ?? [];
			const knob = detectKnobUnion(options);
			if (knob !== null) {
				if ((def.checks?.length ?? 0) > 0) throw new Error("loosen(): a knobbed-section union carries its own refinements, which the routed rewrap would silently drop - attach them to the entry array or the wrapper");
				return routedListShape(loosen(knob.list), loosen(knob.wrapper));
			}
			return cloneWith(schema, { options: options.map(loosen) });
		}
		default:
			if (!LOOSEN_LEAF_TYPES.has(def.type)) throw new Error(`loosen(): unhandled schema type "${def.type}" - teach loosen() its runtime derivation before authoring it in src/schema.ts`);
			return schema;
	}
}
const LOOSEN_LEAF_TYPES = /* @__PURE__ */ new Set([
	"string",
	"number",
	"boolean",
	"enum",
	"literal",
	"unknown",
	"never",
	"null"
]);
/** The entry array plus the strict {_undeclared, entries} wrapper (knobbed() in ../shared/schema-helpers.ts). */
function detectKnobUnion(options) {
	if (options.length !== 2) return null;
	const list = options.find((option) => defOf$1(option).type === "array");
	const wrapper = options.find((option) => {
		const def = defOf$1(option);
		return def.type === "object" && def.catchall !== void 0 && defOf$1(def.catchall).type === "never" && def.shape?.entries !== void 0;
	});
	return list !== void 0 && wrapper !== void 0 ? {
		list,
		wrapper
	} : null;
}
/** A transform, not a union, so a failing entry keeps its precise issue path and the output is the routed shape's parsed data. */
function routedListShape(list, wrapper) {
	return z.custom(() => true).transform((value, ctx) => {
		const shape = Array.isArray(value) ? list : typeof value === "object" && value !== null ? wrapper : null;
		if (shape === null) {
			ctx.addIssue({
				code: "custom",
				message: `Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_undeclared" policy), but this section parsed as ${value === null ? "null" : typeof value}`
			});
			return z.NEVER;
		}
		const parsed = shape.safeParse(value);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
			return z.NEVER;
		}
		return parsed.data;
	});
}
/**
* `defaultPolicy` is REQUIRED on purpose: a nested list cannot derive its default from its section's
* undeclaredDefault, so the call site always says which applies. Entries are returned by reference.
*/
function undeclaredPolicy(declared, defaultPolicy) {
	if (Array.isArray(declared)) return {
		policy: defaultPolicy,
		entries: declared
	};
	const wrapped = declared;
	return {
		policy: wrapped._undeclared ?? defaultPolicy,
		entries: wrapped.entries
	};
}
/** The parameter type admits only the knobbed sections, so asking for a non-enumerating section's default is a compile error, not a runtime BUG. */
function defaultUndeclaredPolicy(section) {
	return section.undeclaredDefault;
}
/**
* Only the WORDS live here, so the keep-note cannot drift between sections; which branch runs stays in
* each section's own control flow on purpose.
*/
function undeclaredNote(opts) {
	const state = opts.state ?? "exists on the repo but is not declared";
	const add = opts.add ?? "it";
	const manage = opts.manage ?? "it";
	return `${opts.subject} ${state} in the settings file; kept under "_undeclared: keep" - add ${add} to the settings file to manage ${manage}, or set "_undeclared: delete" to have apply ${opts.action}`;
}
/**
* The knob clause derives from the list's DEFAULT policy so it can never contradict the section: under a
* keep default this branch is reachable only because the file set `_undeclared: delete`, so the line says
* so. Pass the same default the policy was unwrapped with.
*/
function undeclaredDrift(listDefault, opts) {
	const knob = listDefault === "keep" ? " and \"_undeclared: delete\" is set" : "";
	const state = opts.state ?? "not in the settings file";
	const add = opts.add ?? "it";
	const keep = opts.keep ?? "it";
	return `${opts.label}: undeclared - ${state}${knob}, so apply will ${opts.action}; add ${add} to the settings file to keep ${keep}`;
}
//#endregion
//#region src/engine/diff.ts
function isScalar(value) {
	return typeof value !== "object" || value === null;
}
/** Marks a live field the object has no own key for, as opposed to one holding undefined. */
const ABSENT = Symbol("no such live key");
function deltas(desired, live, opts = {}) {
	const out = [];
	walk(desired, live, [], "", opts, out);
	return out;
}
function walk(desired, live, path, keyPath, opts, out) {
	const absent = live === ABSENT;
	const liveValue = absent ? void 0 : live;
	if (desired === null || desired === void 0) {
		if (liveValue === null || liveValue === void 0 || liveValue === "") return;
		out.push({
			kind: "mismatch",
			path,
			desired,
			live: liveValue
		});
		return;
	}
	if (Array.isArray(desired)) {
		if (!Array.isArray(liveValue)) {
			out.push(absent ? {
				kind: "phantom",
				path,
				desired
			} : {
				kind: "mismatch",
				path,
				desired,
				live: liveValue
			});
			return;
		}
		walkList(desired, liveValue, path, keyPath, opts, out);
		return;
	}
	if (typeof desired === "object") {
		if (typeof liveValue !== "object" || liveValue === null || Array.isArray(liveValue)) {
			out.push(absent ? {
				kind: "phantom",
				path,
				desired
			} : {
				kind: "mismatch",
				path,
				desired,
				live: liveValue
			});
			return;
		}
		const liveRecord = liveValue;
		for (const [key, value] of Object.entries(desired)) walk(value, Object.hasOwn(liveRecord, key) ? liveRecord[key] : ABSENT, [...path, key], keyPath === "" ? key : `${keyPath}.${key}`, opts, out);
		return;
	}
	if (desired === "" && (liveValue === null || liveValue === void 0)) return;
	if (desired !== liveValue) out.push(absent ? {
		kind: "phantom",
		path,
		desired
	} : {
		kind: "mismatch",
		path,
		desired,
		live: liveValue
	});
}
function typeOf(item) {
	return typeof item === "object" && item !== null && "type" in item ? String(item.type) : null;
}
function itemKey(item, key, keyPath, side) {
	if (typeof item !== "object" || item === null || !Object.hasOwn(item, key)) throw new Error(`BUG: matchBy pairs the list "${keyPath}" by "${key}", but a ${side} item carries no such key: ${JSON.stringify(item)}`);
	return String(item[key]);
}
function walkList(desired, live, path, keyPath, opts, out) {
	const declaredKey = opts.matchBy?.[keyPath];
	if (declaredKey !== void 0) {
		const liveByKey = /* @__PURE__ */ new Map();
		for (const item of live) {
			const key = itemKey(item, declaredKey, keyPath, "live");
			if (liveByKey.has(key)) throw new Error(`BUG: matchBy pairs the list "${keyPath}" by "${declaredKey}", but the live list repeats ${JSON.stringify(key)}`);
			liveByKey.set(key, item);
		}
		walkKeyed(desired, liveByKey, declaredKey, path, keyPath, opts, out);
		return;
	}
	if (opts.matchBy === void 0) {
		const desiredTypes = desired.map(typeOf);
		const liveTypes = live.map(typeOf);
		if (desired.length > 0 && desiredTypes.every((t) => t !== null) && new Set(desiredTypes).size === desiredTypes.length && liveTypes.every((t) => t !== null) && new Set(liveTypes).size === liveTypes.length) {
			const liveByType = /* @__PURE__ */ new Map();
			for (const item of live) liveByType.set(typeOf(item), item);
			walkKeyed(desired, liveByType, "type", path, keyPath, opts, out);
			return;
		}
	}
	if (desired.length > 0 && desired.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
		const liveItems = [...live];
		for (const [index, item] of desired.entries()) {
			const matchIndex = liveItems.findIndex((candidate) => deltas(item, candidate, opts).length === 0);
			if (matchIndex === -1) out.push({
				kind: "missing",
				path: [...path, index],
				desired: item,
				match: "shape"
			});
			else liveItems.splice(matchIndex, 1);
		}
		for (const leftover of liveItems) out.push({
			kind: "undeclared",
			path,
			live: leftover,
			match: "shape"
		});
		return;
	}
	const desiredSet = new Set(desired.map((v) => JSON.stringify(v)));
	const liveSet = new Set(live.map((v) => JSON.stringify(v)));
	for (const [index, value] of desired.entries()) {
		const json = JSON.stringify(value);
		if (!liveSet.has(json) && desired.findIndex((v) => JSON.stringify(v) === json) === index) out.push({
			kind: "missing",
			path,
			desired: value,
			match: "value"
		});
	}
	for (const [index, value] of live.entries()) {
		const json = JSON.stringify(value);
		if (!desiredSet.has(json) && live.findIndex((v) => JSON.stringify(v) === json) === index) out.push({
			kind: "undeclared",
			path,
			live: value,
			match: "value"
		});
	}
}
function walkKeyed(desired, liveByKey, key, path, keyPath, opts, out) {
	const declared = /* @__PURE__ */ new Set();
	for (const item of desired) {
		const itemId = itemKey(item, key, keyPath, "desired");
		if (declared.has(itemId)) throw new Error(`BUG: matchBy pairs the list "${keyPath}" by "${key}", but the declared list repeats ${JSON.stringify(itemId)}`);
		declared.add(itemId);
		const match = liveByKey.get(itemId);
		const at = [...path, { key: itemId }];
		if (match === void 0) out.push({
			kind: "missing",
			path: at,
			desired: item,
			match: "key"
		});
		else walk(item, match, at, keyPath, opts, out);
	}
	for (const [itemId, item] of liveByKey) if (!declared.has(itemId)) out.push({
		kind: "undeclared",
		path: [...path, { key: itemId }],
		live: item,
		match: "key"
	});
}
function renderPath(root, path) {
	return `${root}${path.map((step) => typeof step === "string" ? `.${step}` : typeof step === "number" ? `[${step}]` : `[${step.key}]`).join("")}`;
}
function mismatchLine(at, desired, live) {
	if (desired === null || desired === void 0) return `${at}: expected empty, live has ${JSON.stringify(live)}`;
	if (Array.isArray(desired)) return `${at}: expected list, live has ${JSON.stringify(live)}`;
	if (!isScalar(desired)) return `${at}: expected object, live has ${JSON.stringify(live)}`;
	if (live === void 0) return `${at}: declared ${JSON.stringify(desired)} but the API response has no such field (new or write-only field?)`;
	return `${at}: ${JSON.stringify(desired)} != ${JSON.stringify(live)}`;
}
function renderDelta(root, delta) {
	const at = renderPath(root, delta.path);
	switch (delta.kind) {
		case "mismatch": return mismatchLine(at, delta.desired, delta.live);
		case "phantom": return mismatchLine(at, delta.desired, void 0);
		case "missing": return delta.match === "key" ? `${at}: missing live` : delta.match === "shape" ? `${at}: no matching live entry for ${JSON.stringify(delta.desired)}` : `${at}: missing ${JSON.stringify(delta.desired)}`;
		case "undeclared": return delta.match === "key" ? `${at}: present live but not declared` : delta.match === "shape" ? `${at}: live entry not declared: ${JSON.stringify(delta.live)}` : `${at}: unexpected ${JSON.stringify(delta.live)}`;
	}
}
function subsetDiff(desired, live, path) {
	return deltas(desired, live).map((delta) => renderDelta(path, delta));
}
/** Sections whose write is gated by a comparison note these, so the gating keys do not silently rewrite on every run. */
function phantomKeys(desired, live) {
	return deltas(desired, live).flatMap((delta) => delta.kind === "phantom" && delta.path.length === 1 && typeof delta.path[0] === "string" ? [delta.path[0]] : []);
}
function phantomNote(prefix, keys, noun, rewrite) {
	return `${prefix}: declared key(s) ${keys.map((k) => `"${k}"`).join(", ")} do not exist on the live ${noun}, so if GitHub ignores them ${rewrite} on every apply without converging. Fix the key name, or remove it from the settings file`;
}
//#endregion
//#region src/sections/contract/live.ts
/**
* Schemas stay loose objects, so passthrough fields survive for subsetDiff/phantomKeys. `describe` names
* the concrete resource (an environment, a page) the path template alone cannot spell.
*/
function parseLive(section, endpoint, schema, data, describe) {
	const parsed = schema.safeParse(data);
	if (parsed.success) return parsed.data;
	const issues = parsed.error.issues;
	const shown = issues.slice(0, 3).map((issue) => {
		return `${issue.path.map((part) => typeof part === "number" ? `[${part}]` : `.${String(part)}`).join("").replace(/^\./, "") || "(body)"}: ${issue.message}`;
	});
	const more = issues.length > 3 ? `; and ${issues.length - 3} more issue(s)` : "";
	const where = describe === void 0 ? "" : ` (${describe})`;
	throw new Error(`${section.key}: ${endpointMethod(endpoint.route)} ${endpointPath(endpoint.route)}${where} returned a body outside the documented shape - ${shown.join("; ")}${more}. Check the "api-version" input against the GitHub REST docs for this endpoint`);
}
//#endregion
//#region src/sections/contract/graphql.ts
/**
* RATE_LIMITED is absent on purpose (throttling is a transport concern every operation handles alike),
* as is INSUFFICIENT_SCOPES (a wrong token; the transport folds it into the 403 class).
*/
const GRAPHQL_TOLERABLE_ERRORS = [
	"FORBIDDEN",
	"NOT_FOUND",
	"UNPROCESSABLE"
];
/**
* `V` is spelled explicitly while `const O` infers the LITERAL declaration, so the exact `outcomes` keys
* and the query's template shape survive instead of widening. That literal type is what lets
* tryCallGraphql's `tolerate` reject undeclared outcome types at compile time and checks a connection op's $cursor.
*/
function graphqlOp() {
	return (op) => op;
}
/** The tolerated outcomes, as toleratedStatuses reads an EndpointDecl; tryCallGraphql defaults to this set. */
function toleratedGraphqlErrors(op) {
	return GRAPHQL_TOLERABLE_ERRORS.filter((type) => op.outcomes[type] !== void 0);
}
//#endregion
//#region src/sections/contract/errors.ts
var PermissionDenied = class extends Error {
	section;
	detail;
	status;
	constructor(section, detail, status) {
		super(`${section}: ${detail}`);
		this.section = section;
		this.detail = detail;
		this.status = status;
	}
};
/**
* Graded by the SECTION's need so the fix costs one round trip: apply-mode preflight probes with reads,
* so read-level advice on a permission the section also writes with (the OIDC GET/PUT pair) would pass
* preflight and fail on the write. A permission the section only reads with still advises read.
*/
function overrideAdviceLevel(section, effective) {
	return sectionOperations(section).some((operation) => samePermission(operation.permission, effective) && operation.grade === "write") ? "write" : "read";
}
/** Outcome and rejection prose is lowercase (it doubles as the declaration's description); in a message it starts a sentence. */
function sentence(clause) {
	return clause.charAt(0).toUpperCase() + clause.slice(1);
}
function throwFor(section, method, path, error, context) {
	const cause = `${context?.operation ? `${context.operation} failed - ` : ""}${method} ${path}: ${error.status} ${error.message}`;
	if (isRateLimitError(error)) throw new Error(`${section.key}: ${cause}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`);
	const op = context?.op;
	const rejection = op !== void 0 && "route" in op ? definitiveRejection(op, error) : void 0;
	if (rejection !== void 0) throw new Error(`${section.key}: ${cause}. ${sentence(rejection.advice)}`);
	const effective = op ? endpointPermission(section, op) : void 0;
	if (isPermissionError(error) && effective !== "none") {
		const alsoMissing = error.status === 404 ? " (a 404 here can also mean the resource does not exist)" : "";
		const denialHint = context?.op?.denialHint ? `. Note: ${context.op.denialHint}` : "";
		const grant = effective !== void 0 && !samePermission(effective, section.permission) ? grantFor(effective, void 0, overrideAdviceLevel(section, effective)) : sectionGrant(section);
		throw new PermissionDenied(section.key, `the token was denied ${cause}${alsoMissing}. To fix, ${grant}${denialHint}`, error.status);
	}
	if (error.status >= 500) throw new Error(`${section.key}: ${cause}. GitHub returned a server error; re-run the workflow, and retry later if it persists`);
	if (error.status === 401) throw new Error(`${section.key}: ${cause}. The token was rejected as invalid or expired; update the token input (or the secret it reads) with a valid, unexpired PAT`);
	const advice = op === void 0 ? void 0 : "outcomes" in op ? toleratedGraphqlErrors(op).filter((type) => error.graphqlTypes?.includes(type)).map((type) => op.outcomes[type]).filter((outcome) => outcome !== void 0).map(sentence).join(". ") : op.hints?.[error.status];
	const hint = advice ? `. ${advice}` : "";
	const docs = error.documentationUrl ? `. The fields and values this endpoint accepts are documented at ${error.documentationUrl}` : "";
	throw new Error(`${section.key}: ${cause}. The API rejected the request; fix the "${section.key}" values in the settings file to satisfy the message above${hint}${docs}`);
}
//#endregion
//#region src/sections/contract/requests.ts
/**
* Permission failures become PermissionDenied (the orchestrator's partial-success policy handles them);
* everything else is a hard error carrying the API's message (withheld for a secret-bearing request, see github/api.ts).
*/
async function call(ctx, section, endpoint, ...args) {
	return callDeclared(ctx, section, endpoint, args[0] ?? {});
}
/**
* The erased core of call(): the plan executor reaches it with an endpoint resolved from a planned role,
* whose params were typed when the plan was built; a handler calls call(), where the route type checks the params.
*/
async function callDeclared(ctx, section, endpoint, opts) {
	const method = endpointMethod(endpoint.route);
	const path = expand(endpoint, ctx, opts.params, opts.query);
	const result = await ctx.api.tryRequest(method, path, opts.payload);
	if ("error" in result) throwFor(section, method, path, result.error, {
		operation: opts.describe,
		op: endpoint
	});
	return result.data;
}
/** Tolerated statuses come back as { error }; an explicit `tolerate` only ever tolerates FEWER than declared. */
async function tryCall(ctx, section, endpoint, ...args) {
	const opts = args[0];
	return tryCallDeclared(ctx, section, endpoint, {
		...opts,
		tolerated: declaredTolerance(endpoint, opts?.tolerate)
	});
}
/**
* An explicit list may only name declared tolerable statuses (the erased executor could spell another,
* so this boundary refuses it); advisory tolerates all.
*/
function declaredTolerance(endpoint, explicit) {
	if (explicit !== void 0) {
		const declared = toleratedStatuses(endpoint);
		const undeclared = explicit.filter((status) => !declared.includes(status));
		if (undeclared.length > 0) throw new Error(`BUG: ${endpoint.route} was asked to tolerate status(es) ${undeclared.join(", ")}, which it does not declare as a tolerable error status; a tolerance may only name declared 4xx statuses other than 401 and 429`);
		return (status) => explicit.includes(status);
	}
	if (endpoint.advisory === true) return () => true;
	const declared = toleratedStatuses(endpoint);
	return (status) => declared.includes(status);
}
/** The erased core of tryCall(). A rate limit is a transport failure whatever status carries it: never tolerated. */
async function tryCallDeclared(ctx, section, endpoint, opts) {
	const method = endpointMethod(endpoint.route);
	const path = expand(endpoint, ctx, opts.params, opts.query);
	const result = await ctx.api.tryRequest(method, path, opts.payload);
	if ("error" in result && (isRateLimitError(result.error) || !opts.tolerated(result.error.status))) throwFor(section, method, path, result.error, {
		operation: opts.describe,
		op: endpoint
	});
	return result;
}
/**
* The shared idiom behind "does this branch/site/environment/toggle exist" probes: tolerated statuses
* read as { missing: true }. Pass `tolerate` only to tolerate FEWER than declared.
*/
async function probeAbsent(ctx, section, endpoint, ...args) {
	const options = args[0];
	const path = expand(endpoint, ctx, options?.params, options?.query);
	const tolerated = declaredTolerance(endpoint, options?.tolerate);
	const result = await ctx.api.tryRequest("GET", path, void 0, { accept: options?.accept });
	if ("error" in result) {
		if (!isRateLimitError(result.error) && tolerated(result.error.status)) return { missing: true };
		throwFor(section, "GET", path, result.error, {
			operation: options?.describe,
			op: endpoint
		});
	}
	return { data: result.data };
}
/** `extract` adapts the response shape (bare array, or a {total_count, <key>: []} envelope). */
async function listPages(ctx, section, endpoint, path, extract, shape) {
	const result = await paginate(ctx.api, path, extract, void 0, endpoint.pageSize);
	if ("error" in result) throwFor(section, "GET", path, result.error, { op: endpoint });
	if ("malformed" in result) throw new Error(`${section.key}: GET ${path} returned a JSON value without ${shape}, so the response cannot be paginated. Check the "api-version" input against the GitHub REST docs for this endpoint`);
	return result.items;
}
async function listAll(ctx, section, endpoint, ...args) {
	const opts = args[0];
	return listPages(ctx, section, endpoint, expand(endpoint, ctx, opts?.params, opts?.query), (data) => Array.isArray(data) ? data : null, "a list");
}
/** For endpoints wrapping the list in an envelope (GET /actions/workflows returns {total_count, workflows: []}). */
async function listAllEnveloped(ctx, section, endpoint, envelopeKey, ...args) {
	const opts = args[0];
	return listPages(ctx, section, endpoint, expand(endpoint, ctx, opts?.params, opts?.query), (data) => {
		const chunk = data?.[envelopeKey];
		return Array.isArray(chunk) ? chunk : null;
	}, `a "${envelopeKey}" list`);
}
/** The GraphQL sibling of call(); the failing request renders as `GRAPHQL <opName>` where a REST error shows method and path. */
async function callGraphql(ctx, section, op, variables, opts) {
	const result = await ctx.api.tryGraphql(op, variables, ctx.repo.slug);
	if ("error" in result) throwFor(section, "GRAPHQL", op.name, result.error, {
		operation: opts?.describe,
		op
	});
	return result.data;
}
/**
* EVERY observed type must be declared: the HTTP status is a lossy fold (a mixed [FORBIDDEN, UNPROCESSABLE]
* response and a pure FORBIDDEN both land on 403), so only the full type set says what happened. An
* untyped or HTTP-level failure is never tolerable.
*/
function graphqlErrorTolerated(error, tolerate) {
	const observed = error.graphqlTypes;
	return observed !== void 0 && observed.length > 0 && observed.every((type) => tolerate.includes(type));
}
/**
* Tolerated error types come back as { error }; the set defaults to the declared outcomes, and an explicit
* `tolerate` only tolerates FEWER. Tolerance reads the OBSERVED GraphQL types (graphqlErrorTolerated),
* never the folded HTTP status.
*/
async function tryCallGraphql(ctx, section, op, variables, opts) {
	const tolerate = opts?.tolerate ?? toleratedGraphqlErrors(op);
	const result = await ctx.api.tryGraphql(op, variables, ctx.repo.slug);
	if ("error" in result) {
		if (!graphqlErrorTolerated(result.error, tolerate)) throwFor(section, "GRAPHQL", op.name, result.error, {
			operation: opts?.describe,
			op
		});
	}
	return result;
}
/**
* The cursor loop lives here so paging cannot drift between sections. Declared error outcomes come back
* as { error } only on the FIRST page: absence describes the whole resource, and a tolerated type
* mid-walk means the connection vanished under the loop.
*/
async function listGraphqlConnection(ctx, section, op, variables) {
	const path = op.connection.path;
	const items = [];
	let cursor = null;
	for (;;) {
		const result = await ctx.api.tryGraphql(op, {
			...variables,
			cursor
		}, ctx.repo.slug);
		if ("error" in result) {
			if (cursor === null && graphqlErrorTolerated(result.error, toleratedGraphqlErrors(op))) return result;
			throwFor(section, "GRAPHQL", op.name, result.error, { op });
		}
		const connection = path.reduce((node, key) => node?.[key], result.data);
		const nodes = connection?.nodes;
		const pageInfo = connection?.pageInfo;
		if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== "boolean") throw new Error(`${section.key}: GRAPHQL ${op.name} returned a response without a "${path.join(".")}" connection carrying nodes and pageInfo{hasNextPage, endCursor}, so the list cannot be paginated. The operation's query must select both under that path`);
		items.push(...nodes);
		if (!pageInfo.hasNextPage) return { items };
		const endCursor = pageInfo.endCursor;
		if (typeof endCursor !== "string" || endCursor === cursor) throw new Error(`${section.key}: GRAPHQL ${op.name} reported hasNextPage without a new endCursor at "${path.join(".")}", so the pagination cannot advance. The operation's query must select pageInfo{hasNextPage, endCursor}`);
		cursor = endCursor;
	}
}
/**
* Shared by the declared-side and live-side duplicate rejections, so both name a collision the same way.
*/
function collidingPairs(items, keyOf, describe) {
	const seen = /* @__PURE__ */ new Map();
	const collisions = [];
	for (const item of items) {
		const key = keyOf(item);
		const first = seen.get(key);
		if (first !== void 0) {
			collisions.push(`"${first}" and "${describe(item)}"`);
			continue;
		}
		seen.set(key, describe(item));
	}
	return collisions;
}
/**
* Two entries resolving to one natural key would fight each other on every run. Every collision is
* collected and reported once (each against the first entry under its key), so N duplicates cost one run to discover.
*/
function rejectDuplicates(section, items, keyOf, describe) {
	const collisions = collidingPairs(items, keyOf, describe);
	if (collisions.length > 0) throw new Error(`${section.key}: the settings file declares entries that name the same ${section.key} entry: ${collisions.join("; ")}. Keep exactly one entry per resource`);
}
//#endregion
//#region src/sections/contract/plan.ts
/**
* The loose schemas type a declared value `unknown`, and YAML can spell what JSON cannot (an alias cycle,
* a tagged scalar), so this ONE walk proves plainness instead of a cast per section.
*/
function plainData(value) {
	const render = (path) => path.length === 0 ? "(root)" : path.map((segment, index) => {
		if (typeof segment === "number") return `[${segment}]`;
		return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${index === 0 ? "" : "."}${segment}` : `[${JSON.stringify(segment)}]`;
	}).join("");
	const reject = (path, reason) => {
		throw new Error(`BUG: a planned payload carries a value JSON cannot carry at ${render(path)}: ${reason}; request data must be plain`);
	};
	const ancestors = /* @__PURE__ */ new Set();
	const plain = (node, path) => {
		if (node === void 0 || node === null || typeof node === "string") return;
		if (typeof node === "boolean") return;
		if (typeof node === "number") {
			if (!Number.isFinite(node)) reject(path, "a non-finite number, which JSON would turn into null");
			return;
		}
		if (typeof node !== "object") reject(path, `a ${typeof node}`);
		if (ancestors.has(node)) reject(path, "a reference back to one of its own containers (a cycle)");
		if (Object.getOwnPropertySymbols(node).length > 0) reject(path, "a symbol-keyed property, which JSON drops");
		ancestors.add(node);
		if (Array.isArray(node)) {
			if (Object.getPrototypeOf(node) !== Array.prototype) reject(path, "a list of a subclass, which JSON serializes as a plain list");
			const indices = new Set(Array.from(node.keys(), String));
			if (Object.getOwnPropertyNames(node).some((n) => n !== "length" && !indices.has(n))) reject(path, "a list carrying named properties, which JSON drops");
			if (Object.keys(node).length !== node.length) reject(path, "a list with a hole or a non-enumerable item, which JSON reads as null");
			for (const [index, item] of node.entries()) {
				if (item === void 0) reject([...path, index], "an undefined list item, which JSON would turn into null");
				plain(item, [...path, index]);
			}
		} else {
			const proto = Object.getPrototypeOf(node);
			if (proto !== Object.prototype && proto !== null) reject(path, "a non-plain object");
			for (const [key, item] of Object.entries(node)) plain(item, [...path, key]);
		}
		ancestors.delete(node);
	};
	if (value === void 0) reject([], "undefined, which has no JSON form");
	plain(value, []);
	return value;
}
/** The runtime shape of Gated; the token is discarded, so the gate is the type alone. */
function gated(bound) {
	return Object.fromEntries(Object.entries(bound).map(([name, helper]) => [name, typeof helper === "function" ? (_exec, ...args) => helper(...args) : helper]));
}
function driftOf(op) {
	return "unverifiable" in op.drift ? op.drift.lines : op.drift;
}
function hasDrift(lines) {
	return lines.length > 0;
}
function planDrift(plan) {
	return [...plan.ops.flatMap(driftOf), ...plan.drift];
}
function planCheckNotes(plan) {
	return [...plan.ops.flatMap((op) => "unverifiable" in op.drift ? [op.drift.unverifiable] : []), ...plan.notes];
}
/**
* The bound helpers close over a frozen copy, so a declaration mutated after binding (its route
* rewritten to a write) cannot change what a read issues.
*/
function snapshot(value) {
	if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
	if (typeof value === "object" && value !== null) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])));
	return value;
}
/**
* Only GETs and GraphQL queries are bound, so the port cannot issue a write however it is called: the
* runtime twin of BoundReads. The cast at the end is the construction boundary.
*/
function boundReads(meta, api, repo) {
	const ctx = {
		api,
		repo,
		check: true
	};
	const port = {};
	for (const [role, declaration] of Object.entries(meta.endpoints)) {
		if (endpointMethod(declaration.route) !== "GET") continue;
		const endpoint = snapshot(declaration);
		const bound = {
			call: (...args) => call(ctx, meta, endpoint, ...args),
			tryCall: (...args) => tryCall(ctx, meta, endpoint, ...args),
			probeAbsent: (...args) => probeAbsent(ctx, meta, endpoint, ...args),
			listAll: (...args) => listAll(ctx, meta, endpoint, ...args),
			listAllEnveloped: (envelopeKey, ...args) => listAllEnveloped(ctx, meta, endpoint, envelopeKey, ...args)
		};
		port[role] = endpoint.phase === "execution" ? gated(bound) : bound;
	}
	for (const [role, declaration] of Object.entries(meta.graphql ?? {})) {
		if (declaration.kind !== "read") continue;
		const op = snapshot(declaration);
		const bound = {
			call: (variables, opts) => callGraphql(ctx, meta, op, variables, opts),
			tryCall: (variables, opts) => tryCallGraphql(ctx, meta, op, variables, opts),
			...op.connection === void 0 ? {} : { listConnection: (variables) => listGraphqlConnection(ctx, meta, op, variables) }
		};
		port[role] = op.phase === "execution" ? gated(bound) : bound;
	}
	return Object.freeze(port);
}
/** `E` and `G` infer from the module, so a caller cannot ask for a port the section never declared. */
function planContext(meta, api, repo) {
	return {
		repo,
		read: boundReads(meta, api, repo)
	};
}
//#endregion
//#region src/sections/actions/index.ts
const permission$14 = { repo: ["administration"] };
const OIDC_TEMPLATE_HINT = "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";
const FORK_PR_PRIVATE_DENIAL = "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";
const ENDPOINTS$17 = {
	getPermissions: {
		route: "GET /repos/{owner}/{repo}/actions/permissions",
		statuses: { 200: "the Actions permissions policy" },
		primaryRead: { notFound: "denied" }
	},
	putPermissions: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions",
		statuses: { 204: "Actions permissions policy applied" }
	},
	getSelected: {
		route: "GET /repos/{owner}/{repo}/actions/permissions/selected-actions",
		statuses: {
			200: "the selected-actions allowlist",
			404: "no allowlist because the policy is not selected",
			409: "the allowed_actions policy is not selected, so the allowlist does not apply"
		}
	},
	putSelected: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions",
		statuses: { 204: "selected-actions allowlist applied" }
	},
	getWorkflow: {
		route: "GET /repos/{owner}/{repo}/actions/permissions/workflow",
		statuses: { 200: "the workflow token permissions" }
	},
	putWorkflow: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
		statuses: { 204: "workflow token permissions applied" }
	},
	getAccess: {
		route: "GET /repos/{owner}/{repo}/actions/permissions/access",
		statuses: { 200: "the workflows access level" }
	},
	putAccess: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions/access",
		statuses: { 204: "workflows access level applied" }
	},
	getRetention: {
		route: "GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention",
		statuses: { 200: "the artifact and log retention window" }
	},
	putRetention: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention",
		statuses: { 204: "artifact and log retention applied" },
		hints: { 422: "the retention window must be a whole number of days within the plan's maximum; see the artifact-and-log-retention endpoint documentation" }
	},
	getCacheRetention: {
		route: "GET /repos/{owner}/{repo}/actions/cache/retention-limit",
		statuses: { 200: "the cache retention limit" }
	},
	putCacheRetention: {
		route: "PUT /repos/{owner}/{repo}/actions/cache/retention-limit",
		statuses: { 204: "cache retention limit applied" },
		hints: { 400: "the retention limit must be a whole number of days within the allowed range; see the cache retention-limit endpoint documentation" }
	},
	getCacheStorage: {
		route: "GET /repos/{owner}/{repo}/actions/cache/storage-limit",
		statuses: { 200: "the cache storage limit" }
	},
	putCacheStorage: {
		route: "PUT /repos/{owner}/{repo}/actions/cache/storage-limit",
		statuses: { 204: "cache storage limit applied" },
		hints: { 400: "the storage limit must be a whole number of gigabytes within the allowed range; see the cache storage-limit endpoint documentation" }
	},
	getOidcSub: {
		route: "GET /repos/{owner}/{repo}/actions/oidc/customization/sub",
		statuses: { 200: "the OIDC subject claim template" },
		permission: { repo: ["actions"] }
	},
	putOidcSub: {
		route: "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub",
		statuses: { 201: "OIDC subject claim template applied" },
		permission: { repo: ["actions"] },
		hints: {
			400: OIDC_TEMPLATE_HINT,
			422: OIDC_TEMPLATE_HINT
		}
	},
	getForkPrApproval: {
		route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval",
		statuses: { 200: "the fork PR contributor approval policy" }
	},
	putForkPrApproval: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval",
		statuses: { 204: "fork PR contributor approval policy applied" },
		hints: { 422: "approval_policy must be one of the contributor approval policies GitHub accepts; see the fork-pr-contributor-approval endpoint documentation" }
	},
	getForkPrPrivate: {
		route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos",
		statuses: { 200: "the private-repo fork PR workflow settings" },
		denialHint: FORK_PR_PRIVATE_DENIAL
	},
	putForkPrPrivate: {
		route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos",
		statuses: { 204: "private-repo fork PR workflow settings applied" },
		denialHint: FORK_PR_PRIVATE_DENIAL,
		hints: { 422: "the settings object must carry run_workflows_from_fork_pull_requests with boolean toggles only; see the fork-pr-workflows-private-repos endpoint documentation" }
	}
};
/**
* Named once so a limit's GET and PUT cannot be paired across limits: both roles derive from N,
* and both must be declared roles.
*/
function cacheLimit(name, label) {
	return {
		get: `getCache${name}`,
		put: `putCache${name}`,
		label
	};
}
/** Each cache key is the whole body of its own single-field PUT. */
const CACHE_ENDPOINT_BY_KEY = {
	max_cache_retention_days: cacheLimit("Retention", "retention"),
	max_cache_size_gb: cacheLimit("Storage", "storage")
};
/**
* Claim-key ORDER defines the OIDC subject format ("repo:...:context:..."), so unlike subsetDiff's
* set comparison of scalar lists this one matches element by element: a reordered live value is drift.
*/
function sameClaimKeyOrder(declared, live) {
	return declared.length === live.length && declared.every((key, index) => live[index] === key);
}
const LiveOidcSub = z.looseObject({ include_claim_keys: z.array(z.string()).nullish() });
/** `N` is inferred from the GET alone, so a PUT of another name does not compile. */
function endpointRouted(wiring) {
	const body = wiring.body ?? ((declared) => declared);
	return { plan: async (ctx, _section, declared, plan) => {
		const live = await ctx.read[wiring.get].call();
		const payload = body(declared);
		const drift = subsetDiff(payload, live, wiring.label);
		if (hasDrift(drift)) plan.ops.push({
			role: wiring.put,
			payload: plainData(payload),
			describe: wiring.describe,
			drift,
			change: wiring.applied
		});
	} };
}
const KEY_DESTINATION = {
	enabled: "base",
	allowed_actions: "base",
	selected_actions: { plan: async (ctx, _section, declared, plan) => {
		const probe = await ctx.read.getSelected.probeAbsent();
		const drift = "missing" in probe ? ["actions.selected: no selected-actions allowlist is readable (the live allowed_actions policy is not \"selected\", or no allowlist has been set); apply will set the declared allowlist"] : subsetDiff(declared, probe.data, "actions.selected");
		if (hasDrift(drift)) plan.ops.push({
			role: "putSelected",
			payload: plainData(declared),
			drift,
			change: "applied selected-actions policy"
		});
	} },
	default_workflow_permissions: "workflow",
	can_approve_pull_request_reviews: "workflow",
	access_level: endpointRouted({
		get: "getAccess",
		put: "putAccess",
		label: "actions.access",
		applied: "applied workflows access level",
		body: (value) => ({ access_level: value })
	}),
	artifact_and_log_retention: endpointRouted({
		get: "getRetention",
		put: "putRetention",
		label: "actions.artifact_and_log_retention",
		applied: "applied artifact and log retention",
		describe: "setting the artifact and log retention window"
	}),
	cache: { plan: async (ctx, _section, declared, plan) => {
		const cache = declared;
		for (const [key, wiring] of Object.entries(CACHE_ENDPOINT_BY_KEY)) {
			if (!(key in cache)) continue;
			const live = await ctx.read[wiring.get].call();
			const body = { [key]: cache[key] };
			const drift = subsetDiff(body, live, "actions.cache");
			if (hasDrift(drift)) plan.ops.push({
				role: wiring.put,
				payload: plainData(body),
				describe: `setting the cache ${wiring.label} limit`,
				drift,
				change: `applied cache ${wiring.label} limit`
			});
		}
	} },
	oidc_customization_sub: { plan: async (ctx, section, declared, plan) => {
		const live = parseLive(section, ENDPOINTS$17.getOidcSub, LiveOidcSub, await ctx.read.getOidcSub.call());
		const { include_claim_keys, ...comparable } = declared;
		const drift = subsetDiff(comparable, live, "actions.oidc_customization_sub");
		if (declared.use_default === false && include_claim_keys !== void 0) {
			const liveKeys = live.include_claim_keys ?? [];
			if (!sameClaimKeyOrder(include_claim_keys, liveKeys)) drift.push(`actions.oidc_customization_sub.include_claim_keys: declared ${JSON.stringify(include_claim_keys)} != live ${JSON.stringify(liveKeys)} (claim-key order defines the subject format, so order counts); apply will set the declared value`);
		}
		if (hasDrift(drift)) plan.ops.push({
			role: "putOidcSub",
			payload: plainData(declared),
			describe: "customizing the OIDC subject claim",
			drift,
			change: "applied the OIDC subject claim template"
		});
	} },
	fork_pr_contributor_approval: endpointRouted({
		get: "getForkPrApproval",
		put: "putForkPrApproval",
		label: "actions.fork_pr_contributor_approval",
		applied: "applied the fork PR contributor approval policy",
		describe: "setting the fork PR contributor approval policy"
	}),
	fork_pr_workflows_private_repos: endpointRouted({
		get: "getForkPrPrivate",
		put: "putForkPrPrivate",
		label: "actions.fork_pr_workflows_private_repos",
		applied: "applied the private-repo fork PR workflow settings",
		describe: "setting the private-repo fork PR workflow settings"
	})
};
const ROUTED_DESTINATIONS = KEY_DESTINATION;
const ROUTED_KEYS = Object.keys(KEY_DESTINATION).filter((key) => typeof KEY_DESTINATION[key] !== "string");
const ROUTED_KEY_SET = new Set(ROUTED_KEYS);
async function planRouted(key, ctx, section, desired, plan) {
	const declared = desired[key];
	if (declared === void 0) return;
	await ROUTED_DESTINATIONS[key].plan(ctx, section, declared, plan);
}
function keysTo(destination) {
	return new Set(Object.entries(KEY_DESTINATION).filter(([, dest]) => dest === destination).map(([key]) => key));
}
const WORKFLOW_KEYS = keysTo("workflow");
const KNOWN_PERMISSION_KEYS = keysTo("base");
const actionsSection = {
	key: "actions",
	undeclaredDefault: "untouched",
	permission: permission$14,
	grantCaveat: "the \"oidc_customization_sub\" key alone instead needs \"Actions\" (read and write)",
	endpoints: ENDPOINTS$17,
	shape: loosen(ActionsConfig),
	async plan(ctx, desired) {
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		const permissions = {};
		const workflow = {};
		for (const [key, value] of Object.entries(desired)) {
			if (ROUTED_KEY_SET.has(key)) continue;
			if (WORKFLOW_KEYS.has(key)) workflow[key] = value;
			else permissions[key] = value;
		}
		if (desired.selected_actions !== void 0 && permissions.allowed_actions === void 0) permissions.allowed_actions = "selected";
		if (Object.keys(permissions).length > 0) permissions.enabled = permissions.enabled ?? true;
		const routed = Object.keys(permissions).filter((k) => !KNOWN_PERMISSION_KEYS.has(k));
		if (routed.length > 0) {
			const enabledValue = JSON.stringify(permissions.enabled);
			plan.notes.push(`key(s) [${routed.join(", ")}] are not recognized by this action; they ride verbatim in PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - a "no such field" drift line for a key means GitHub does not return it, so it can never be proven to have taken and apply would re-send the body on every run; remove it from the actions section of the settings file`);
		}
		if (Object.keys(permissions).length > 0) {
			const drift = subsetDiff(permissions, await ctx.read.getPermissions.call(), "actions.permissions");
			if (hasDrift(drift)) plan.ops.push({
				role: "putPermissions",
				payload: plainData(permissions),
				drift,
				change: "applied actions permissions"
			});
		}
		if (Object.keys(workflow).length > 0) {
			const drift = subsetDiff(workflow, await ctx.read.getWorkflow.call(), "actions.workflow");
			if (hasDrift(drift)) plan.ops.push({
				role: "putWorkflow",
				payload: plainData(workflow),
				drift,
				change: "applied workflow token permissions"
			});
		}
		for (const key of ROUTED_KEYS) await planRouted(key, ctx, this, desired, plan);
		return plan;
	}
};
//#endregion
//#region src/engine/secret-refs.ts
const REFERENCE_RE = /^\$[A-Z_][A-Z0-9_]*$/;
const EMBEDDED_REFERENCE_RE = /\$[A-Z_][A-Z0-9_]*/;
/**
* INPUT_* holds the action's own inputs (INPUT_TOKEN is the admin token); the rest are runner and workflow context.
* Routing any of them into a settings value would make the settings file an exfiltration channel.
*/
const RESERVED_REF_PREFIXES = [
	"INPUT_",
	"GITHUB_",
	"ACTIONS_",
	"RUNNER_",
	"NODE_"
];
/**
* Reads no environment, so check mode and preflight run it without touching secrets; `label` names the owning entry
* (a secret name, a webhook url), never a value. Errors never echo a non-reference value either: a rejected literal,
* or the text around an embedded `$NAME`, may already be a secret.
*/
function validateSecretRef(value, source, label) {
	if (REFERENCE_RE.test(value)) {
		const name = value.slice(1);
		if (source === "target") return {
			ok: false,
			error: `${label} uses the secret reference ${value} in a target-fetched settings file; references are honored only in operator-owned settings sources, so a target repository cannot read the operator's environment`
		};
		const reserved = RESERVED_REF_PREFIXES.find((prefix) => name.startsWith(prefix));
		if (reserved !== void 0) return {
			ok: false,
			error: `${label} references the reserved runner variable ${value} (${reserved}* is refused): workflow inputs and GitHub/runner context cannot be routed into settings values`
		};
		return {
			ok: true,
			ref: { name }
		};
	}
	const embedded = value.match(EMBEDDED_REFERENCE_RE)?.[0];
	if (embedded !== void 0) return {
		ok: false,
		error: `${label} embeds ${embedded} without being a whole-value reference; it would otherwise ship verbatim as the secret. Make the entire value a single $NAME reference`
	};
	return {
		ok: false,
		error: `${label} carries a literal value, but settings files are committed plaintext - exactly what secret references exist to prevent. Set it to a whole-value $NAME reference and define NAME in the step's env block`
	};
}
/**
* Every value re-runs validateSecretRef with ITS OWN source, so a mixed batch cannot launder a target-declared reference
* behind operator-declared ones. All problems are collected: a run with three broken references says so once.
*
* unset variable          -> fails
* set but empty variable  -> fails too: an empty vault lookup must not write an empty secret
*/
function resolveSecretRefs(values, env = process.env) {
	const errors = [];
	const resolved = {};
	const mask = /* @__PURE__ */ new Set();
	for (const { value, source, label } of values) {
		const checked = validateSecretRef(value, source, label);
		if (!checked.ok) {
			errors.push(checked.error);
			continue;
		}
		const { name } = checked.ref;
		const plaintext = env[name];
		if (plaintext === void 0) {
			errors.push(`secret reference $${name} is unset: the step environment does not define ${name}. Add it to the step's env block, e.g. from a repository or organization secret`);
			continue;
		}
		if (plaintext === "") {
			errors.push(`secret reference $${name} is set but empty; an empty value would write an empty secret, so a failed lookup cannot pass silently. Give ${name} a non-empty value`);
			continue;
		}
		resolved[name] = plaintext;
		mask.add(plaintext);
	}
	if (errors.length > 0) return {
		ok: false,
		errors
	};
	return {
		ok: true,
		values: resolved,
		mask: [...mask]
	};
}
//#endregion
//#region src/engine/secrets.ts
function collectSecretValues(settings, sections, source) {
	const out = [];
	for (const section of sections) {
		const declared = settings[section.key];
		if (declared === void 0 || section.secretValues === void 0) continue;
		for (const { label, value } of section.secretValues(declared)) out.push({
			section: section.key,
			label,
			value,
			source
		});
	}
	return out;
}
/**
* The one mint behind every reference a snapshot writes: the variable's `$NAME` form, proved by
* the same grammar and reserved-prefix rule the settings file enforces, so a snapshot can never
* emit a reference an apply would refuse. `label` names the secret for the BUG prose.
*/
function mintSecretReference(variable, label) {
	const reference = `$${variable}`;
	const checked = validateSecretRef(reference, "operator", label);
	if (!checked.ok) throw new Error(`BUG: the snapshot minted a reference the settings file refuses: ${checked.error}`);
	return {
		variable,
		reference
	};
}
/**
* `SECRET_` leads so a store named like a runner namespace (`ACTIONS_*`) still mints a legal
* reference; the store follows so two stores holding one secret name never share a variable.
*/
function snapshotSecretReference$1(store, secretName) {
	return mintSecretReference(`SECRET_${store.toUpperCase()}_${secretName}`, `the ${store} secret ${secretName}`);
}
const EPHEMERAL_KEY_BYTES = 32;
/** XSalsa20's extended nonce, which crypto_box_seal derives instead of transmitting. */
const NONCE_BYTES = 24;
/**
* hsalsa20's "expand 32-byte k" constant as the host-order word view hsalsa reads.
* hsalsa byte-swaps its inputs and its output itself on a big-endian host, so the
* views stay raw here: little-endian words would be swapped twice there.
*/
const HSALSA_SIGMA = new Uint32Array(new TextEncoder().encode("expand 32-byte k").buffer);
/** crypto_box_beforenm runs hsalsa20 with an all-zero 16-byte input. */
const ZERO_INPUT = /* @__PURE__ */ new Uint32Array(4);
/**
* Decode canonical padded base64 (RFC 4648 section 4) or throw, as libsodium's
* from_base64 did. Buffer's decoder skips bad characters and tolerates missing
* padding and nonzero padding bits, so only a re-encode round trip is exact.
*/
function decodeBase64(text) {
	const bytes = new Uint8Array(Buffer.from(text, "base64"));
	if (Buffer.from(bytes).toString("base64") !== text) throw new Error("not canonical base64");
	return bytes;
}
/**
* libsodium's crypto_box_beforenm: the X25519 shared point through hsalsa20.
* getSharedSecret throws on a low-order public key (an all-zero shared point),
* like crypto_scalarmult's -1 that makes libsodium refuse the seal.
* test/sections/sealed-box.test.ts pins the result against crypto_box_beforenm.
*/
function boxSharedKey(secretKey, publicKey) {
	const shared = x25519.getSharedSecret(secretKey, publicKey);
	const key = /* @__PURE__ */ new Uint32Array(8);
	hsalsa(HSALSA_SIGMA, new Uint32Array(shared.slice().buffer), ZERO_INPUT, key);
	return new Uint8Array(key.buffer);
}
/** crypto_box_seal's nonce: blake2b-192 over the ephemeral then the recipient public key. */
function sealNonce(ephemeralPublicKey, recipientPublicKey) {
	return blake2b.create({ dkLen: NONCE_BYTES }).update(ephemeralPublicKey).update(recipientPublicKey).digest();
}
/**
* Seal `message` so only the holder of `recipientPublicKey`'s secret half can
* open it. `ephemeralSecretKey` exists only so the tests can pin fixed vectors;
* production callers must never pass it.
*/
function sealBox(message, recipientPublicKey, ephemeralSecretKey = x25519.utils.randomSecretKey()) {
	const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecretKey);
	const key = boxSharedKey(ephemeralSecretKey, recipientPublicKey);
	const nonce = sealNonce(ephemeralPublicKey, recipientPublicKey);
	const boxed = xsalsa20poly1305(key, nonce).encrypt(message);
	const sealed = new Uint8Array(EPHEMERAL_KEY_BYTES + boxed.length);
	sealed.set(ephemeralPublicKey, 0);
	sealed.set(boxed, EPHEMERAL_KEY_BYTES);
	return sealed;
}
/** Seal a secret's UTF-8 value against the decoded sealing key into the base64 encrypted_value. */
function sealForGithub(recipientPublicKey, value) {
	const sealed = sealBox(new TextEncoder().encode(value), recipientPublicKey);
	return Buffer.from(sealed).toString("base64");
}
//#endregion
//#region src/sections/shared/secrets-engine.ts
/** Existence reconciliation over route-free scopes: values are never read back, and every declared secret is re-sealed on each apply. */
/** The list-body schema every family's list closure parses with. */
const LIVE_SECRET_NAMES = z.array(z.looseObject({ name: z.string() }));
/** The matching key for a secret name: GitHub stores and compares uppercase. */
function secretKey(name) {
	return name.toUpperCase();
}
/**
* Each value is labelled with its entry's secret NAME so a validation error can point at it. DEFENSIVE by
* contract: a malformed container returns [] instead of throwing, so the actionable error always comes
* from shape validation, never a TypeError here.
*/
function listSecretValues(declared) {
	const container = declared;
	const isWrapper = typeof container === "object" && container !== null && !Array.isArray(container) && Array.isArray(container.entries);
	if (!Array.isArray(container) && !isWrapper) return [];
	const { entries } = undeclaredPolicy(container, "keep");
	return entries.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null || typeof entry.value !== "string") return [];
		return [{
			label: typeof entry.name === "string" ? `the secret entry "${entry.name}"` : "an unnamed secret entry",
			value: entry.value
		}];
	});
}
/** GitHub folds two names equal uppercased into one secret, so the last write would silently win on every run. */
function rejectDuplicateSecretNames(section, entries) {
	rejectDuplicates(section, entries, (entry) => secretKey(entry.name), (entry) => entry.name);
}
/** A malformed key fails here with the endpoint and scope named, rather than as a bare primitive error inside a seal. */
function parseSealingKey(section, scope, endpoint, data) {
	const advice = `Check the "api-version" input against the GitHub REST docs for this endpoint`;
	const where = `${section.key}: GET ${endpointPath(endpoint.route)} (the ${scope.label} sealing key)`;
	const body = data ?? {};
	const keyId = body.key_id;
	const publicKey = body.key;
	if (typeof keyId !== "string" || keyId === "" || typeof publicKey !== "string" || publicKey === "") {
		const fieldDefect = (label, value) => value === void 0 ? `${label} is missing` : typeof value !== "string" ? `${label} is not a string` : value === "" ? `${label} is empty` : null;
		const defect = fieldDefect("key_id", keyId) ?? fieldDefect("key", publicKey);
		throw new Error(`${where} returned no usable {key_id, key} pair (${defect}), so no value can be sealed. ${advice}`);
	}
	let keyBytes;
	try {
		keyBytes = decodeBase64(publicKey);
	} catch {
		throw new Error(`${where} returned a key that is not valid base64, so no value can be sealed. ${advice}`);
	}
	if (keyBytes.length !== 32) throw new Error(`${where} returned a key that decodes to ${keyBytes.length} bytes where an X25519 public key has 32, so no value can be sealed. ${advice}`);
	try {
		sealForGithub(keyBytes, "");
	} catch {
		throw new Error(`${where} returned a key that is not a usable X25519 public key, so no value can be sealed. ${advice}`);
	}
	return {
		keyId,
		seal: (plaintext) => ({
			encrypted_value: sealForGithub(keyBytes, plaintext),
			key_id: keyId
		})
	};
}
function missingSecretDrift(scope, name) {
	return `${scope.label}[${name}]: missing - declared in the settings file but not on ${scope.home ?? "the repo"}; apply will create it`;
}
/** ONE note per scope (the LFS precedent): values are unverifiable by design. */
function cannotVerifyNote(scope) {
	return `${scope.noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`;
}
function undeclaredSecretNote(scope, liveName) {
	return undeclaredNote({
		subject: `${scope.noun} "${liveName}"`,
		state: `exists on ${scope.home ?? "the repo"} but is not declared`,
		action: "DELETE it (a deleted secret's value is unrecoverable)"
	});
}
function undeclaredSecretDrift(scope, defaultPolicy, liveName) {
	return undeclaredDrift(defaultPolicy, {
		label: `${scope.label}[${liveName}]`,
		action: "DELETE it (the value is unrecoverable)"
	});
}
/** Uppercase key -> the name as listed (normalizing keeps a differently-cased mock harmless). */
function liveSecretsByKey(live) {
	const liveByKey = /* @__PURE__ */ new Map();
	for (const item of live) liveByKey.set(secretKey(item.name), item.name);
	return liveByKey;
}
async function planSecrets(section, scope, opts) {
	const { entries, policy, defaultPolicy } = opts;
	const suffix = scope.changeSuffix ?? "";
	const plan = {
		ops: [],
		notes: [],
		drift: []
	};
	const liveByKey = liveSecretsByKey(await scope.list());
	const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));
	if (entries.length > 0) {
		const sealingKey = parseSealingKey(section, scope, scope.publicKeyEndpoint, await scope.publicKey(`reading the ${scope.label} sealing key`));
		for (const entry of entries) {
			const name = secretKey(entry.name);
			const exists = liveByKey.has(name);
			plan.ops.push(scope.put({
				name,
				describe: `writing secret "${name}"${suffix}`,
				payload: (exec) => sealingKey.seal(exec.resolveSecret(entry.value)),
				drift: exists ? [] : [missingSecretDrift(scope, name)],
				change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`
			}));
		}
		plan.notes.push(cannotVerifyNote(scope));
	}
	for (const [key, liveName] of liveByKey) {
		if (declaredKeys.has(key)) continue;
		if (policy === "keep") plan.notes.push(undeclaredSecretNote(scope, liveName));
		else plan.ops.push(scope.remove({
			name: liveName,
			describe: `deleting undeclared secret "${liveName}"${suffix}`,
			drift: [undeclaredSecretDrift(scope, defaultPolicy, liveName)],
			change: `DELETED undeclared secret "${liveName}"${suffix}`
		}));
	}
	return plan;
}
//#endregion
//#region src/sections/shared/snapshot-helpers.ts
function defOf(schema) {
	return schema._zod.def;
}
/** The schema types the projection treats as leaves: the live value passes through verbatim. */
const LEAF_TYPES = /* @__PURE__ */ new Set([
	"string",
	"number",
	"int",
	"boolean",
	"enum",
	"literal",
	"unknown",
	"null"
]);
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* A live value projected onto a schema slice, so server-assigned fields fall away without a hand
* list per section. A nested `null` the slice cannot hold is GitHub's "no value" (a not-configured
* setup's runner_type) and its key is omitted; a value the slice rejects at the root stays, so the
* engine's validation names a body outside the shape instead of the section vanishing. A
* passthrough slice (a catchall other than never) keeps every live key by design, so a section on
* one names the keys it reads back itself. The casts are the boundary the engine validates behind.
*/
function projectOntoSchema(schema, live) {
	if (live === null && !schema.safeParse(null).success) return live;
	return project(schema, live);
}
function project(schema, live) {
	if (live === void 0) return;
	if (live === null) return schema.safeParse(null).success ? null : void 0;
	const def = defOf(schema);
	switch (def.type) {
		case "optional":
		case "nullable": return project(def.innerType, live);
		case "object": {
			if (!isPlainObject(live)) return live;
			const shape = def.shape ?? {};
			const out = {};
			for (const [key, child] of Object.entries(shape)) {
				const projected = project(child, live[key]);
				if (projected !== void 0) out[key] = projected;
			}
			if (def.catchall !== void 0 && defOf(def.catchall).type !== "never") {
				for (const [key, value] of Object.entries(live)) if (!(key in shape) && value !== void 0) out[key] = value;
			}
			return out;
		}
		case "array": return Array.isArray(live) ? live.map((item) => project(def.element, item)) : live;
		case "record": return isPlainObject(live) ? Object.fromEntries(Object.entries(live).map(([key, value]) => [key, project(def.valueType, value)])) : live;
		case "union": {
			const option = (def.options ?? []).find((candidate) => candidate.safeParse(live).success);
			return option === void 0 ? live : project(option, live);
		}
		default:
			if (!LEAF_TYPES.has(def.type)) throw new Error(`projectOntoSchema(): unhandled schema type "${def.type}" - teach the projection its walk before authoring it in a section slice`);
			return live;
	}
}
/**
* Refuse a live list holding two resources under one identity (GitHub allows repeated deploy-key
* titles and hook urls): the planner manages one resource per identity and would refuse the
* snapshot's own file, so the snapshot fails here, naming the pairs, instead of emitting it.
*/
function rejectLiveDuplicates(section, noun, items, keyOf, describe) {
	const collisions = collidingPairs(items, keyOf, describe);
	if (collisions.length > 0) throw new Error(`${section.key}: GitHub holds ${noun}s that resolve to one identity: ${collisions.join("; ")}. This section manages one ${noun} per identity, so the snapshot cannot declare them; delete all but one of each on GitHub, then snapshot again`);
}
/** A knobbed section's snapshot value: its entries under the section's own default policy, spelled out. */
function knobbedSnapshot(section, entries) {
	return {
		_undeclared: defaultUndeclaredPolicy(section),
		entries
	};
}
//#endregion
//#region src/sections/shared/repo-secrets.ts
/**
* The factory derives the routes from THIS map, so a key paired with another family's segment (which the
* mock would faithfully serve, hiding the swap) is unrepresentable; the `satisfies` pins each VALUE to the
* segment its own KEY spells, so a fifth family breaking the `<segment>_secrets` naming must say so here.
*/
const SECRETS_SEGMENTS = {
	actions_secrets: "actions",
	dependabot_secrets: "dependabot",
	codespaces_secrets: "codespaces",
	agents_secrets: "agents"
};
/**
* The factory derives the runtime shape from THIS map, so a key paired with another family's config
* (structurally identical, invisible to every gate) is unrepresentable.
*/
const SECRETS_ENTRIES = {
	actions_secrets: ActionsSecretConfig,
	dependabot_secrets: DependabotSecretConfig,
	codespaces_secrets: CodespacesSecretConfig,
	agents_secrets: AgentsSecretConfig
};
/**
* Checked HERE as a fresh object literal, once per family key: the factory hands ../registry.ts a module
* IDENTIFIER, where excess-property checking no longer runs, so a `known` key no entry type carries any
* more would otherwise compile silently. The intersection admits a key present in ANY constituent, but a
* key only one family dropped breaks SecretEntry and the shared plan signature first.
*/
const CLOSED_SURFACE = {
	known: {
		name: true,
		value: true
	},
	describe: (entry) => entry.name,
	consequence: "the API body carries only the sealed value, so the key would silently do nothing"
};
/**
* Keep-by-default on purpose: a deleted secret's value is unrecoverable, so deletion is opt-in via the
* wrapped `_undeclared: delete` form. A family supplies only its key, PAT resource, noun, and (Codespaces) read grade.
*/
function repoSecretsSection(family) {
	const { key, resource, noun, accessGrade } = family;
	const pathSegment = SECRETS_SEGMENTS[key];
	const readGrade = accessGrade === void 0 ? {} : { accessGrade };
	const endpoints = {
		list: {
			route: `GET /repos/{owner}/{repo}/${pathSegment}/secrets`,
			statuses: { 200: "the secrets list (names and timestamps; never values)" },
			...readGrade,
			primaryRead: { notFound: "denied" }
		},
		publicKey: {
			route: `GET /repos/{owner}/{repo}/${pathSegment}/secrets/public-key`,
			statuses: { 200: "the sealing public key" },
			...readGrade
		},
		put: {
			route: `PUT /repos/{owner}/{repo}/${pathSegment}/secrets/{secret_name}`,
			statuses: {
				201: "secret created",
				204: "secret updated"
			},
			alwaysRewrite: true
		},
		remove: {
			route: `DELETE /repos/{owner}/{repo}/${pathSegment}/secrets/{secret_name}`,
			statuses: { 204: "secret deleted" }
		}
	};
	const wide = endpoints;
	const plan = async (ctx, declared) => {
		const defaultPolicy = defaultUndeclaredPolicy(section);
		const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
		rejectDuplicateSecretNames(section, entries);
		const scope = {
			label: key,
			noun,
			list: async () => parseLive(section, wide.list, LIVE_SECRET_NAMES, await ctx.read.list.listAllEnveloped("secrets")),
			publicKey: (describe) => ctx.read.publicKey.call({ describe }),
			publicKeyEndpoint: wide.publicKey,
			put: (write) => ({
				role: "put",
				params: { secret_name: write.name },
				payload: write.payload,
				drift: write.drift,
				change: write.change,
				describe: write.describe
			}),
			remove: (deletion) => ({
				role: "remove",
				params: { secret_name: deletion.name },
				drift: deletion.drift,
				change: deletion.change,
				describe: deletion.describe
			})
		};
		return planSecrets(section, scope, {
			entries,
			policy,
			defaultPolicy
		});
	};
	const snapshot = async (ctx) => {
		const live = parseLive(section, wide.list, LIVE_SECRET_NAMES, await ctx.read.list.listAllEnveloped("secrets"));
		if (live.length === 0) return {
			value: void 0,
			notes: []
		};
		const references = live.map(({ name }) => ({
			name: secretKey(name),
			...snapshotSecretReference$1(pathSegment, secretKey(name))
		}));
		const entries = references.map(({ name, reference }) => ({
			name,
			value: reference
		}));
		const notes = references.map(({ name, variable }) => `${key}[${name}]: value of ${name} is not readable; export it into the environment as ${variable} before apply`);
		return {
			value: knobbedSnapshot(section, entries),
			notes
		};
	};
	const section = {
		key,
		undeclaredDefault: "keep",
		permission: { repo: [resource] },
		endpoints,
		shape: loosen(knobbed(SECRETS_ENTRIES[key])),
		secretValues: listSecretValues,
		closedSurface: CLOSED_SURFACE,
		plan,
		snapshot: (ctx) => snapshot(ctx)
	};
	return section;
}
//#endregion
//#region src/sections/actions_secrets/index.ts
const actionsSecretsSection = repoSecretsSection({
	key: "actions_secrets",
	resource: "secrets",
	noun: "Actions secret"
});
//#endregion
//#region src/sections/shared/variables-engine.ts
/** Value reconciliation over route-free scopes: names match uppercased, and extra declared fields pass through. */
/** Case-insensitive key for variable names (GitHub stores them uppercased). */
function variableKey(name) {
	return name.toUpperCase();
}
const LiveVariable = z.looseObject({
	name: z.string(),
	value: z.string()
});
function missingVariableDrift(scope, label) {
	return `${label}: missing - declared in the settings file but not on ${scope.home ?? "the repo"}; apply will create it`;
}
function valueDriftLine(label, declared, live) {
	return `${label}.value: declared ${JSON.stringify(declared)} != live ${JSON.stringify(live)}; apply will set the declared value`;
}
function undeclaredVariableNote(scope, liveName) {
	return undeclaredNote({
		subject: `${scope.noun} "${liveName}"`,
		state: `exists on ${scope.keepHome ?? "the repo"} but is not declared`,
		action: "DELETE it"
	});
}
function undeclaredVariableDrift(scope, defaultPolicy, liveName) {
	return undeclaredDrift(defaultPolicy, {
		label: `${scope.label}[${liveName}]`,
		action: "DELETE it"
	});
}
function liveVariablesByKey(live) {
	const liveByKey = /* @__PURE__ */ new Map();
	for (const variable of live) liveByKey.set(variableKey(variable.name), variable);
	return liveByKey;
}
async function planVariables$1(scope, opts) {
	const { entries, policy, defaultPolicy } = opts;
	const changeSuffix = scope.changeSuffix ?? "";
	const removeSuffix = scope.removeSuffix ?? "";
	const plan = {
		ops: [],
		notes: [],
		drift: []
	};
	const liveByKey = liveVariablesByKey(await scope.list());
	const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));
	for (const variable of entries) {
		const label = `${scope.label}[${variable.name}]`;
		const existing = liveByKey.get(variableKey(variable.name));
		const { name: _name, value: _value, ...extraKeys } = variable;
		if (!existing) {
			plan.ops.push(scope.create({
				name: variable.name,
				payload: {
					name: variable.name,
					value: variable.value,
					...extraKeys
				},
				drift: [missingVariableDrift(scope, label)],
				change: `created ${scope.noun} "${variable.name}"${changeSuffix}`
			}));
			continue;
		}
		const [first, ...rest] = [...existing.value !== variable.value ? [valueDriftLine(label, variable.value, existing.value)] : [], ...subsetDiff(extraKeys, existing, label)];
		if (first === void 0) continue;
		const phantom = phantomKeys(extraKeys, existing);
		if (phantom.length > 0) plan.notes.push(phantomNote(label, phantom, "variable", "this update will re-run"));
		plan.ops.push(scope.update({
			names: {
				declared: variable.name,
				live: existing.name
			},
			payload: {
				value: variable.value,
				...extraKeys
			},
			drift: [first, ...rest],
			change: `updated ${scope.noun} "${variable.name}"${changeSuffix}`
		}));
	}
	for (const variable of liveByKey.values()) {
		if (declaredKeys.has(variableKey(variable.name))) continue;
		if (policy === "keep") plan.notes.push(undeclaredVariableNote(scope, variable.name));
		else plan.ops.push(scope.remove({
			name: variable.name,
			drift: [undeclaredVariableDrift(scope, defaultPolicy, variable.name)],
			change: `DELETED undeclared ${scope.noun} "${variable.name}"${removeSuffix}`
		}));
	}
	return plan;
}
//#endregion
//#region src/sections/shared/repo-variables.ts
/**
* GitHub's two repo-scoped variable families (Actions, Copilot agents) expose the same four endpoints under
* a different path segment and differ only in PAT resource and noun, so each section module is ONE
* repoVariablesSection() call.
*
*   environments section                    -> consumes ./variables-engine.ts directly, with nested scopes
*   .github/scripts/changed-sections.ts     -> derives this file's smoke fan-out from the import graph
*/
/**
* The factory derives the routes from THIS map, so a key paired with the other family's segment (which
* the mock would faithfully serve, hiding the swap) is unrepresentable; the `satisfies` pins each VALUE
* to the segment its own KEY spells.
*/
const VARIABLES_SEGMENTS = {
	actions_variables: "actions",
	agents_variables: "agents"
};
/**
* The factory derives the runtime shape from THIS map, so a key paired with the other family's config
* (structurally identical, invisible to every gate) is unrepresentable.
*/
const VARIABLES_ENTRIES = {
	actions_variables: ActionsVariableConfig,
	agents_variables: AgentsVariableConfig
};
/**
* Delete-undeclared-by-default: variables are readable, recreatable configuration; the wrapped
* `_undeclared: keep` form softens deletion to notes. A family supplies only its key, PAT resource, and noun.
*/
function repoVariablesSection(family) {
	const { key, resource, noun } = family;
	const pathSegment = VARIABLES_SEGMENTS[key];
	const endpoints = {
		list: {
			route: `GET /repos/{owner}/{repo}/${pathSegment}/variables`,
			statuses: { 200: `the ${noun}s list` },
			pageSize: 30,
			primaryRead: { notFound: "denied" }
		},
		create: {
			route: `POST /repos/{owner}/{repo}/${pathSegment}/variables`,
			statuses: { 201: "variable created" }
		},
		update: {
			route: `PATCH /repos/{owner}/{repo}/${pathSegment}/variables/{name}`,
			statuses: { 204: "variable updated" }
		},
		remove: {
			route: `DELETE /repos/{owner}/{repo}/${pathSegment}/variables/{name}`,
			statuses: { 204: "variable deleted" }
		}
	};
	const wide = endpoints;
	const plan = async (ctx, declared) => {
		const defaultPolicy = defaultUndeclaredPolicy(section);
		const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
		rejectDuplicates(section, entries, (variable) => variableKey(variable.name), (variable) => variable.name);
		return planVariables$1({
			label: key,
			noun,
			list: async () => parseLive(section, wide.list, z.array(LiveVariable), await ctx.read.list.listAllEnveloped("variables")),
			create: (write) => ({
				role: "create",
				payload: write.payload,
				drift: write.drift,
				change: write.change
			}),
			update: (write) => ({
				role: "update",
				params: { name: write.names.live },
				payload: write.payload,
				drift: write.drift,
				change: write.change
			}),
			remove: (deletion) => ({
				role: "remove",
				params: { name: deletion.name },
				drift: deletion.drift,
				change: deletion.change
			})
		}, {
			entries,
			policy,
			defaultPolicy
		});
	};
	const snapshot = async (ctx) => {
		const live = parseLive(section, wide.list, z.array(LiveVariable), await ctx.read.list.listAllEnveloped("variables"));
		if (live.length === 0) return {
			value: void 0,
			notes: []
		};
		const entries = live.map((variable) => projectOntoSchema(VARIABLES_ENTRIES[key], variable));
		return {
			value: knobbedSnapshot(section, entries),
			notes: []
		};
	};
	const section = {
		key,
		undeclaredDefault: "delete",
		permission: { repo: [resource] },
		endpoints,
		shape: loosen(knobbed(VARIABLES_ENTRIES[key])),
		plan,
		snapshot: (ctx) => snapshot(ctx)
	};
	return section;
}
//#endregion
//#region src/sections/actions_variables/index.ts
/**
* `actions_variables:` section: Actions repository variables through the shared variables engine
* (shared/repo-variables.ts). Values are plain text by design: variables are readable
* configuration, which is what makes check-mode diffing possible; secrets are a different section.
*/
const actionsVariablesSection = repoVariablesSection({
	key: "actions_variables",
	resource: "variables",
	noun: "Actions variable"
});
//#endregion
//#region src/sections/agents_secrets/index.ts
const agentsSecretsSection = repoSecretsSection({
	key: "agents_secrets",
	resource: "agent_secrets",
	noun: "Copilot agents secret"
});
//#endregion
//#region src/sections/agents_variables/index.ts
/**
* `agents_variables:` section: Copilot agents repository variables through the shared variables
* engine (shared/repo-variables.ts). Values are plain text by design: variables are readable
* configuration, which is what makes check-mode diffing possible; secrets are a different section.
*/
const agentsVariablesSection = repoVariablesSection({
	key: "agents_variables",
	resource: "agent_variables",
	noun: "Copilot agents variable"
});
//#endregion
//#region src/sections/shared/list-section.ts
/**
* The list-section factory: upsert-by-natural-key plus keep-or-delete-undeclared as ONE declaration
* (slice, roles, identity, address, lens, prose) from which plan(), the loose shape, the mock's
* transformers, and the fuzz witness derive. Two prose hooks only: a section needing more stays bespoke.
*/
function updateRole(endpoints) {
	return "update" in endpoints ? endpoints.update : void 0;
}
const UPDATE_REMEDIES = {
	value: "; apply will set the declared value",
	rename: "apply will rename it",
	phantom: "this update will re-run"
};
const RECREATE_REMEDIES = {
	value: "",
	rename: "apply will delete and recreate it",
	phantom: "this delete-and-recreate will repeat"
};
/**
* The ONE derivation behind the planner's duplicate check and the layered merge's pairing. Total over raw
* records because the merge reads layers before validation: null when a claimed name is not a string,
* which the merge refuses and a validated entry never is.
*/
function identityClaims(identity, entry) {
	const { field, renameKey, fold = (name) => name } = identity;
	const names = [(renameKey === void 0 ? void 0 : entry[renameKey]) ?? entry[field], ...identity.aliases?.(entry) ?? []];
	if (!names.every((name) => typeof name === "string")) return null;
	return [...new Set(names.map(fold))];
}
/** The erased view lost the declaration's string typing, so the check happens once here. */
function nameOf(record, field) {
	const value = record[field];
	if (typeof value !== "string") throw new Error(`BUG: the identity field "${field}" is not a string in ${JSON.stringify(record)}; the lens must carry it verbatim`);
	return value;
}
function missingLine(label) {
	return `${label}: missing - declared in the settings file but not on the repo; apply will create it`;
}
function renderEntryDelta(sectionKey, field, names, delta, remedies) {
	const label = `${sectionKey}[${names.want}]`;
	const [step, ...rest] = delta.path;
	if (delta.kind === "mismatch" && rest.length === 0 && typeof step === "string") {
		if (step === field) return `${sectionKey}[${names.live}]: should be named "${names.want}" per the settings file; ${remedies.rename}`;
		if (typeof delta.desired !== "object" || delta.desired === null) return `${label}.${step}: declared ${JSON.stringify(delta.desired)} != live ${JSON.stringify(delta.live)}${remedies.value}`;
	}
	return renderDelta(label, delta);
}
function updateBody(decl, write) {
	const { renameKey, field } = decl.identity;
	if (renameKey === void 0) return plainData(write);
	const { [field]: _name, ...rest } = write;
	return plainData({
		[renameKey]: nameOf(write, field),
		...rest
	});
}
async function readList(decl, ctx) {
	const query = decl.listing?.query;
	return decl.listing?.unpaginated === true ? ctx.read.list.call({ query }) : ctx.read.list.listAll({ query });
}
async function planList(decl, section, ctx, declared) {
	const { key, noun, identity, lens, prose, endpoints } = decl;
	const fold = identity.fold ?? ((name) => name);
	const update = updateRole(endpoints);
	const remedies = update === void 0 ? RECREATE_REMEDIES : UPDATE_REMEDIES;
	const defaultPolicy = defaultUndeclaredPolicy(section);
	const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
	const writes = entries.map((entry) => {
		const write = lens.toWrite(entry);
		const name = nameOf(write, identity.field);
		const claims = identityClaims(identity, entry);
		if (claims === null) throw new Error(`BUG: the validated ${noun} entry ${JSON.stringify(entry)} claims a non-string name; the slice must type the identity fields as strings`);
		return {
			write,
			name,
			claims
		};
	});
	rejectDuplicates(section, writes.flatMap((w) => w.claims.map((claim) => ({
		claim,
		name: w.name
	}))), (c) => c.claim, (c) => c.name);
	const declaredConflicts = decl.conflicts?.declared?.(writes.map((w) => w.write)) ?? [];
	if (declaredConflicts.length > 0) throw new Error(`${key}: the settings file declares conflicting ${noun}s: ${declaredConflicts.join("; ")}. Fix the settings file, then re-run`);
	const liveItems = parseLive(section, endpoints.list, z.array(decl.live), await readList(decl, ctx)).map((item) => {
		const comparable = lens.fromLive(item);
		const name = nameOf(comparable, identity.field);
		return {
			item,
			comparable,
			name,
			key: fold(name)
		};
	});
	const liveConflicts = decl.conflicts?.live?.(writes.map((w) => w.write), liveItems.map((l) => l.comparable)) ?? [];
	if (liveConflicts.length > 0) throw new Error(`${key}: the settings file conflicts with the live ${noun}s: ${liveConflicts.join("; ")}. Resolve each conflict on GitHub, then re-run`);
	const liveByKey = /* @__PURE__ */ new Map();
	for (const item of liveItems) liveByKey.set(item.key, [...liveByKey.get(item.key) ?? [], item]);
	const claimed = new Set(writes.flatMap((w) => w.claims));
	const plan = {
		ops: [],
		notes: [],
		drift: []
	};
	for (const { write, name, claims } of writes) {
		const matches = [...new Set(claims.flatMap((claim) => liveByKey.get(claim) ?? []))];
		if (matches.length > 1) throw new Error(`${key}: the entry "${name}" matches ${matches.length} separate live ${noun}s (${matches.map((m) => `"${m.name}"`).join(", ")}), so it cannot converge; delete all but one of them on GitHub, or declare each as its own entry`);
		const existing = matches[0];
		const label = `${key}[${name}]`;
		if (existing === void 0) {
			plan.ops.push({
				role: "create",
				payload: plainData(write),
				describe: `creating ${noun} "${name}"`,
				drift: [missingLine(label)],
				change: `created ${noun} "${name}"`
			});
			continue;
		}
		const found = deltas(write, existing.comparable, { matchBy: lens.matchBy });
		const drift = found.map((delta) => renderEntryDelta(key, identity.field, {
			want: name,
			live: existing.name
		}, delta, remedies));
		if (!hasDrift(drift)) continue;
		const phantom = found.flatMap((delta) => delta.kind === "phantom" && delta.path.length === 1 && typeof delta.path[0] === "string" ? [delta.path[0]] : []);
		if (phantom.length > 0) plan.notes.push(phantomNote(label, phantom, noun, remedies.phantom));
		if (update === void 0) {
			plan.ops.push({
				role: "remove",
				params: decl.address(existing.item),
				describe: `deleting ${noun} "${name}" before recreating it`,
				drift: [`${label}: live settings differ from the settings file, and ${noun}s cannot be edited; apply will delete and recreate it`],
				change: `deleted ${noun} "${name}" to recreate it with the declared settings`
			}, {
				role: "create",
				payload: plainData(decl.recreate?.(existing.item, write) ?? write),
				describe: `recreating ${noun} "${name}"`,
				drift,
				change: `recreated ${noun} "${name}"`
			});
			continue;
		}
		plan.ops.push({
			role: "update",
			params: decl.address(existing.item),
			payload: updateBody(decl, write),
			describe: `updating ${noun} "${name}"`,
			drift,
			change: `updated ${noun} "${name}"`
		});
	}
	for (const { item, name, key: liveKey } of liveItems) {
		if (claimed.has(liveKey)) continue;
		if (policy === "keep") {
			plan.notes.push(undeclaredNote({
				subject: `${noun} "${name}"`,
				action: prose.undeclaredAction,
				...prose.undeclaredNote
			}));
			continue;
		}
		plan.ops.push({
			role: "remove",
			params: decl.address(item),
			describe: `deleting undeclared ${noun} "${name}"`,
			drift: [undeclaredDrift(defaultPolicy, {
				label: `${key}[${name}]`,
				action: prose.undeclaredAction,
				...prose.undeclaredDrift
			})],
			change: `DELETED undeclared ${noun} "${name}"`
		});
	}
	return plan;
}
/**
* Items are normalized as GitHub stores them before the projection onto the entry slice, so the
* read-back compares equal to the declaration that produced it.
*/
async function snapshotList(decl, section, ctx) {
	const live = parseLive(section, decl.endpoints.list, z.array(decl.live), await readList(decl, ctx));
	if (live.length === 0) return {
		value: void 0,
		notes: []
	};
	const fold = decl.identity.fold ?? ((name) => name);
	const comparable = live.map((item) => decl.lens.fromLive(item));
	const nameOfItem = (item) => nameOf(item, decl.identity.field);
	rejectLiveDuplicates(section, decl.noun, comparable, (item) => fold(nameOfItem(item)), nameOfItem);
	return {
		value: knobbedSnapshot(section, comparable.map((item) => projectOntoSchema(decl.entry, item))),
		notes: []
	};
}
function secretValuesOf(decl, declared) {
	const extract = decl.secretValues;
	if (extract === void 0) return [];
	return undeclaredPolicy(declared, "keep").entries.flatMap((entry) => [...extract(entry)]);
}
/**
* The planner runs over the erased view while the module surface stays typed over the literal dictionary
* and declared value the registry pins; the casts are that one boundary.
*/
function listSection(decl) {
	const erased = decl;
	const section = {
		key: decl.key,
		permission: decl.permission,
		undeclaredDefault: decl.undeclaredDefault,
		endpoints: decl.endpoints,
		shape: loosen(knobbed(decl.entry)),
		...decl.secretValues === void 0 ? {} : { secretValues: (declared) => secretValuesOf(erased, declared) },
		...decl.layering === void 0 ? {} : { layering: {
			keys: (entry) => identityClaims(erased.identity, entry),
			keyField: decl.identity.field,
			combine: decl.layering.combine
		} },
		plan: (ctx, desired) => planList(erased, section, ctx, desired),
		snapshot: (ctx) => snapshotList(erased, section, ctx),
		decl
	};
	return section;
}
const autolinksSection = listSection({
	key: "autolinks",
	permission: { repo: ["administration"] },
	undeclaredDefault: "delete",
	noun: "autolink",
	entry: AutolinkConfig,
	live: z.looseObject({
		id: z.number(),
		key_prefix: z.string()
	}),
	endpoints: {
		list: {
			route: "GET /repos/{owner}/{repo}/autolinks",
			statuses: { 200: "the autolink list" },
			primaryRead: { notFound: "denied" }
		},
		create: {
			route: "POST /repos/{owner}/{repo}/autolinks",
			statuses: { 201: "autolink created" }
		},
		remove: {
			route: "DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}",
			statuses: { 204: "autolink deleted" }
		}
	},
	listing: { unpaginated: true },
	identity: { field: "key_prefix" },
	address: (live) => ({ autolink_id: String(live.id) }),
	lens: {
		toWrite: ({ key_prefix, url_template, is_alphanumeric, ...passthrough }) => ({
			key_prefix,
			url_template,
			...is_alphanumeric === void 0 ? {} : { is_alphanumeric },
			...passthrough
		}),
		fromLive: (live) => live,
		matchBy: {}
	},
	prose: { undeclaredAction: "DELETE it" }
});
//#endregion
//#region src/sections/branches/endpoints.ts
/**
* GitHub's one body for a protection endpoint on a branch that does not exist. A denied request never
* spells it (a fine-grained read is "Not Found", a write "Resource not accessible ..."), so the match is
* definitive wherever it lands: the PUT (this declaration) and the advisory probe (index.ts).
*/
const MISSING_BRANCH = {
	status: 404,
	message: "Branch not found",
	advice: "the declared branch does not exist on the repo, so its protection cannot be applied; create the branch, or remove it from the settings file"
};
const ENDPOINTS$15 = {
	getProtection: {
		route: "GET /repos/{owner}/{repo}/branches/{branch}/protection",
		statuses: {
			200: "the branch protection",
			404: "the branch is unprotected or does not exist"
		},
		primaryRead: { notFound: "absent" }
	},
	putProtection: {
		route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
		statuses: { 200: "protection replaced" },
		rejections: [MISSING_BRANCH],
		hints: { 422: "Usually a sub-object is missing a required half: \"required_status_checks\" needs both \"strict\" and \"contexts\", \"required_pull_request_reviews\" values must fit their documented shapes, and \"restrictions\" needs \"users\" and \"teams\" lists (or declare the whole key as null)" }
	},
	removeProtection: {
		route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
		statuses: { 204: "protection removed" }
	},
	sigPost: {
		route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
		statuses: { 200: "signed commits now required" }
	},
	sigDelete: {
		route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
		statuses: { 204: "signed-commit requirement removed" }
	},
	branchProbe: {
		route: "GET /repos/{owner}/{repo}/branches/{branch}",
		statuses: {
			200: "the branch exists",
			404: "no such branch"
		},
		permission: { repo: ["contents"] },
		advisory: true
	},
	appLookup: {
		route: "GET /apps/{app_slug}",
		statuses: {
			200: "the GitHub App",
			404: "no App with this slug"
		},
		permission: "none",
		phase: "execution"
	}
};
//#endregion
//#region src/sections/branches/graphql-rules.ts
/** index.ts decides which entries reach this module; nothing here classifies entries. */
const GRAPHQL_BOOLEAN_TWINS = {
	enforce_admins: "isAdminEnforced",
	required_linear_history: "requiresLinearHistory",
	allow_force_pushes: "allowsForcePushes",
	allow_deletions: "allowsDeletions",
	block_creations: "blocksCreations",
	required_conversation_resolution: "requiresConversationResolution",
	lock_branch: "lockBranch",
	allow_fork_syncing: "lockAllowsFetchAndMerge",
	required_signatures: "requiresCommitSignatures"
};
const GRAPHQL_REVIEW_TWINS = {
	required_approving_review_count: "requiredApprovingReviewCount",
	require_code_owner_reviews: "requiresCodeOwnerReviews",
	dismiss_stale_reviews: "dismissesStaleReviews",
	require_last_push_approval: "requireLastPushApproval"
};
const GRAPHQL_STATUS_CHECK_TWINS = {
	strict: "requiresStrictStatusChecks",
	contexts: "requiredStatusCheckContexts"
};
const WILDCARD_KEYS = [
	...Object.keys(GRAPHQL_BOOLEAN_TWINS),
	"required_status_checks",
	"required_pull_request_reviews",
	"force_push_bypassers",
	"required_deployments"
];
const WILDCARD_KEY_SET = new Set(WILDCARD_KEYS);
const GRAPHQL = {
	rulesQuery: graphqlOp()({
		name: "BranchProtectionRules",
		kind: "read",
		connection: { path: ["repository", "branchProtectionRules"] },
		outcomes: {
			ok: "the repository's classic branch protection rules",
			NOT_FOUND: "the repository is not visible to the token; read as no rules"
		},
		query: `query BranchProtectionRules($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    branchProtectionRules(first: 100, after: $cursor) {
      nodes {
        id
        pattern
        isAdminEnforced
        requiresLinearHistory
        allowsForcePushes
        allowsDeletions
        blocksCreations
        requiresConversationResolution
        lockBranch
        lockAllowsFetchAndMerge
        requiresCommitSignatures
        requiresStatusChecks
        requiresStrictStatusChecks
        requiredStatusCheckContexts
        requiresApprovingReviews
        requiredApprovingReviewCount
        requiresCodeOwnerReviews
        dismissesStaleReviews
        requireLastPushApproval
        requiresDeployments
        requiredDeploymentEnvironments
        bypassForcePushAllowances(first: 100) {
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { combinedSlug }
              ... on App { slug }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
	}),
	repoLookup: graphqlOp()({
		name: "BranchProtectionRepository",
		kind: "read",
		phase: "execution",
		outcomes: { ok: "the repository's GraphQL node id" },
		query: `query BranchProtectionRepository($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}`
	}),
	actorUser: graphqlOp()({
		name: "BranchProtectionActorUser",
		kind: "read",
		phase: "execution",
		outcomes: {
			ok: "the user's node id",
			NOT_FOUND: "no user with this login, or the token cannot see it"
		},
		denialHint: "a denial here can also mean the declared force_push_bypassers actor does not exist; check the actor spelling in the settings file",
		query: `query BranchProtectionActorUser($owner: String!, $repo: String!, $login: String!) {
  repository(owner: $owner, name: $repo) { id }
  user(login: $login) { id }
}`
	}),
	actorTeam: graphqlOp()({
		name: "BranchProtectionActorTeam",
		kind: "read",
		phase: "execution",
		outcomes: {
			ok: "the team's node id",
			NOT_FOUND: "no organization with this login, or the token cannot see it"
		},
		denialHint: "a denial here can also mean the declared force_push_bypassers actor's organization does not exist; check the actor spelling in the settings file",
		query: `query BranchProtectionActorTeam($owner: String!, $repo: String!, $org: String!, $team: String!) {
  repository(owner: $owner, name: $repo) { id }
  organization(login: $org) { team(slug: $team) { id } }
}`
	}),
	createRule: graphqlOp()({
		name: "CreateBranchProtectionRule",
		kind: "write",
		outcomes: {
			ok: "rule created",
			UNPROCESSABLE: "GitHub rejected the rule (e.g. a duplicate pattern)"
		},
		query: `mutation CreateBranchProtectionRule($input: CreateBranchProtectionRuleInput!) {
  createBranchProtectionRule(input: $input) {
    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }
  }
}`
	}),
	updateRule: graphqlOp()({
		name: "UpdateBranchProtectionRule",
		kind: "write",
		outcomes: {
			ok: "rule updated",
			NOT_FOUND: "no rule with this node id",
			UNPROCESSABLE: "GitHub rejected the update"
		},
		query: `mutation UpdateBranchProtectionRule($input: UpdateBranchProtectionRuleInput!) {
  updateBranchProtectionRule(input: $input) {
    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }
  }
}`
	}),
	deleteRule: graphqlOp()({
		name: "DeleteBranchProtectionRule",
		kind: "write",
		outcomes: {
			ok: "rule deleted",
			NOT_FOUND: "no rule with this node id"
		},
		query: `mutation DeleteBranchProtectionRule($input: DeleteBranchProtectionRuleInput!) {
  deleteBranchProtectionRule(input: $input) { clientMutationId }
}`
	})
};
function hasRoutedGraphqlKeys(protection) {
	return protection !== null && (protection.force_push_bypassers !== void 0 || protection.required_deployments !== void 0);
}
async function fetchRules(ctx) {
	const read = await ctx.read.rulesQuery.listConnection(repoVariables(ctx));
	if ("error" in read) return null;
	const byPattern = /* @__PURE__ */ new Map();
	for (const node of read.items) if (typeof node === "object" && node !== null) {
		const rule = node;
		if (rule.bypassForcePushAllowances?.pageInfo?.hasNextPage === true) throw new Error(`branches: the live protection rule "${String(rule.pattern)}" allows more than 100 force-push bypass actors, which this section cannot read back completely; trim the live allowance list below 100 to manage it here`);
		byPattern.set(String(rule.pattern), rule);
	}
	return byPattern;
}
function bypassActorStrings(node) {
	const allowances = node.bypassForcePushAllowances?.nodes;
	if (!Array.isArray(allowances)) return [];
	const out = [];
	for (const allowance of allowances) {
		const actor = allowance?.actor;
		if (!actor) continue;
		if (typeof actor.login === "string") out.push(actor.login);
		else if (typeof actor.combinedSlug === "string") out.push(actor.combinedSlug);
		else if (typeof actor.slug === "string") out.push(`app/${actor.slug}`);
	}
	return out;
}
/**
* The real REST GET omits an off control where this view spells null; subsetDiff reads null, absent,
* and "" as one empty value, so null stays for the clearer drift message. The e2e state test proves
* the mock's REST-state projection round-trips through it.
*/
function classicViewOfRule(node) {
	const out = {};
	for (const [classic, twin] of Object.entries(GRAPHQL_BOOLEAN_TWINS)) out[classic] = node[twin];
	out.required_status_checks = node.requiresStatusChecks === true ? {
		strict: node.requiresStrictStatusChecks,
		contexts: Array.isArray(node.requiredStatusCheckContexts) ? node.requiredStatusCheckContexts : []
	} : null;
	if (node.requiresApprovingReviews === true) {
		const reviews = {};
		for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) reviews[classic] = node[twin];
		out.required_pull_request_reviews = reviews;
	} else out.required_pull_request_reviews = null;
	out.force_push_bypassers = [...bypassActorStrings(node)].sort();
	out.required_deployments = node.requiresDeployments === true ? { environments: Array.isArray(node.requiredDeploymentEnvironments) ? node.requiredDeploymentEnvironments : [] } : null;
	return out;
}
/** Shape validation already restricted a wildcard entry's keys, so an unknown key here is a bug. */
function translateWildcardProtection(protection) {
	const input = {};
	for (const [key, value] of Object.entries(protection)) {
		if (key === "force_push_bypassers" || key === "required_deployments") continue;
		const booleanTwin = GRAPHQL_BOOLEAN_TWINS[key];
		if (booleanTwin !== void 0) {
			input[booleanTwin] = value;
			continue;
		}
		if (key === "required_status_checks") {
			if (value === null) input.requiresStatusChecks = false;
			else {
				input.requiresStatusChecks = true;
				const checks = value;
				for (const [classic, twin] of Object.entries(GRAPHQL_STATUS_CHECK_TWINS)) if (classic in checks) input[twin] = checks[classic];
			}
			continue;
		}
		if (key === "required_pull_request_reviews") {
			if (value === null) input.requiresApprovingReviews = false;
			else {
				input.requiresApprovingReviews = true;
				const reviews = value;
				for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) if (classic in reviews) input[twin] = reviews[classic];
			}
			continue;
		}
		throw new Error(`BUG: wildcard protection key "${key}" escaped shape validation`);
	}
	return input;
}
function deploymentInputFields(declared) {
	if (declared === null) return {
		requiresDeployments: false,
		requiredDeploymentEnvironments: []
	};
	return {
		requiresDeployments: true,
		requiredDeploymentEnvironments: [...declared.environments]
	};
}
/**
* GitHub canonicalizes actor and environment names, so a declared "Octocat" reads back as "octocat"
* and must not drift. Duplicates are rejected upfront by the shape, so sorted-lowercase comparison is exact.
*/
function sameNamesFold(declared, live) {
	if (declared.length !== live.length) return false;
	const a = declared.map((name) => name.toLowerCase()).sort();
	const b = live.map((name) => name.toLowerCase()).sort();
	return a.every((name, i) => name === b[i]);
}
/**
* GitHub accepts requiredDeploymentEnvironments names of environments that do not exist and DROPS
* them without failing the mutation (verified live), so the payload's re-read is compared against
* the declaration. The environments section runs first, so same-file environments exist here.
*/
function verifyDeploymentReadback(entryName, declared, response, payloadKey) {
	const rule = (response?.[payloadKey])?.branchProtectionRule;
	if (typeof rule !== "object" || rule === null) throw new Error(`branches[${entryName}].protection.required_deployments: the mutation returned no rule to read back, so the applied deployment requirement cannot be verified; re-run the workflow, and retry later if it persists`);
	const echoed = Array.isArray(rule.requiredDeploymentEnvironments) ? rule.requiredDeploymentEnvironments.map(String) : [];
	if (declared === null) {
		if (rule.requiresDeployments === true) throw new Error(`branches[${entryName}].protection.required_deployments: declared null (not required) but the rule still requires deployments to [${echoed.join(", ")}] after the mutation; re-run the workflow, and report this if it persists`);
		return;
	}
	const echoedFold = new Set(echoed.map((name) => name.toLowerCase()));
	const dropped = declared.environments.filter((name) => !echoedFold.has(name.toLowerCase()));
	if (dropped.length > 0) throw new Error(`branches[${entryName}].protection.required_deployments: GitHub silently dropped [${dropped.join(", ")}] from the required deployment environments because no environment with that name exists on the repository. Declare the environment in this settings file's environments: section (it applies before branches), or create it on the repository first`);
	if (rule.requiresDeployments !== true || !sameNamesFold(declared.environments, echoed)) throw new Error(`branches[${entryName}].protection.required_deployments: the settings file requires deployments to [${declared.environments.join(", ")}] but after the mutation the rule ${rule.requiresDeployments === true ? `requires [${echoed.join(", ")}]` : "does not require deployments"}; re-run the workflow, and report this if it persists`);
}
function routedKeyDrift(prefix, protection, rules, pattern) {
	const drift = [];
	if (rules === null) {
		for (const key of ["force_push_bypassers", "required_deployments"]) if (protection[key] !== void 0) drift.push(`${prefix}.${key}: the live rule cannot be read (the rules query answered not found); apply will set the declared value`);
		return drift;
	}
	const node = rules.get(pattern);
	const declaredActors = protection.force_push_bypassers;
	if (declaredActors !== void 0) {
		const live = node ? [...bypassActorStrings(node)].sort() : [];
		if (!sameNamesFold(declaredActors, live)) drift.push(`${prefix}.force_push_bypassers: the settings file declares [${[...declaredActors].sort().join(", ")}] but the live rule allows [${live.join(", ")}]; apply will replace the allowance list`);
	}
	const declaredDeployments = protection.required_deployments;
	if (declaredDeployments !== void 0) {
		const liveOn = node?.requiresDeployments === true;
		const liveEnvs = (Array.isArray(node?.requiredDeploymentEnvironments) ? node.requiredDeploymentEnvironments.map(String) : []).sort();
		if (declaredDeployments === null) {
			if (liveOn) drift.push(`${prefix}.required_deployments: declared null (not required) but the live rule requires deployments to [${liveEnvs.join(", ")}]; apply will turn the requirement off`);
		} else if (!liveOn || !sameNamesFold(declaredDeployments.environments, liveEnvs)) drift.push(`${prefix}.required_deployments: the settings file requires deployments to [${[...declaredDeployments.environments].sort().join(", ")}] but the live rule ${liveOn ? `requires [${liveEnvs.join(", ")}]` : "does not require deployments"}; apply will set the declared list`);
	}
	return drift;
}
/**
* Cached per run under the case-folded string: GitHub canonicalizes actor names. A user or team read
* also selects the repository's node id, which a later rule CREATE reuses instead of a dedicated lookup.
*
* user  -> GraphQL (REST /users can still carry a legacy node_id; see ACTOR_USER)
* team  -> GraphQL
* app   -> the public REST lookup (legacy-id caveat on appLookup in endpoints.ts); no repository id
*/
async function resolveActorId(ctx, exec, graphqlRun, raw) {
	const cacheKey = raw.toLowerCase();
	const cached = graphqlRun.actorIds.get(cacheKey);
	if (cached !== void 0) return cached;
	const actor = parseBypassActor(raw);
	if (actor === null) throw new Error(`BUG: force_push_bypassers actor "${raw}" escaped shape validation`);
	let id;
	if (actor.kind === "user") {
		const data = await ctx.read.actorUser.call(exec, {
			...repoVariables(ctx),
			login: actor.login
		}, { describe: `resolving force-push bypass user "${raw}"` });
		adoptRepoId(graphqlRun, data);
		id = data.user?.id;
	} else if (actor.kind === "team") {
		const data = await ctx.read.actorTeam.call(exec, {
			...repoVariables(ctx),
			org: actor.org,
			team: actor.team
		}, { describe: `resolving force-push bypass team "${raw}"` });
		adoptRepoId(graphqlRun, data);
		const team = data.organization?.team;
		if (!team) throw new Error(`branches: force_push_bypassers actor "${raw}": the organization "${actor.org}" has no team with slug "${actor.team}" (or the token cannot see it); check the actor spelling in the settings file`);
		id = team.id;
	} else {
		const result = await ctx.read.appLookup.tryCall(exec, {
			params: { app_slug: actor.slug },
			describe: `resolving force-push bypass App "${raw}"`
		});
		if ("error" in result) throw new Error(`branches: force_push_bypassers actor "${raw}": no GitHub App with slug "${actor.slug}" exists; check the actor spelling in the settings file`);
		id = result.data?.node_id;
	}
	if (typeof id !== "string" || id.length === 0) throw new Error(`branches: force_push_bypassers actor "${raw}": the ${actor.kind === "app" ? "App lookup" : "GraphQL lookup"} succeeded but returned no node id, so the allowance cannot be applied; re-run the workflow, and report this if it persists`);
	graphqlRun.actorIds.set(cacheKey, id);
	return id;
}
function adoptRepoId(graphqlRun, data) {
	const id = data.repository?.id;
	if (graphqlRun.repoId === null && typeof id === "string" && id.length > 0) graphqlRun.repoId = id;
}
/**
* Read at EXECUTION time when the plan-time fetch did not carry the rule: a PUT planned earlier may
* have created it, or the rules query answered its tolerated NOT_FOUND.
*/
async function lateRuleId(ctx, pattern) {
	const node = (await fetchRules(ctx))?.get(pattern);
	if (node === void 0) throw new Error(`branches[${pattern}]: the branch is protected but no branch protection rule with that pattern is visible through GraphQL, so its GraphQL-only fields cannot be set; check that the token can read branch protection rules, re-run the workflow, and report this if it persists`);
	return node.id;
}
/** IN DECLARED ORDER, one lookup at a time, so the request log stays deterministic. */
async function resolveActorIds(ctx, exec, graphqlRun, actors) {
	const ids = [];
	for (const actor of actors) ids.push(await resolveActorId(ctx, exec, graphqlRun, actor));
	return ids;
}
function wildcardInput(protection) {
	const input = translateWildcardProtection(protection);
	if (protection.required_deployments !== void 0) Object.assign(input, deploymentInputFields(protection.required_deployments));
	return input;
}
/**
* Check mode must never issue the execution-time lookups (actor ids, the repository id, a rule id
* the plan-time fetch did not carry): a fine-grained denial answers NOT_FOUND where the posture
* promises the denial surfaces at the first write. A plain value when nothing is late, so the
* idempotence proof compares it by field.
*/
function ruleVariables(ctx, graphqlRun, fields, actors, late) {
	if (actors === void 0 && late === void 0) return { input: fields };
	if (actors !== void 0) graphqlRun.lateActors.push(...actors);
	return async (exec) => ({ input: {
		...fields,
		...actors === void 0 ? {} : { bypassForcePushActorIds: await resolveActorIds(ctx, exec, graphqlRun, actors) },
		...late === void 0 ? {} : await late(exec)
	} });
}
async function repositoryNodeId(ctx, exec, graphqlRun) {
	if (graphqlRun.repoId === null) {
		const id = (await ctx.read.repoLookup.call(exec, repoVariables(ctx), { describe: "resolving the repository's GraphQL node id" })).repository?.id;
		if (typeof id !== "string" || id.length === 0) throw new Error("branches: the repository lookup returned no GraphQL node id, so no protection rule can be created; re-run the workflow and retry if it persists");
		graphqlRun.repoId = id;
	}
	return graphqlRun.repoId;
}
/** Every planned write carries a non-empty drift list as its justification. */
function justified(lines) {
	const [first, ...rest] = lines;
	return first === void 0 ? null : [first, ...rest];
}
function verifiedChange(line, entryName, declared, payloadKey) {
	if (declared === void 0) return line;
	return (response) => {
		verifyDeploymentReadback(entryName, declared, response, payloadKey);
		return line;
	};
}
function planRoutedUpdate(ctx, graphqlRun, plan, entry) {
	const { name, protection, prefix, putPlanned } = entry;
	const { force_push_bypassers: forcePushBypassers, required_deployments: requiredDeployments } = protection;
	const node = graphqlRun.rules?.get(name);
	const routedKeys = [...forcePushBypassers === void 0 ? [] : ["force_push_bypassers"], ...requiredDeployments === void 0 ? [] : ["required_deployments"]].join(" and ");
	const routedDrift = routedKeyDrift(prefix, protection, graphqlRun.rules, name);
	if (routedDrift.length === 0 && putPlanned) routedDrift.push(`${prefix}: ${routedKeys} re-applied after the protection PUT (GitHub does not document whether the PUT preserves them)`);
	const drift = justified(routedDrift);
	if (drift === null) return;
	const deploymentFields = requiredDeployments === void 0 ? {} : deploymentInputFields(requiredDeployments);
	plan.ops.push({
		role: "updateRule",
		describe: `setting the GraphQL-only protection fields of branch "${name}"`,
		variables: node !== void 0 ? ruleVariables(ctx, graphqlRun, {
			branchProtectionRuleId: node.id,
			...deploymentFields
		}, forcePushBypassers) : ruleVariables(ctx, graphqlRun, deploymentFields, forcePushBypassers, async () => ({ branchProtectionRuleId: await lateRuleId(ctx, name) })),
		drift,
		change: verifiedChange(`set ${routedKeys} on "${name}"`, name, requiredDeployments, "updateBranchProtectionRule")
	});
}
async function planWildcardEntry(ctx, graphqlRun, branch, plan) {
	const pattern = branch.name;
	const prefix = `branches[${pattern}].protection`;
	const node = graphqlRun.rules?.get(pattern);
	if (branch.protection === null) {
		if (node === void 0) return;
		plan.ops.push({
			role: "deleteRule",
			variables: { input: { branchProtectionRuleId: node.id } },
			describe: `deleting the protection rule "${pattern}"`,
			drift: [`branches[${pattern}]: a live rule matches this pattern but the settings file declares protection: null; apply will delete the rule`],
			change: `deleted protection rule "${pattern}"`
		});
		return;
	}
	const deployments = branch.protection.required_deployments;
	const actors = branch.protection.force_push_bypassers;
	const fields = wildcardInput(branch.protection);
	if (node === void 0) {
		plan.ops.push({
			role: "createRule",
			variables: ruleVariables(ctx, graphqlRun, {
				pattern,
				...fields
			}, actors, async (exec) => ({ repositoryId: await repositoryNodeId(ctx, exec, graphqlRun) })),
			describe: `creating the protection rule "${pattern}"`,
			drift: [`branches[${pattern}]: no live rule matches this pattern but the settings file declares protection; apply will create the rule`],
			change: verifiedChange(`created protection rule "${pattern}"`, pattern, deployments, "createBranchProtectionRule")
		});
		return;
	}
	const declared = { ...branch.protection };
	delete declared.force_push_bypassers;
	delete declared.required_deployments;
	const drift = justified([...subsetDiff(declared, classicViewOfRule(node), prefix), ...routedKeyDrift(prefix, branch.protection, graphqlRun.rules, pattern)]);
	if (drift === null) return;
	plan.ops.push({
		role: "updateRule",
		variables: ruleVariables(ctx, graphqlRun, {
			branchProtectionRuleId: node.id,
			...fields
		}, actors),
		describe: `updating the protection rule "${pattern}"`,
		drift,
		change: verifiedChange(`updated protection rule "${pattern}"`, pattern, deployments, "updateBranchProtectionRule")
	});
}
//#endregion
//#region src/sections/branches/index.ts
/**
* `branches:` section: classic branch protection, [{name, protection: {...} | null}]. Three keys
* cannot ride the protection PUT; the one rules query fires only when an entry needs the GraphQL
* surface, so a pure-REST declaration issues no GraphQL request at all.
*
* required_signatures                          -> GitHub's PUT silently drops it; its own POST/DELETE sub-endpoint applies it
* force_push_bypassers, required_deployments   -> no REST field at all; one updateBranchProtectionRule mutation applies both
* a WILDCARD name (contains `*`, `?`, or `[`)  -> invisible to every REST protection endpoint; the rule mutations, GraphQL-twin keys only
*/
const REQUIRED_PROTECTION_KEYS = [
	"required_status_checks",
	"enforce_admins",
	"required_pull_request_reviews",
	"restrictions"
];
/** Git refnames forbid `*`, `?`, and `[`, so a wildcard entry can never collide with a literal branch. */
function isWildcardPattern(name) {
	return /[*?[]/.test(name);
}
const STATUS_CHECK_ALIASES = {
	"required_status_checks.checks": "required_status_checks.contexts",
	"required_status_checks.contexts": "required_status_checks.checks"
};
/**
* Nothing the replacing PUT would need to preserve: GitHub's default fill under a declared block,
* an empty list, or an actor holder with empty lists. Any other nested object is a control that is
* ON by its presence.
*/
function isEmptySetting(value) {
	if (value === null || value === void 0 || value === false || value === "" || value === 0) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (isPlainMapping(value)) {
		const keys = Object.keys(value);
		return keys.length > 0 && keys.every((key) => ACTOR_LIST_KEYS.has(key) && isEmptySetting(value[key]));
	}
	return false;
}
/**
* The PUT replaces each nested object whole, so every non-empty live value at a path the
* declaration omits, at any depth, would be reset by it.
*/
function omittedLiveDrift(declared, live, prefix, path = "") {
	const drift = [];
	for (const [key, value] of Object.entries(live)) {
		const keyPath = path === "" ? key : `${path}.${key}`;
		if (Object.hasOwn(declared, key)) {
			const inner = declared[key];
			if (isPlainMapping(inner) && isPlainMapping(value)) drift.push(...omittedLiveDrift(inner, value, prefix, keyPath));
			continue;
		}
		const alias = STATUS_CHECK_ALIASES[keyPath];
		if (alias !== void 0 && Object.hasOwn(declared, alias.slice(alias.lastIndexOf(".") + 1))) continue;
		if (isEmptySetting(value)) continue;
		drift.push(`${prefix}.${keyPath}: set live but omitted from the settings file, so apply would REMOVE it; add ${keyPath} to the branch's protection in the settings file to keep it`);
	}
	return drift;
}
function isPlainMapping(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const permission$13 = { repo: ["administration"] };
const LiveProtection = z.looseObject({ required_signatures: z.looseObject({ enabled: z.boolean() }).optional() });
const WILDCARD_KEY_ERROR = (name, key) => `the wildcard entry "${name}" declares protection.${key}, which this section does not manage on wildcard rules; only the keys it can round-trip through the GraphQL rule mutations apply here: [${WILDCARD_KEYS.join(", ")}]. For actor lists and richer controls, prefer the rulesets section (the modern successor of classic protection)`;
const branchesSection = {
	key: "branches",
	undeclaredDefault: "untouched",
	permission: permission$13,
	endpoints: ENDPOINTS$15,
	graphql: GRAPHQL,
	shape: loosen(BranchesConfig).superRefine((declared, refineCtx) => {
		if (!Array.isArray(declared)) return;
		declared.forEach((entry, index) => {
			if (!isWildcardPattern(entry.name) || entry.protection === null) return;
			const protection = entry.protection;
			for (const key of Object.keys(protection)) if (!WILDCARD_KEY_SET.has(key)) refineCtx.addIssue({
				code: "custom",
				path: [
					index,
					"protection",
					key
				],
				message: WILDCARD_KEY_ERROR(entry.name, key)
			});
			const nested = [["required_status_checks", GRAPHQL_STATUS_CHECK_TWINS], ["required_pull_request_reviews", GRAPHQL_REVIEW_TWINS]];
			for (const [key, twins] of nested) {
				const value = protection[key];
				if (value === null || value === void 0) continue;
				if (typeof value !== "object" || Array.isArray(value)) {
					refineCtx.addIssue({
						code: "custom",
						path: [
							index,
							"protection",
							key
						],
						message: `the wildcard entry "${entry.name}" declares protection.${key} as ${Array.isArray(value) ? "a list" : JSON.stringify(value)}, but on a wildcard rule it must be a mapping of its sub-keys [${Object.keys(twins).join(", ")}], or null to turn the control off`
					});
					continue;
				}
				for (const subKey of Object.keys(value)) if (!(subKey in twins)) refineCtx.addIssue({
					code: "custom",
					path: [
						index,
						"protection",
						key,
						subKey
					],
					message: WILDCARD_KEY_ERROR(entry.name, `${key}.${subKey}`)
				});
			}
		});
	}),
	async plan(ctx, desired) {
		rejectDuplicates(this, desired, (b) => b.name, (b) => b.name);
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		const needsGraphql = (branch) => isWildcardPattern(branch.name) || hasRoutedGraphqlKeys(branch.protection);
		let entries;
		const graphqlRun = desired.some(needsGraphql) ? {
			rules: await fetchRules(ctx),
			repoId: null,
			actorIds: /* @__PURE__ */ new Map(),
			lateActors: []
		} : null;
		if (graphqlRun !== null) {
			const declaredPatterns = new Set(desired.map((branch) => branch.name));
			for (const pattern of [...graphqlRun.rules?.keys() ?? []].sort()) if (isWildcardPattern(pattern) && !declaredPatterns.has(pattern)) plan.notes.push(`undeclared classic protection rule "${pattern}" exists on the repo - declare it to manage it (this action never deletes undeclared rules)`);
			entries = desired.map((branch) => isWildcardPattern(branch.name) ? {
				kind: "wildcard",
				branch,
				graphqlRun
			} : {
				kind: "literal",
				branch,
				routed: hasRoutedGraphqlKeys(branch.protection) ? { graphqlRun } : null
			});
		} else entries = desired.map((branch) => ({
			kind: "literal",
			branch,
			routed: null
		}));
		for (const entry of entries) {
			if (entry.kind === "wildcard") {
				await planWildcardEntry(ctx, entry.graphqlRun, entry.branch, plan);
				continue;
			}
			await planLiteralEntry(ctx, this, entry.routed, entry.branch, plan);
		}
		const [lead, ...rest] = plan.ops;
		if (graphqlRun !== null && graphqlRun.lateActors.length > 0 && lead !== void 0) plan.ops = [{
			...lead,
			before: async (exec) => {
				await resolveActorIds(ctx, exec, graphqlRun, graphqlRun.lateActors);
			}
		}, ...rest];
		return plan;
	}
};
async function planLiteralEntry(ctx, section, routed, branch, plan) {
	const params = { branch: branch.name };
	const prefix = `branches[${branch.name}].protection`;
	const probe = await ctx.read.getProtection.probeAbsent({ params });
	if (branch.protection === null) {
		if ("missing" in probe) return;
		plan.ops.push({
			role: "removeProtection",
			params,
			drift: [`branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`],
			change: `removed protection from "${branch.name}"`
		});
		return;
	}
	const { required_signatures: requiredSignatures, force_push_bypassers: forcePushBypassers, required_deployments: requiredDeployments, ...payload } = branch.protection;
	for (const key of REQUIRED_PROTECTION_KEYS) if (!(key in payload)) payload[key] = null;
	let live = null;
	let putPlanned = false;
	if ("missing" in probe) {
		const branchProbe = await ctx.read.branchProbe.tryCall({ params });
		if ("error" in branchProbe && matchesRejection(MISSING_BRANCH, branchProbe.error)) throw new Error(`${section.key}: branches[${branch.name}]: ${MISSING_BRANCH.advice}`);
		plan.ops.push({
			role: "putProtection",
			params,
			payload: plainData(payload),
			describe: `replacing protection for branch "${branch.name}"`,
			drift: [`branches[${branch.name}]: unprotected live but the settings file declares protection; apply will protect it`],
			change: `applied protection to "${branch.name}"`
		});
		putPlanned = true;
	} else {
		live = flattenProtection(parseLive(section, ENDPOINTS$15.getProtection, LiveProtection, probe.data, `branch "${branch.name}"`));
		if (!("required_signatures" in live)) live.required_signatures = false;
		const declaredRest = { ...payload };
		for (const key of REQUIRED_PROTECTION_KEYS) if (!(key in branch.protection)) delete declaredRest[key];
		const { required_signatures: _liveSignatures, ...liveRest } = live;
		const drift = justified([...subsetDiff(declaredRest, live, prefix), ...omittedLiveDrift(declaredRest, liveRest, prefix)]);
		if (drift !== null) {
			plan.ops.push({
				role: "putProtection",
				params,
				payload: plainData(payload),
				describe: `replacing protection for branch "${branch.name}"`,
				drift,
				change: `applied protection to "${branch.name}"`
			});
			putPlanned = true;
		}
	}
	if (requiredSignatures !== void 0) {
		const sigDrift = subsetDiff({ required_signatures: requiredSignatures }, { required_signatures: live?.required_signatures ?? false }, prefix);
		if (sigDrift.length === 0 && putPlanned) sigDrift.push(`${prefix}.required_signatures: re-applied after the protection PUT (GitHub does not document whether the PUT preserves it)`);
		const drift = justified(sigDrift);
		if (drift !== null) plan.ops.push(requiredSignatures ? {
			role: "sigPost",
			params,
			describe: `requiring signed commits on branch "${branch.name}"`,
			drift,
			change: `required signed commits on "${branch.name}"`
		} : {
			role: "sigDelete",
			params,
			describe: `removing the signed-commit requirement from branch "${branch.name}"`,
			drift,
			change: `removed the signed-commit requirement from "${branch.name}"`
		});
	}
	if (routed !== null) planRoutedUpdate(ctx, routed.graphqlRun, plan, {
		name: branch.name,
		protection: branch.protection,
		prefix,
		putPlanned
	});
}
/**
* GET /protection wraps booleans as {url, enabled} and expands actor lists into user/team/app
* OBJECTS, while the PUT shape uses login/slug strings; both unwrap so check compares like with
* like. Exported so the e2e state tests can assert their protectionFromPut inverts this exact function.
*/
function flattenProtection(live) {
	const out = {};
	for (const [key, value] of Object.entries(live)) {
		if (GET_ONLY_KEYS.has(key) || isUrlKey(key)) continue;
		out[key] = flattenValue(value);
	}
	const checks = out.required_status_checks;
	if (typeof checks === "object" && checks !== null && !Array.isArray(checks)) delete checks.enforcement_level;
	return out;
}
const GET_ONLY_KEYS = /* @__PURE__ */ new Set(["name", "enabled"]);
const isUrlKey = (key) => key === "url" || key.endsWith("_url");
const ACTOR_NAME_KEYS = ["login", "slug"];
const ACTOR_LIST_KEYS = /* @__PURE__ */ new Set([
	"users",
	"teams",
	"apps"
]);
function flattenValue(value) {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) return value.map(flattenValue);
	const record = value;
	const keys = Object.keys(record);
	if ("enabled" in record && typeof record.enabled === "boolean" && keys.every((k) => k === "enabled" || k === "url" || k.endsWith("_url"))) return record.enabled;
	const out = {};
	for (const [key, inner] of Object.entries(record)) if (ACTOR_LIST_KEYS.has(key) && Array.isArray(inner)) out[key] = inner.map((actor) => {
		if (typeof actor === "object" && actor !== null) for (const nameKey of ACTOR_NAME_KEYS) {
			const name = actor[nameKey];
			if (typeof name === "string") return name;
		}
		return actor;
	});
	else if (isUrlKey(key)) {} else out[key] = flattenValue(inner);
	return out;
}
const checkSuitePreferencesSection = {
	key: "check_suite_preferences",
	undeclaredDefault: "untouched",
	permission: { repo: ["checks"] },
	grantCaveat: "the token owner must be a repository administrator, and with no read endpoint there is nothing to preflight - a denied write surfaces only after other sections' writes landed",
	endpoints: { update: {
		route: "PATCH /repos/{owner}/{repo}/check-suites/preferences",
		statuses: { 200: "the resulting preferences plus the repository" },
		alwaysRewrite: true
	} },
	shape: loosen(CheckSuitePreferencesConfig),
	async plan(_ctx, desired) {
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		plan.notes.push(writeOnlyCheckNote(this, {
			resource: "check suite preferences",
			reasserts: "the declared preferences"
		}));
		plan.ops.push({
			role: "update",
			payload: plainData(desired),
			describe: "setting check suite preferences",
			drift: [],
			change: (response) => {
				const echoed = response?.preferences?.auto_trigger_checks;
				const count = Array.isArray(echoed) ? echoed.length : desired.auto_trigger_checks.length;
				return `applied check suite preferences (${count} auto_trigger_checks ${count === 1 ? "entry" : "entries"})`;
			}
		});
		return plan;
	}
};
//#endregion
//#region src/sections/shared/setup-section.ts
/**
* The "setup" section factory: code-scanning default setup and code-quality
* setup expose the same GET/PATCH pair under different paths, so each section
* module is ONE setupSection() call over the shared verbatim-PATCH plan.
*/
/** The factory derives routes, shape, and grade from THIS map, so a key paired with another setup's facts is unrepresentable. */
const SETUPS = {
	code_scanning_default_setup: {
		path: "code-scanning/default-setup",
		slice: CodeScanningDefaultSetupConfig,
		read: {}
	},
	code_quality_setup: {
		path: "code-quality/setup",
		slice: CodeQualitySetupConfig,
		read: { accessGrade: "write" }
	}
};
/** The 202 body's configuration run; the optional fields admit the spec's plain-200 EMPTY object, nullish a null or absent body. */
const LiveConfigurationRun = z.looseObject({
	run_id: z.number().optional(),
	run_url: z.string().optional()
}).nullish();
/** The verbatim-PATCH plan, the named 202 configuration run, and the 409 advice live here once; routes, shape, and read grade derive from the key. */
function setupSection(setup) {
	const { key, permission, grantCaveat, noun } = setup;
	const { path, slice, read } = SETUPS[key];
	const readGrade = read;
	const endpoints = {
		get: {
			route: `GET /repos/{owner}/{repo}/${path}`,
			statuses: { 200: `the current ${noun} configuration` },
			primaryRead: { notFound: "denied" },
			...readGrade
		},
		update: {
			route: `PATCH /repos/{owner}/{repo}/${path}`,
			statuses: {
				200: "setup updated",
				202: "GitHub started an async configuration run; the body carries run_id",
				409: "a configuration run is already in progress"
			}
		}
	};
	const wide = endpoints;
	const plan = async (ctx, declared) => {
		const desired = declared;
		const planned = {
			ops: [],
			notes: [],
			drift: []
		};
		const drift = subsetDiff(desired, await ctx.read.get.call(), key);
		if (!hasDrift(drift)) return planned;
		planned.ops.push({
			role: "update",
			payload: plainData(desired),
			drift,
			tolerate: {
				statuses: [409],
				outcome: (error) => ({ failure: `${key}: PATCH ${expand(wide.update, ctx)}: ${error.status} ${error.message}. A ${noun} configuration run is already in progress on the repository; re-run the workflow after it finishes` })
			},
			change: (response) => {
				const run = parseLive(section, wide.update, LiveConfigurationRun, response);
				if (run?.run_id === void 0) return `applied ${noun}`;
				const url = run.run_url ? ` (${run.run_url})` : "";
				return `applied ${noun}; GitHub started configuration run ${run.run_id}${url} to roll it out, and the settings take effect when it finishes`;
			}
		});
		return planned;
	};
	const snapshot = async (ctx) => {
		const live = await ctx.read.get.call();
		return {
			value: projectOntoSchema(slice, live),
			notes: []
		};
	};
	const section = {
		key,
		undeclaredDefault: "untouched",
		permission,
		grantCaveat,
		endpoints,
		shape: requirePlainMapping(loosen(slice)),
		plan,
		snapshot
	};
	return section;
}
//#endregion
//#region src/sections/code_quality_setup/index.ts
const codeQualitySetupSection = setupSection({
	key: "code_quality_setup",
	permission: { repo: ["administration"] },
	grantCaveat: "a 403 on this endpoint can also mean code quality is unavailable on the repository, or the repository is archived",
	noun: "code quality setup"
});
//#endregion
//#region src/sections/code_scanning_default_setup/index.ts
const codeScanningDefaultSetupSection = setupSection({
	key: "code_scanning_default_setup",
	permission: { repo: ["administration", "code_scanning_alerts"] },
	grantCaveat: "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived",
	noun: "code scanning default setup"
});
//#endregion
//#region src/sections/codespaces_secrets/index.ts
/**
* `codespaces_secrets:` section: repository Codespaces secrets through the shared secrets engine
* (shared/repo-secrets.ts). The fine-grained "Codespaces secrets" permission gates every endpoint
* here at WRITE on real GitHub, reads included, so both GETs declare accessGrade "write" and a
* read-only grant fails the list exactly like a missing one.
*/
const codespacesSecretsSection = repoSecretsSection({
	key: "codespaces_secrets",
	resource: "codespaces_secrets",
	noun: "Codespaces secret",
	accessGrade: "write"
});
//#endregion
//#region src/sections/shared/roles.ts
/** The one normalizer shared by two sections: collaborators and teams. */
/** Both handlers default an entry without `permission` to it, so the two sections cannot disagree; "push" is GitHub's own write default. */
const DEFAULT_ROLE = "push";
/**
* GET reports role_name in the read vocabulary (read/write) while the PUT takes pull/push, so check mode
* compares like with like. Custom org role names pass through.
*/
function roleForPermission(permission) {
	return ROLE_FOR_PERMISSION.get(permission) ?? permission;
}
const ROLE_FOR_PERMISSION = /* @__PURE__ */ new Map([["push", "write"], ["pull", "read"]]);
new Map([...ROLE_FOR_PERMISSION].map(([permission, role]) => [role, permission]));
/**
* The GET reports this enum and the PATCH accepts nothing else, so a declared custom org role can never be
* verified on (or set on) a pending invitation; the PUT applies it once accepted. The e2e mock's stored
* invitations must stay inside it; a lockstep test pins it to the trimmed OpenAPI spec.
*/
const INVITATION_ROLES = /* @__PURE__ */ new Set([
	"read",
	"write",
	"maintain",
	"triage",
	"admin"
]);
//#endregion
//#region src/sections/collaborators/index.ts
/** `collaborators:` section: direct collaborators by username plus their pending invitations; the owner is never removed. */
const LiveCollaborator = z.looseObject({
	login: z.string(),
	permissions: z.record(z.string(), z.boolean()).optional(),
	role_name: z.string().optional()
});
const LiveInvitation = z.looseObject({
	id: z.number(),
	invitee: z.looseObject({ login: z.string().optional() }).nullable().optional(),
	permissions: z.string().optional(),
	expired: z.boolean().optional()
});
function isNamedInvitation(invitation) {
	return typeof invitation.invitee?.login === "string" && invitation.invitee.login !== "";
}
const permission$11 = { repo: ["administration"] };
const ENDPOINTS$13 = {
	list: {
		route: "GET /repos/{owner}/{repo}/collaborators",
		statuses: { 200: "the direct-collaborator list" },
		primaryRead: { notFound: "denied" }
	},
	update: {
		route: "PUT /repos/{owner}/{repo}/collaborators/{username}",
		statuses: {
			201: "invitation created",
			204: "collaborator already had the access"
		}
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/collaborators/{username}",
		statuses: { 204: "collaborator removed" }
	},
	listInvitations: {
		route: "GET /repos/{owner}/{repo}/invitations",
		statuses: { 200: "the pending-invitation list" }
	},
	updateInvitation: {
		route: "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}",
		statuses: { 200: "invitation permission updated" }
	},
	cancelInvitation: {
		route: "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}",
		statuses: { 204: "invitation cancelled" }
	}
};
const collaboratorsSection = {
	key: "collaborators",
	undeclaredDefault: "delete",
	permission: permission$11,
	endpoints: ENDPOINTS$13,
	shape: loosen(knobbed(CollaboratorConfig)),
	closedSurface: {
		known: {
			username: true,
			permission: true
		},
		describe: (c) => c.username,
		consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`
	},
	async plan(ctx, declared) {
		const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
		rejectDuplicates(this, desired, (c) => c.username.toLowerCase(), (c) => c.username);
		const live = parseLive(this, ENDPOINTS$13.list, z.array(LiveCollaborator), await ctx.read.list.listAll({ query: { affiliation: "direct" } }));
		const liveByLogin = new Map(live.map((c) => [c.login.toLowerCase(), c]));
		const allInvitations = parseLive(this, ENDPOINTS$13.listInvitations, z.array(LiveInvitation), await ctx.read.listInvitations.listAll());
		const invitations = allInvitations.filter(isNamedInvitation);
		const emailInvitations = allInvitations.filter((invitation) => !isNamedInvitation(invitation));
		const inviteByLogin = new Map(invitations.map((invitation) => [invitation.invitee.login.toLowerCase(), invitation]));
		const declaredKeys = /* @__PURE__ */ new Set();
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		for (const collaborator of desired) {
			const { username } = collaborator;
			const login = username.toLowerCase();
			declaredKeys.add(login);
			const wantPermission = collaborator.permission ?? "push";
			const wantRole = roleForPermission(wantPermission);
			const label = `collaborators[${username}]`;
			const existing = liveByLogin.get(login);
			if (existing) {
				if ((existing.role_name ?? "") !== wantRole) plan.ops.push({
					role: "update",
					params: { username },
					payload: { permission: wantPermission },
					describe: `updating collaborator "${username}"`,
					drift: [`${label}: live role "${existing.role_name}" != declared "${wantRole}"; apply will set the declared permission`],
					change: `updated collaborator "${username}" (${wantPermission})`
				});
				continue;
			}
			const invitation = inviteByLogin.get(login);
			if (invitation && invitation.expired !== true) {
				if (!INVITATION_ROLES.has(wantRole)) {
					plan.notes.push(`invitation for "${username}" is pending; invitations report only the standard roles, so it cannot be compared to the declared custom role "${wantPermission}" - left untouched, the declared role is applied once the invitation is accepted`);
					continue;
				}
				if ((invitation.permissions ?? "") !== wantRole) plan.ops.push({
					role: "updateInvitation",
					params: { invitation_id: String(invitation.id) },
					payload: { permissions: wantRole },
					describe: `updating the pending invitation for "${username}"`,
					drift: [`${label}: pending invitation permission "${invitation.permissions}" != declared "${wantRole}"; apply will update the invitation`],
					change: `updated pending invitation for "${username}" (${wantPermission})`
				});
				continue;
			}
			if (invitation) plan.ops.push({
				role: "cancelInvitation",
				params: { invitation_id: String(invitation.id) },
				describe: `cancelling the expired invitation for "${username}"`,
				drift: [`${label}: pending invitation expired; apply will cancel it and send a fresh invitation with "${wantPermission}"`],
				change: `cancelled the expired invitation for "${username}"`
			});
			plan.ops.push({
				role: "update",
				params: { username },
				payload: { permission: wantPermission },
				describe: `inviting collaborator "${username}"`,
				drift: [`${label}: missing - not a collaborator on the repo; apply will send an invitation with "${wantPermission}"`],
				change: invitation ? `re-invited collaborator "${username}" (${wantPermission}) - the pending invitation had expired` : `invited collaborator "${username}" (${wantPermission})`
			});
		}
		for (const collaborator of live) {
			const login = collaborator.login.toLowerCase();
			if (login === ctx.repo.owner.toLowerCase() || declaredKeys.has(login)) continue;
			if (policy === "keep") {
				plan.notes.push(undeclaredNote({
					subject: `collaborator "${collaborator.login}"`,
					state: "has access but is not declared",
					add: "them",
					manage: "their access",
					action: "REMOVE them"
				}));
				continue;
			}
			plan.ops.push({
				role: "remove",
				params: { username: collaborator.login },
				drift: [undeclaredDrift(defaultUndeclaredPolicy(this), {
					label: `collaborators[${collaborator.login}]`,
					action: "REMOVE them",
					add: "them",
					keep: "their access"
				})],
				change: `REMOVED undeclared collaborator "${collaborator.login}"`
			});
		}
		for (const invitation of invitations) {
			const invitee = invitation.invitee.login;
			if (declaredKeys.has(invitee.toLowerCase())) continue;
			if (policy === "keep") {
				plan.notes.push(undeclaredNote({
					subject: `invitation for "${invitee}"`,
					state: "is pending but not declared",
					add: "them",
					manage: "their access",
					action: "CANCEL the invitation"
				}));
				continue;
			}
			plan.ops.push({
				role: "cancelInvitation",
				params: { invitation_id: String(invitation.id) },
				drift: [undeclaredDrift(defaultUndeclaredPolicy(this), {
					label: `collaborators[${invitee}]`,
					state: "a pending invitation not in the settings file",
					action: "CANCEL it",
					add: "them",
					keep: "the invitation"
				})],
				change: `CANCELLED undeclared invitation for "${invitee}"`
			});
		}
		for (const invitation of emailInvitations) plan.notes.push(`invitation ${invitation.id} was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted`);
		return plan;
	}
};
//#endregion
//#region src/sections/custom_properties/index.ts
/**
* `custom_properties:` section: values of organization-defined custom properties, set through ONE
* bulk PATCH. Definitions are org-scoped, so only values are managed; a personal account no-ops
* with a note, and `value: null` unsets (reverting to the org default).
*/
const permission$10 = { repo: ["custom_properties"] };
/** GitHub stores true_false values as the strings "true"/"false" and numbers as their string form. */
function normalizeValue(value) {
	if (value === null) return null;
	if (Array.isArray(value)) return [...value];
	return typeof value === "string" ? value : String(value);
}
/**
* Lists compare by SET MEMBERSHIP: a multi_select value is a set, so a reordered declaration is not
* drift, and a live-side duplicate GitHub would collapse still converges instead of re-writing forever.
*/
function sameValue(a, b) {
	if (Array.isArray(a) && Array.isArray(b)) {
		const setA = new Set(a);
		const setB = new Set(b);
		return setA.size === setB.size && [...setA].every((element) => setB.has(element));
	}
	return a === b;
}
function show(value) {
	return value === null ? "unset" : JSON.stringify(value);
}
/**
* A repeated option is a typo the set comparison would hide forever. An empty list is rejected
* because GitHub does not document whether [] stores or normalizes to unset, so it could re-write
* on every apply; value: null is the documented unset.
*/
function rejectMalformedList(property) {
	if (!Array.isArray(property.value)) return;
	if (property.value.length === 0) throw new Error(`custom_properties: the "${property.property_name}" entry declares an empty list; declare value: null to unset the property instead`);
	const seen = /* @__PURE__ */ new Set();
	for (const element of property.value) {
		if (seen.has(element)) throw new Error(`custom_properties: the "${property.property_name}" entry lists the value ${JSON.stringify(element)} more than once; a multi_select value is a set, so keep each option exactly once`);
		seen.add(element);
	}
}
const ENDPOINTS$12 = {
	org: {
		route: "GET /orgs/{org}",
		statuses: {
			200: "the organization",
			404: "not an organization (a personal account)"
		},
		permission: "none",
		primaryRead: { notFound: "absent" }
	},
	list: {
		route: "GET /repos/{owner}/{repo}/properties/values",
		statuses: { 200: "the custom property values" },
		permission: "none"
	},
	update: {
		route: "PATCH /repos/{owner}/{repo}/properties/values",
		statuses: { 204: "custom property values updated" },
		denialHint: "a 403 here can also mean the organization restricts a declared property's values to organization actors (values_editable_by: org_actors), which no repository-scoped token can satisfy",
		hints: { 422: "each declared property must be DEFINED at the organization level first, and its value must fit the definition; see the organization's custom properties settings" }
	}
};
const LiveProperty = z.looseObject({
	property_name: z.string(),
	value: z.union([
		z.string(),
		z.array(z.string()),
		z.null()
	])
});
const customPropertiesSection = {
	key: "custom_properties",
	undeclaredDefault: "keep",
	permission: permission$10,
	ownerSensitivity: "org",
	endpoints: ENDPOINTS$12,
	shape: loosen(knobbed(CustomPropertyConfig)),
	closedSurface: {
		known: {
			property_name: true,
			value: true
		},
		describe: (p) => p.property_name,
		consequence: "the key would silently never reach GitHub and the misdeclared property would keep its live value"
	},
	async plan(ctx, declared) {
		const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
		rejectDuplicates(this, desired, (p) => p.property_name, (p) => p.property_name);
		for (const property of desired) rejectMalformedList(property);
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		if ("missing" in await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } })) {
			plan.notes.push(`custom_properties: owner "${ctx.repo.owner}" is a personal account, and custom properties require an organization-owned repository; section skipped - remove the custom_properties section from the settings file to silence this note`);
			return plan;
		}
		const live = parseLive(this, ENDPOINTS$12.list, z.array(LiveProperty), await ctx.read.list.call());
		const liveByName = new Map(live.map((p) => [p.property_name, p.value]));
		const declaredNames = new Set(desired.map((p) => p.property_name));
		const updates = [];
		for (const property of desired) {
			const name = property.property_name;
			const wanted = normalizeValue(property.value);
			const current = liveByName.get(name) ?? null;
			if (sameValue(wanted, current)) continue;
			const label = `custom_properties[${name}]`;
			updates.push(wanted === null ? {
				property_name: name,
				value: null,
				drift: `${label}: declared null but the live value is ${show(current)}; apply will unset it (reverting to the org default, if any)`,
				change: `unset custom property "${name}"`
			} : {
				property_name: name,
				value: wanted,
				drift: `${label}: declared ${show(wanted)} != live ${show(current)}; apply will set the declared value`,
				change: `set custom property "${name}" to ${show(wanted)}`
			});
		}
		for (const property of live) {
			const name = property.property_name;
			if (declaredNames.has(name) || property.value === null) continue;
			if (policy === "keep") {
				plan.notes.push(undeclaredNote({
					subject: `custom property "${name}"`,
					state: "is set on the repo but not declared",
					action: "UNSET it"
				}));
				continue;
			}
			updates.push({
				property_name: name,
				value: null,
				drift: undeclaredDrift(defaultUndeclaredPolicy(this), {
					label: `custom_properties[${name}]`,
					action: "unset it (reverting to the org default, if any)"
				}),
				change: `unset undeclared custom property "${name}"`
			});
		}
		const [first, ...rest] = updates;
		if (first === void 0) return plan;
		plan.ops.push({
			role: "update",
			payload: { properties: updates.map(({ property_name, value }) => ({
				property_name,
				value
			})) },
			describe: "updating custom property values",
			drift: [first.drift, ...rest.map((update) => update.drift)],
			change: () => [first.change, ...rest.map((update) => update.change)]
		});
		return plan;
	},
	async snapshot(ctx) {
		if ("missing" in await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } })) return {
			value: void 0,
			notes: [`custom_properties: owner "${ctx.repo.owner}" is a personal account, and custom properties require an organization-owned repository; nothing to snapshot`]
		};
		const set = parseLive(this, ENDPOINTS$12.list, z.array(LiveProperty), await ctx.read.list.call()).flatMap((property) => {
			if (property.value === null) return [];
			if (!Array.isArray(property.value)) return [property];
			const options = [...new Set(property.value)];
			return options.length === 0 ? [] : [{
				...property,
				value: options
			}];
		});
		if (set.length === 0) return {
			value: void 0,
			notes: []
		};
		const entries = set.map((property) => projectOntoSchema(CustomPropertyConfig, property));
		return {
			value: knobbedSnapshot(this, entries),
			notes: []
		};
	}
};
//#endregion
//#region src/sections/dependabot_secrets/index.ts
const dependabotSecretsSection = repoSecretsSection({
	key: "dependabot_secrets",
	resource: "dependabot_secrets",
	noun: "Dependabot secret"
});
//#endregion
//#region src/sections/deploy_keys/index.ts
/**
* `deploy_keys:` section: deploy keys matched by exact title; the declared material is a PUBLIC key.
* Immutable upstream (no update role), so a changed key or read_only flag is delete plus recreate.
*/
const LiveDeployKey = z.looseObject({
	id: z.number(),
	title: z.string(),
	key: z.string(),
	read_only: z.boolean().optional()
});
const ENDPOINTS$11 = {
	list: {
		route: "GET /repos/{owner}/{repo}/keys",
		statuses: { 200: "the deploy key list" },
		primaryRead: { notFound: "denied" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/keys",
		statuses: { 201: "deploy key created" },
		hints: { 422: "A public key can be attached to only ONE repository account-wide, so a 422 here can mean the key is already in use elsewhere; generate a distinct keypair per repository" }
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/keys/{key_id}",
		statuses: { 204: "deploy key deleted" }
	}
};
/** GitHub may strip the trailing comment, so only the algorithm and the base64 blob compare. */
function normalizeKeyMaterial(key) {
	const fields = key.trim().split(/\s+/);
	const algorithm = fields[0];
	const blob = fields[1];
	if (algorithm === void 0 || blob === void 0) return null;
	return `${algorithm} ${blob}`;
}
function declaredMaterial(title, key) {
	const normalized = normalizeKeyMaterial(key);
	if (normalized === null) throw new Error(`deploy_keys[${title}]: the declared key must have at least two whitespace-separated fields (an algorithm and a base64 blob, e.g. "ssh-ed25519 AAAAC3..."), got ${JSON.stringify(key)}`);
	return normalized;
}
function liveMaterial(live) {
	const normalized = normalizeKeyMaterial(live.key);
	if (normalized === null) throw new Error(`deploy_keys: GET /repos/{owner}/{repo}/keys returned key id ${live.id} ("${live.title}") whose material has fewer than two whitespace-separated fields (${JSON.stringify(live.key)}); the response does not match the documented deploy key shape - check the "api-version" input against the GitHub REST docs for this endpoint`);
	return normalized;
}
const deployKeysSection = listSection({
	key: "deploy_keys",
	permission: { repo: ["administration"] },
	undeclaredDefault: "keep",
	noun: "deploy key",
	entry: DeployKeyConfig,
	live: LiveDeployKey,
	endpoints: ENDPOINTS$11,
	identity: { field: "title" },
	address: (live) => ({ key_id: String(live.id) }),
	lens: {
		toWrite: ({ title, key, read_only, ...passthrough }) => ({
			title,
			key: declaredMaterial(title, key),
			...read_only === void 0 ? {} : { read_only },
			...passthrough
		}),
		fromLive: (live) => ({
			...live,
			key: liveMaterial(live),
			read_only: live.read_only ?? false
		}),
		matchBy: {}
	},
	recreate: (live, write) => ({
		read_only: live.read_only ?? false,
		...write
	}),
	conflicts: {
		declared: (writes) => {
			const titleByMaterial = /* @__PURE__ */ new Map();
			return writes.flatMap((write) => {
				const first = titleByMaterial.get(String(write.key));
				titleByMaterial.set(String(write.key), write.title);
				return first === void 0 ? [] : [`the entries "${first}" and "${write.title}" declare the same key material, and GitHub attaches a public key to one repository once, so the second create would be rejected - keep one entry per key`];
			});
		},
		live: (writes, live) => writes.flatMap((write) => {
			const sameTitle = live.filter((key) => key.title === write.title);
			const holder = live.find((key) => key.title !== write.title && key.key === write.key);
			return [...sameTitle.length > 1 ? [`the declared title "${write.title}" matches ${sameTitle.length} live deploy keys (ids ${sameTitle.map((key) => String(key.id)).join(", ")}), and this section manages at most one key per title - delete the duplicates on GitHub so exactly one remains`] : [], ...holder === void 0 ? [] : [`the entry "${write.title}" declares key material that live key "${holder.title}" (id ${String(holder.id)}) already holds, and GitHub attaches a public key to one repository once, so writing it would be rejected - delete or rename the live key on GitHub, or declare the entry under its live title "${holder.title}"`]];
		})
	},
	prose: { undeclaredAction: "DELETE it" }
});
//#endregion
//#region src/sections/environments/endpoints.ts
const BRANCH_POLICIES_DENIAL_HINT = "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";
const PROTECTION_RULES_DENIAL_HINT = "a 404 here can also mean the environment does not exist";
const ENDPOINTS$10 = {
	probe: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}",
		statuses: {
			200: "the environment",
			404: "no such environment yet"
		},
		primaryRead: { notFound: "absent" }
	},
	update: {
		route: "PUT /repos/{owner}/{repo}/environments/{environment_name}",
		statuses: { 200: "environment created or updated" },
		hints: { 422: "Usually \"reviewers\" entries are not {type: User|Team, id: <numeric id>} (logins and slugs are not accepted), or \"deployment_branch_policy\" does not declare both boolean keys (or null to clear it)" }
	},
	listVariables: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}/variables",
		statuses: { 200: "the environment variable list" },
		pageSize: 30
	},
	createVariable: {
		route: "POST /repos/{owner}/{repo}/environments/{environment_name}/variables",
		statuses: { 201: "environment variable created" }
	},
	updateVariable: {
		route: "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
		statuses: { 204: "environment variable updated" }
	},
	removeVariable: {
		route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
		statuses: { 204: "environment variable deleted" }
	},
	listSecrets: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets",
		statuses: { 200: "the environment secrets list (names and timestamps; never values)" }
	},
	secretsPublicKey: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key",
		statuses: { 200: "the environment sealing public key" }
	},
	putSecret: {
		route: "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
		statuses: {
			201: "environment secret created",
			204: "environment secret updated"
		},
		alwaysRewrite: true
	},
	removeSecret: {
		route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
		statuses: { 204: "environment secret deleted" }
	},
	listPolicies: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
		statuses: { 200: "the deployment branch-policy pattern list" },
		permission: { repo: ["actions"] },
		denialHint: BRANCH_POLICIES_DENIAL_HINT
	},
	createPolicy: {
		route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
		statuses: {
			200: "deployment branch policy created",
			303: "a policy with this name pattern already exists"
		},
		permission: { repo: ["administration"] },
		denialHint: BRANCH_POLICIES_DENIAL_HINT,
		hints: { 422: "Usually the pattern's \"type\" is not one of the values GitHub accepts (\"branch\" or \"tag\"); see the deployment branch policies endpoint documentation" }
	},
	removePolicy: {
		route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}",
		statuses: { 204: "deployment branch policy deleted" },
		permission: { repo: ["administration"] },
		denialHint: BRANCH_POLICIES_DENIAL_HINT
	},
	listProtectionRules: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules",
		statuses: { 200: "the enabled custom deployment protection rules" },
		permission: { repo: ["actions"] },
		denialHint: PROTECTION_RULES_DENIAL_HINT
	},
	listProtectionRuleApps: {
		route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps",
		statuses: { 200: "the protection-rule Apps available to this environment" },
		permission: { repo: ["administration"] },
		denialHint: PROTECTION_RULES_DENIAL_HINT
	},
	createProtectionRule: {
		route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules",
		statuses: { 201: "custom deployment protection rule enabled" },
		permission: { repo: ["administration"] },
		denialHint: PROTECTION_RULES_DENIAL_HINT
	},
	removeProtectionRule: {
		route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}",
		statuses: { 204: "custom deployment protection rule disabled" },
		permission: { repo: ["administration"] },
		denialHint: PROTECTION_RULES_DENIAL_HINT
	}
};
//#endregion
//#region src/sections/environments/branch-policies.ts
/**
* The nested `deployment_branch_policies` key. A pattern's type is immutable upstream, so a type
* change is a delete plus a recreate.
*/
const BRANCH_POLICIES_DEFAULT_POLICY = "delete";
/**
* GitHub's spec marks every field optional. A policy without a name has no identity to reconcile by,
* and skipping it would let check report falsely clean while the delete policy neither removed nor noted it.
*
* missing type  -> the server default "branch"
* missing name  -> loud failure
* missing id    -> loud failure when a delete addresses it
*/
const LiveBranchPolicy = z.looseObject({
	id: z.number().optional(),
	name: z.string().optional(),
	type: z.string().optional()
});
/** "branch" is GitHub's server-side default when the type is absent. */
function livePolicyType(policy) {
	return typeof policy.type === "string" ? policy.type : "branch";
}
function livePolicyId(policy, envName) {
	if (policy.id === void 0) throw new Error(`environments: the deployment branch-policy list for environment "${envName}" returned a policy without an id, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`);
	return String(policy.id);
}
function livePolicyName(policy, envName) {
	if (typeof policy.name !== "string") throw new Error(`environments: the deployment branch-policy list for environment "${envName}" returned a policy without a name, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`);
	return policy.name;
}
/**
* Two entries for one pattern could fight over its type on every run. The flag pairing is checked in
* the zod shape (schema.ts), not here, so it fails before any section writes.
*/
function validateBranchPolicies(env, entries) {
	const seen = /* @__PURE__ */ new Set();
	const duplicates = /* @__PURE__ */ new Set();
	for (const pattern of entries) {
		if (seen.has(pattern.name)) duplicates.add(pattern.name);
		seen.add(pattern.name);
	}
	if (duplicates.size > 0) throw new Error(`environments: the "${env.name}" entry declares deployment branch polic${duplicates.size === 1 ? "y" : "ies"} ${[...duplicates].map((name) => `"${name}"`).join(", ")} more than once. Keep exactly one entry per pattern`);
}
function createPolicyOp(envName, pattern) {
	return {
		role: "createPolicy",
		params: { environment_name: envName },
		payload: plainData(pattern),
		describe: `creating deployment branch policy "${pattern.name}" in environment "${envName}"`
	};
}
/** With custom_branch_policies off the pattern list 404s, so patterns already behind the flag reconcile on the next run. */
async function planBranchPolicies(ctx, section, envName, policy, entries, liveEnv) {
	const params = { environment_name: envName };
	const planned = {
		ops: [],
		notes: []
	};
	const flags = liveEnv?.deployment_branch_policy;
	const hidden = liveEnv !== void 0 && flags?.custom_branch_policies !== true;
	let live = [];
	if (hidden) planned.notes.push(`environments[${envName}].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and create the declared patterns, and any pattern already behind the flag reconciles on the next run`);
	else if (liveEnv !== void 0) live = parseLive(section, ENDPOINTS$10.listPolicies, z.array(LiveBranchPolicy), await ctx.read.listPolicies.listAllEnveloped("branch_policies", { params }), `environment "${envName}"`);
	const liveByName = /* @__PURE__ */ new Map();
	for (const pattern of live) liveByName.set(livePolicyName(pattern, envName), pattern);
	const declared = new Set(entries.map((pattern) => pattern.name));
	for (const pattern of entries) {
		const label = `environments[${envName}].deployment_branch_policies[${pattern.name}]`;
		const existing = liveByName.get(pattern.name);
		if (!existing) {
			planned.ops.push({
				...createPolicyOp(envName, pattern),
				drift: [hidden ? `${label}: not verifiable until custom_branch_policies is true; apply will create it once the flag is set` : `${label}: missing - declared in the settings file but not on the environment; apply will create it`],
				change: `created deployment branch policy "${pattern.name}" in environment "${envName}"`
			});
			continue;
		}
		const desiredType = pattern.type ?? "branch";
		const liveType = livePolicyType(existing);
		if (liveType === desiredType) continue;
		const typeDrift = subsetDiff({ type: desiredType }, { type: liveType }, label);
		if (!hasDrift(typeDrift)) throw new Error(`BUG: environments: the pattern "${pattern.name}" of environment "${envName}" has a type mismatch (${liveType} vs ${desiredType}) that subsetDiff did not render`);
		planned.ops.push({
			role: "removePolicy",
			params: {
				...params,
				branch_policy_id: livePolicyId(existing, envName)
			},
			drift: [`${label}: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it`],
			change: `deleted deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type (${liveType} -> ${desiredType})`,
			describe: `deleting deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type`
		}, {
			...createPolicyOp(envName, pattern),
			drift: typeDrift,
			change: `recreated deployment branch policy "${pattern.name}" in environment "${envName}" as type ${desiredType}`
		});
	}
	for (const [name, existing] of liveByName) {
		if (declared.has(name)) continue;
		if (policy === "keep") {
			planned.notes.push(undeclaredNote({
				subject: `deployment branch policy "${name}"`,
				state: `exists on environment "${envName}" but is not declared`,
				action: "DELETE it"
			}));
			continue;
		}
		planned.ops.push({
			role: "removePolicy",
			params: {
				...params,
				branch_policy_id: livePolicyId(existing, envName)
			},
			drift: [undeclaredDrift(BRANCH_POLICIES_DEFAULT_POLICY, {
				label: `environments[${envName}].deployment_branch_policies[${name}]`,
				action: "DELETE it"
			})],
			change: `DELETED undeclared deployment branch policy "${name}" from environment "${envName}"`,
			describe: `deleting undeclared deployment branch policy "${name}" from environment "${envName}"`
		});
	}
	return planned;
}
//#endregion
//#region src/sections/environments/protection-rules.ts
const PROTECTION_RULES_DEFAULT_POLICY = "keep";
/**
* The endpoint documents enabled rules only, so presence is the enablement signal; `enabled` is
* read as a belt over that, since a rule the API ever reported disabled must not satisfy a declared
* gate. An enabled rule without an App slug fails loudly: it has no identity to reconcile by.
*/
const LiveProtectionRule = z.looseObject({
	id: z.number().optional(),
	enabled: z.boolean().optional(),
	app: z.looseObject({
		id: z.number().optional(),
		slug: z.string().optional()
	}).optional()
});
function liveRuleSlug(rule, envName) {
	const slug = rule.app?.slug;
	if (typeof slug !== "string") throw new Error(`environments: the deployment protection rule list for environment "${envName}" returned a rule without an app slug, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`);
	return slug;
}
function liveRuleId(rule, envName) {
	if (typeof rule.id !== "number") throw new Error(`environments: the deployment protection rule list for environment "${envName}" returned a rule without a numeric id, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`);
	return String(rule.id);
}
/**
* A single call(), NOT listAllEnveloped: this endpoint documents no page/per_page parameters, so
* the page loop would append a query GitHub never specified. Both envelope keys are optional in the
* spec, so an ABSENT list reads as empty, while a PRESENT off-shape value fails loudly in parseLive.
*/
async function listProtectionRules(ctx, section, envName) {
	return parseLive(section, ENDPOINTS$10.listProtectionRules, z.looseObject({ custom_deployment_protection_rules: z.array(LiveProtectionRule).optional() }).nullable(), await ctx.read.listProtectionRules.call({
		params: { environment_name: envName },
		describe: `listing deployment protection rules of environment "${envName}"`
	}), `environment "${envName}"`)?.custom_deployment_protection_rules ?? [];
}
/** An unlisted slug means the App is not installed, which nothing this section may call can change. */
function resolveIntegrationId(apps, slug, envName) {
	const app = apps.find((candidate) => candidate.slug === slug);
	if (app === void 0) {
		const available = apps.length > 0 ? `the available Apps are ${apps.map((candidate) => `"${candidate.slug}"`).join(", ")}` : "no protection-rule Apps are available to it";
		throw new Error(`environments: the deployment protection rule App "${slug}" is not available to environment "${envName}" (${available}). Install the GitHub App providing the rule on this repository, or declare one of the available slugs`);
	}
	return app.id;
}
const LiveProtectionRuleApp = z.looseObject({
	id: z.number(),
	slug: z.string()
});
/**
* An App without a slug or id could neither be offered in the unknown-slug error nor resolve a
* declared rule, so parseLive rejects the whole listing.
*/
async function listProtectionRuleApps(ctx, section, envName) {
	return parseLive(section, ENDPOINTS$10.listProtectionRuleApps, z.array(LiveProtectionRuleApp), await ctx.read.listProtectionRuleApps.listAllEnveloped("available_custom_deployment_protection_rule_integrations", { params: { environment_name: envName } }), `environment "${envName}"`);
}
function validateProtectionRules(env, entries) {
	const seen = /* @__PURE__ */ new Set();
	const duplicates = /* @__PURE__ */ new Set();
	for (const rule of entries) {
		if (seen.has(rule.app)) duplicates.add(rule.app);
		seen.add(rule.app);
	}
	if (duplicates.size > 0) throw new Error(`environments: the "${env.name}" entry declares the deployment protection rule App${duplicates.size === 1 ? "" : "s"} ${[...duplicates].map((app) => `"${app}"`).join(", ")} more than once. Keep exactly one entry per App`);
}
/** Every missing slug resolves from one Apps read before the first POST leaves, so an unlisted slug fails before any rule is half-enabled. */
async function planProtectionRules(ctx, section, envName, policy, entries, liveEnv) {
	const params = { environment_name: envName };
	const live = liveEnv === void 0 ? [] : await listProtectionRules(ctx, section, envName);
	const liveBySlug = /* @__PURE__ */ new Map();
	for (const rule of live) {
		if (rule.enabled === false) continue;
		liveBySlug.set(liveRuleSlug(rule, envName), rule);
	}
	const declared = new Set(entries.map((rule) => rule.app));
	const planned = {
		ops: [],
		notes: []
	};
	const missing = entries.filter((rule) => !liveBySlug.has(rule.app));
	let integrationIds;
	const resolveMissing = () => {
		integrationIds ??= listProtectionRuleApps(ctx, section, envName).then((apps) => new Map(missing.map((rule) => [rule.app, resolveIntegrationId(apps, rule.app, envName)])));
		return integrationIds;
	};
	for (const rule of missing) planned.ops.push({
		role: "createProtectionRule",
		params,
		payload: async () => {
			const integrationId = (await resolveMissing()).get(rule.app);
			if (integrationId === void 0) throw new Error(`BUG: environments: the protection rule App "${rule.app}" of environment "${envName}" was planned but not resolved`);
			return { integration_id: integrationId };
		},
		drift: [`environments[${envName}].deployment_protection_rules[${rule.app}]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment`],
		change: `enabled deployment protection rule "${rule.app}" in environment "${envName}"`,
		describe: `enabling deployment protection rule "${rule.app}" in environment "${envName}"`
	});
	for (const [slug, rule] of liveBySlug) {
		if (declared.has(slug)) continue;
		if (policy === "keep") {
			planned.notes.push(undeclaredNote({
				subject: `deployment protection rule "${slug}"`,
				state: `is enabled on environment "${envName}" but is not declared`,
				action: "DISABLE it"
			}));
			continue;
		}
		planned.ops.push({
			role: "removeProtectionRule",
			params: {
				...params,
				protection_rule_id: liveRuleId(rule, envName)
			},
			drift: [undeclaredDrift(PROTECTION_RULES_DEFAULT_POLICY, {
				label: `environments[${envName}].deployment_protection_rules[${slug}]`,
				action: "DISABLE it"
			})],
			change: `DISABLED undeclared deployment protection rule "${slug}" in environment "${envName}"`,
			describe: `disabling undeclared deployment protection rule "${slug}" in environment "${envName}"`
		});
	}
	return planned;
}
//#endregion
//#region src/sections/environments/nested.ts
/**
* Stripped from the environment PUT body by splitEntry; each plans as its own sub-resource after
* the PUT, so none can leak into the PUT payload or the environment diff.
*/
const NESTED_KEYS = [
	"variables",
	"secrets",
	"deployment_branch_policies",
	"deployment_protection_rules"
];
const NESTED_PLANNERS = {
	variables: {
		defaultPolicy: "delete",
		missingNote: (envName) => `environments[${envName}].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables`,
		validate: (env, entries) => rejectDuplicateVariables(env.name, entries),
		plan: planVariables
	},
	secrets: {
		defaultPolicy: "keep",
		missingNote: (envName) => `environments[${envName}].secrets: not verifiable while the environment is missing; apply will create the environment and reconcile the declared secrets`,
		validate: (env, entries) => rejectDuplicateSecrets(env.name, entries),
		plan: planEnvironmentSecrets
	},
	deployment_branch_policies: {
		defaultPolicy: BRANCH_POLICIES_DEFAULT_POLICY,
		missingNote: (envName) => `environments[${envName}].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns`,
		validate: validateBranchPolicies,
		plan: planBranchPolicies
	},
	deployment_protection_rules: {
		defaultPolicy: PROTECTION_RULES_DEFAULT_POLICY,
		missingNote: (envName) => `environments[${envName}].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules`,
		validate: validateProtectionRules,
		plan: planProtectionRules
	}
};
/**
* Generic over K so the table default and the declared value stay correlated to one literal key.
* The parameter is spelled NonNullable<EnvironmentConfig[K]>, not the identical NestedDeclared[K]:
* tsc relates the guarded env[key] to the former directly, while the mapped-type spelling falls
* back to an intersection over every key that the differing entry types cannot satisfy.
*/
function unwrapNested(key, declared) {
	return undeclaredPolicy(declared, NESTED_PLANNERS[key].defaultPolicy);
}
function validateNested(key, env) {
	const declared = env[key];
	if (declared !== void 0) NESTED_PLANNERS[key].validate?.(env, unwrapNested(key, declared).entries);
}
async function planNested(ctx, section, key, envName, nested, liveEnv) {
	const declared = nested[key];
	if (declared === void 0) return {
		ops: [],
		notes: []
	};
	const { policy, entries } = unwrapNested(key, declared);
	const planner = NESTED_PLANNERS[key];
	const planned = await planner.plan(ctx, section, envName, policy, entries, liveEnv);
	return {
		ops: planned.ops,
		notes: liveEnv === void 0 ? [planner.missingNote(envName), ...planned.notes] : planned.notes
	};
}
/**
* Scalars the environment PUT does not accept: splitEntry strips them beside NESTED_KEYS, and each
* applies through its own routed operation after every PUT (pinned rides the GraphQL pin mutations).
* The lockstep types pin this list to EnvironmentRoutedScalars, where schema.ts declares routed-ness;
* a routed scalar declared on EnvironmentConfig itself would ride the PUT body unnoticed.
*/
const ROUTED_SCALAR_KEYS = ["pinned"];
function splitEntry(env) {
	const { name: _name, ...settings } = env;
	const nested = {};
	for (const key of NESTED_KEYS) if (key in settings) {
		nested[key] = settings[key];
		delete settings[key];
	}
	const routed = {};
	for (const key of ROUTED_SCALAR_KEYS) if (key in settings) {
		routed[key] = settings[key];
		delete settings[key];
	}
	return {
		settings,
		nested,
		routed
	};
}
/** Two spellings of one case-insensitive name would fight each other on every run. */
function rejectDuplicateVariables(envName, entries) {
	const seen = /* @__PURE__ */ new Map();
	const collisions = [];
	for (const variable of entries) {
		const key = variableKey(variable.name);
		const first = seen.get(key);
		if (first !== void 0) {
			collisions.push(`"${first}" and "${variable.name}"`);
			continue;
		}
		seen.set(key, variable.name);
	}
	if (collisions.length > 0) throw new Error(`environments: the "${envName}" entry declares variables that GitHub treats as the same variable (names are case-insensitive): ${collisions.join("; ")}. Keep exactly one entry per variable`);
}
async function planVariables(ctx, section, envName, policy, entries, liveEnv) {
	const params = { environment_name: envName };
	const label = `environments[${envName}].variables`;
	const live = liveEnv === void 0 ? [] : parseLive(section, ENDPOINTS$10.listVariables, z.array(LiveVariable), await ctx.read.listVariables.listAllEnveloped("variables", { params }), `environment "${envName}"`);
	const liveByKey = new Map(live.map((variable) => [variableKey(variable.name), variable]));
	const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));
	const planned = {
		ops: [],
		notes: []
	};
	for (const variable of entries) {
		const entryLabel = `${label}[${variable.name}]`;
		const existing = liveByKey.get(variableKey(variable.name));
		const { name: _name, value: _value, ...extraKeys } = variable;
		if (!existing) {
			planned.ops.push({
				role: "createVariable",
				params,
				payload: plainData({
					name: variable.name,
					value: variable.value,
					...extraKeys
				}),
				drift: [`${entryLabel}: missing - declared in the settings file but not on the environment; apply will create it`],
				change: `created variable "${variable.name}" in environment "${envName}"`,
				describe: `creating variable "${variable.name}" in environment "${envName}"`
			});
			continue;
		}
		const drift = [...existing.value === variable.value ? [] : [`${entryLabel}.value: declared ${JSON.stringify(variable.value)} != live ${JSON.stringify(existing.value)}; apply will set the declared value`], ...subsetDiff(extraKeys, existing, entryLabel)];
		if (!hasDrift(drift)) continue;
		const phantom = phantomKeys(extraKeys, existing);
		if (phantom.length > 0) planned.notes.push(phantomNote(entryLabel, phantom, "variable", "this update will re-run"));
		planned.ops.push({
			role: "updateVariable",
			params: {
				...params,
				name: existing.name
			},
			payload: plainData({
				value: variable.value,
				...extraKeys
			}),
			drift,
			change: `updated variable "${variable.name}" in environment "${envName}"`,
			describe: `updating variable "${variable.name}" in environment "${envName}"`
		});
	}
	for (const variable of liveByKey.values()) {
		if (declaredKeys.has(variableKey(variable.name))) continue;
		if (policy === "keep") {
			planned.notes.push(undeclaredNote({
				subject: `variable "${variable.name}"`,
				state: `exists on environment "${envName}" but is not declared`,
				action: "DELETE it"
			}));
			continue;
		}
		planned.ops.push({
			role: "removeVariable",
			params: {
				...params,
				name: variable.name
			},
			drift: [undeclaredDrift(NESTED_PLANNERS.variables.defaultPolicy, {
				label: `${label}[${variable.name}]`,
				action: "DELETE it"
			})],
			change: `DELETED undeclared variable "${variable.name}" from environment "${envName}"`,
			describe: `deleting undeclared variable "${variable.name}" from environment "${envName}"`
		});
	}
	return planned;
}
/** Two spellings of one case-insensitive name (GitHub stores secret names uppercase) would fight each other on every run. */
function rejectDuplicateSecrets(envName, entries) {
	const seen = /* @__PURE__ */ new Map();
	const collisions = [];
	for (const secret of entries) {
		const key = secretKey(secret.name);
		const first = seen.get(key);
		if (first !== void 0) {
			collisions.push(`"${first}" and "${secret.name}"`);
			continue;
		}
		seen.set(key, secret.name);
	}
	if (collisions.length > 0) throw new Error(`environments: the "${envName}" entry declares secrets that GitHub treats as the same secret (names are case-insensitive): ${collisions.join("; ")}. Keep exactly one entry per secret`);
}
/**
* Existence is the only comparable state (values never read back), so every declared secret is a
* sealed PUT. The sealing key is read inside the first payload thunk: in apply the environment PUT
* may only just have created the environment the key belongs to.
*/
async function planEnvironmentSecrets(ctx, section, envName, policy, entries, liveEnv) {
	const params = { environment_name: envName };
	const label = `environments[${envName}].secrets`;
	const noun = `${envName} environment secret`;
	const suffix = ` in environment "${envName}"`;
	const live = liveEnv === void 0 ? [] : parseLive(section, ENDPOINTS$10.listSecrets, LIVE_SECRET_NAMES, await ctx.read.listSecrets.listAllEnveloped("secrets", { params }), `environment "${envName}"`);
	const liveByKey = new Map(live.map((item) => [secretKey(item.name), item.name]));
	const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));
	const planned = {
		ops: [],
		notes: []
	};
	let sealingKey;
	const readSealingKey = () => {
		sealingKey ??= ctx.read.secretsPublicKey.call({
			params,
			describe: `reading the ${label} sealing key`
		}).then((body) => parseSealingKey(section, { label }, ENDPOINTS$10.secretsPublicKey, body));
		return sealingKey;
	};
	for (const entry of entries) {
		const name = secretKey(entry.name);
		const exists = liveByKey.has(name);
		planned.ops.push({
			role: "putSecret",
			params: {
				...params,
				secret_name: name
			},
			payload: async (exec) => {
				const plaintext = exec.resolveSecret(entry.value);
				return (await readSealingKey()).seal(plaintext);
			},
			drift: exists ? [] : [`${label}[${name}]: missing - declared in the settings file but not on the environment; apply will create it`],
			change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`,
			describe: `writing secret "${name}"${suffix}`
		});
	}
	if (entries.length > 0 && liveEnv !== void 0) planned.notes.push(`${noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`);
	for (const [key, liveName] of liveByKey) {
		if (declaredKeys.has(key)) continue;
		if (policy === "keep") {
			planned.notes.push(undeclaredNote({
				subject: `${noun} "${liveName}"`,
				state: "exists on the environment but is not declared",
				action: "DELETE it (a deleted secret's value is unrecoverable)"
			}));
			continue;
		}
		planned.ops.push({
			role: "removeSecret",
			params: {
				...params,
				secret_name: liveName
			},
			drift: [undeclaredDrift(NESTED_PLANNERS.secrets.defaultPolicy, {
				label: `${label}[${liveName}]`,
				action: "DELETE it (the value is unrecoverable)"
			})],
			change: `DELETED undeclared secret "${liveName}"${suffix}`,
			describe: `deleting undeclared secret "${liveName}"${suffix}`
		});
	}
	return planned;
}
const GRAPHQL_OPS$1 = {
	pins: graphqlOp()({
		name: "EnvironmentPins",
		kind: "read",
		query: "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }",
		connection: { path: ["repository", "pinnedEnvironments"] },
		outcomes: {
			ok: "the pinned environments with their 1-based positions",
			NOT_FOUND: "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)"
		}
	}),
	pin: graphqlOp()({
		name: "PinEnvironment",
		kind: "write",
		query: "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }",
		outcomes: {
			ok: "the environment was pinned or unpinned",
			UNPROCESSABLE: `the repository already holds 10 pinned environments (GitHub's cap), so this pin was rejected; pins without a pinned declaration are left untouched, so declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI`
		}
	}),
	reorder: graphqlOp()({
		name: "ReorderEnvironment",
		kind: "write",
		query: "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }",
		outcomes: { ok: "the pinned environment moved to its declared position" }
	})
};
/**
* A pin without a numeric position and a name has no identity to reconcile by, and silently
* skipping it would let check report falsely clean while apply reordered blind.
*/
function livePin(node) {
	const pin = node;
	const position = pin?.position;
	const name = pin?.environment?.name;
	if (typeof position !== "number" || typeof name !== "string") throw new Error(`environments: the pinned-environments listing returned a pin node this section cannot read (${JSON.stringify(node) ?? String(node)}): it needs a numeric "position" and an "environment.name" string, so the declared pins cannot be reconciled. Check the "api-version" input against the GitHub GraphQL reference for pinnedEnvironments`);
	return {
		position,
		name
	};
}
/**
* A tolerated NOT_FOUND (how GraphQL delivers a fine-grained denial on the repository) reads as
* "no pins", the same absent posture as the REST probe, so the denial surfaces on the first pin
* write instead of failing the read pass.
*/
async function listLivePins(ctx) {
	const listed = await ctx.read.pins.listConnection(repoVariables(ctx));
	if ("error" in listed) return [];
	return listed.items.map(livePin).sort((a, b) => a.position - b.position);
}
/** Environment names are case-insensitive on GitHub. */
function pinKey(name) {
	return name.toLowerCase();
}
/**
* A PURE computation both modes share: check renders its drift lines from the plan and apply
* executes exactly its mutations, so the two cannot disagree. Ranks are compared, never the live
* position numbers (they may carry holes).
*
* pinned: true    -> leads the pinned list, in declaration order
* pinned: false   -> unpinned
* no declaration  -> never unpinned; moved after the declared block when it sits among the leading ranks
*/
function planPins(declarations, live) {
	const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
	const desiredKeys = new Set(desired.map(pinKey));
	const unpinKeys = new Set(declarations.filter((entry) => !entry.pinned).map((entry) => pinKey(entry.name)));
	const liveKeys = new Set(live.map((pin) => pinKey(pin.name)));
	const unpins = declarations.filter((entry) => !entry.pinned && liveKeys.has(pinKey(entry.name))).map((entry) => entry.name);
	const pins = desired.filter((name) => !liveKeys.has(pinKey(name)));
	const postUnpin = live.filter((pin) => !unpinKeys.has(pinKey(pin.name))).map((pin) => pinKey(pin.name));
	const order = [...postUnpin, ...pins.map(pinKey)];
	const interleaved = live.filter((pin) => !desiredKeys.has(pinKey(pin.name)) && !unpinKeys.has(pinKey(pin.name)) && postUnpin.indexOf(pinKey(pin.name)) < desired.length).map((pin) => pin.name);
	const reorders = [];
	desired.forEach((name, index) => {
		const key = pinKey(name);
		if (order[index] === key) return;
		reorders.push({
			name,
			rank: index + 1
		});
		order.splice(order.indexOf(key), 1);
		order.splice(index, 0, key);
	});
	return {
		unpins,
		pins,
		reorders,
		interleaved,
		finalCount: postUnpin.length + pins.length,
		liveOrder: live.map((pin) => pin.name)
	};
}
/**
* Resolved by the FIRST pin thunk, after every environment PUT: a body without node_id fails with
* zero pins half-applied, and a converged pin state never resolves one.
*/
function resolvePinIds(declarations, names) {
	const byKey = new Map(declarations.map((entry) => [pinKey(entry.name), entry]));
	return new Map(names.map((name) => {
		const declaration = byKey.get(pinKey(name));
		if (declaration === void 0) throw new Error(`BUG: environments: a pin mutation was planned for "${name}", which no entry declares a pin state for`);
		return [pinKey(name), declaration.nodeId()];
	}));
}
function environmentNodeId(name, body) {
	const nodeId = nodeIdField(body);
	if (typeof nodeId !== "string") throw new Error(`environments: the environment body for "${name}" carried no node_id, so its pin cannot be reconciled. Check the "api-version" input against the GitHub REST docs for the environments endpoint`);
	return nodeId;
}
function nodeIdField(body) {
	return body?.node_id;
}
/**
* Mutations in cap-safe order: unpins, then pins, then leftward reorders. An overflow is a note
* in both modes and fails the first pin thunk.
*/
async function planPinned(ctx, declarations) {
	const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
	const plan = planPins(declarations, await listLivePins(ctx));
	const ops = [];
	const notes = [];
	if (plan.interleaved.length > 0) notes.push(`pinned environment(s) ${plan.interleaved.map((name) => `"${name}"`).join(", ")} have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins`);
	const overflow = plan.finalCount > 10 ? `pinning the ${plan.pins.length} declared environment(s) not yet pinned would leave ${plan.finalCount} environments pinned, but GitHub allows at most 10. Pins without a pinned declaration are left untouched, so declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI` : void 0;
	if (overflow !== void 0) notes.push(`apply will fail: ${overflow}`);
	let ids;
	const idOf = (name) => {
		if (overflow !== void 0) throw new Error(`environments: ${overflow}`);
		ids ??= resolvePinIds(declarations, [
			...plan.unpins,
			...plan.pins,
			...plan.reorders.map((reorder) => reorder.name)
		]);
		const id = ids.get(pinKey(name));
		if (id === void 0) throw new Error(`BUG: environments: no node id was resolved for the pin mutation of "${name}"`);
		return id;
	};
	for (const name of plan.unpins) ops.push({
		role: "pin",
		variables: () => ({
			environmentId: idOf(name),
			pinned: false
		}),
		drift: [`environments[${name}].pinned: pinned on the repo but declared pinned: false; apply will unpin it`],
		change: `unpinned environment "${name}"`,
		describe: `unpinning environment "${name}"`
	});
	for (const name of plan.pins) ops.push({
		role: "pin",
		variables: () => ({
			environmentId: idOf(name),
			pinned: true
		}),
		drift: [`environments[${name}].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it`],
		change: `pinned environment "${name}"`,
		describe: `pinning environment "${name}"`
	});
	plan.reorders.forEach(({ name, rank }, index) => {
		ops.push({
			role: "reorder",
			variables: () => ({
				environmentId: idOf(name),
				position: rank
			}),
			drift: [index === 0 ? `environments.pinned: the declared pin order is [${desired.join(", ")}] but the live pinned order is [${plan.liveOrder.join(", ")}]; apply will reorder the pins so the declared ones lead in declaration order` : `environments.pinned: apply will also move "${name}" to position ${rank} in that reordering`],
			change: `moved pinned environment "${name}" to position ${rank}`,
			describe: `moving pinned environment "${name}" to position ${rank}`
		});
	});
	return {
		ops,
		notes
	};
}
const environmentsSection = {
	key: "environments",
	undeclaredDefault: "untouched",
	permission: { repo: ["environments"] },
	grantCaveat: "declared \"deployment_branch_policies\" and \"deployment_protection_rules\" keys additionally need \"Actions\" (read) and \"Administration\" (read and write)",
	endpoints: ENDPOINTS$10,
	graphql: GRAPHQL_OPS$1,
	shape: loosen(EnvironmentsConfig),
	/**
	* Labels carry the environment: sibling environments can declare same-named secrets.
	* A malformed container contributes nothing rather than throwing, so the actionable error
	* always comes from shape validation.
	*/
	secretValues(declared) {
		if (!Array.isArray(declared)) return [];
		return declared.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) return [];
			const env = entry;
			const where = typeof env.name === "string" ? `environment "${env.name}"` : "an unnamed environment";
			return listSecretValues(env.secrets).map(({ label, value }) => ({
				label: `${label} of ${where}`,
				value
			}));
		});
	},
	async plan(ctx, desired) {
		rejectDuplicates(this, desired, (env) => env.name.toLowerCase(), (env) => env.name);
		for (const env of desired) for (const key of NESTED_KEYS) validateNested(key, env);
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		/** Each entry's declared pin state, in file order (order IS the pin order). */
		const pins = [];
		for (const env of desired) {
			const { settings, nested, routed } = splitEntry(env);
			const name = env.name;
			const params = { environment_name: name };
			const probe = await ctx.read.probe.probeAbsent({ params });
			const live = "missing" in probe ? void 0 : probe.data ?? {};
			const drift = live === void 0 ? [`environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`] : subsetDiff(settings, flattenEnvironment(live), `environments[${name}]`);
			const probedNodeId = live === void 0 ? void 0 : { node_id: nodeIdField(live) };
			let createdNodeId;
			const nodeId = () => {
				if (probedNodeId !== void 0) return environmentNodeId(name, probedNodeId);
				if (createdNodeId === void 0) throw new Error(`BUG: environments: the pin of "${name}" ran before the PUT that creates the environment`);
				return createdNodeId;
			};
			if (hasDrift(drift)) plan.ops.push({
				role: "update",
				params,
				payload: plainData(settings),
				drift,
				change: `applied environment "${name}"`,
				describe: `upserting environment "${name}"`,
				capture: live === void 0 && routed.pinned !== void 0 ? (response) => {
					createdNodeId = environmentNodeId(name, response);
				} : void 0
			});
			if (routed.pinned !== void 0) pins.push({
				name,
				pinned: routed.pinned,
				nodeId
			});
			for (const key of NESTED_KEYS) {
				const planned = await planNested(ctx, this, key, name, nested, live);
				plan.ops.push(...planned.ops);
				plan.notes.push(...planned.notes);
			}
		}
		if (pins.length > 0) {
			const pinned = await planPinned(ctx, pins);
			plan.ops.push(...pinned.ops);
			plan.notes.push(...pinned.notes);
		}
		return plan;
	}
};
/**
* GET nests wait_timer / prevent_self_review / reviewers inside protection_rules[]; translated back
* to the PUT shape so check compares like with like. Exported so the e2e state tests can assert
* their environmentFromPut inverts this exact function.
*/
function flattenEnvironment(live) {
	const raw = live ?? {};
	const out = { ...raw };
	const rules = raw.protection_rules ?? [];
	for (const rule of rules) if (rule.type === "wait_timer") out.wait_timer = rule.wait_timer;
	else if (rule.type === "required_reviewers") {
		if (rule.prevent_self_review !== void 0) out.prevent_self_review = rule.prevent_self_review;
		out.reviewers = (rule.reviewers ?? []).map((r) => ({
			type: r.type,
			id: r.reviewer?.id
		}));
	} else for (const [key, value] of Object.entries(rule)) if (![
		"id",
		"node_id",
		"type",
		"url"
	].includes(key)) out[key] = value;
	return out;
}
//#endregion
//#region src/sections/interaction_limits/index.ts
/**
* `interaction_limits:` section. The base limit self-expires and GitHub reads back only the computed
* expires_at, never the duration, so a declared limit is re-armed on every apply.
*
* an organization- or user-level limit  -> overrides the repository's and answers 409 on writes, surfaced as a note
* interaction_limits: null              -> clears the base limit only
* pull_request_creation_cap             -> its own sub-endpoint; persistent state, PATCHed only on divergence; 405 where unavailable
* pull_request_creation_bypass          -> its own sub-endpoint; the live login list is reconciled, removals before adds (100-user cap)
*/
const permission$8 = { repo: ["administration"] };
const ORG_OVERRIDE = "an organization- or user-level interaction limit overrides this repository's";
const CAP_UNAVAILABLE = "the pull request creation cap is not available on this repository";
const BYPASS_DENIAL = "a 403 or 404 here can also mean the pull request creation cap is not available on this repository";
const ENDPOINTS$9 = {
	get: {
		route: "GET /repos/{owner}/{repo}/interaction-limits",
		statuses: { 200: "the active interaction limit, or an empty object when none is set" },
		primaryRead: { notFound: "denied" }
	},
	put: {
		route: "PUT /repos/{owner}/{repo}/interaction-limits",
		statuses: {
			200: "interaction limit set",
			409: ORG_OVERRIDE
		},
		hints: { 422: "the declared limit or expiry is not a value GitHub accepts; see the repository interactions documentation" },
		alwaysRewrite: true
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/interaction-limits",
		statuses: {
			204: "interaction limit cleared",
			409: ORG_OVERRIDE
		}
	},
	capGet: {
		route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
		statuses: {
			200: "the pull request creation cap",
			405: CAP_UNAVAILABLE
		},
		accessGrade: "write"
	},
	capPatch: {
		route: "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
		statuses: {
			200: "pull request creation cap updated",
			405: CAP_UNAVAILABLE
		},
		hints: { 422: "enabled must be a boolean and max_open_pull_requests a whole number from 1 to 1000; see the pull request creation cap endpoint documentation" }
	},
	bypassList: {
		route: "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
		statuses: { 200: "the pull request creation cap bypass list" },
		denialHint: BYPASS_DENIAL,
		accessGrade: "write"
	},
	bypassAdd: {
		route: "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
		statuses: { 204: "users added to the bypass list" },
		denialHint: BYPASS_DENIAL,
		hints: { 422: "every users entry must be an existing GitHub login, and the bypass list holds at most 100 users; see the bypass-list endpoint documentation" }
	},
	bypassRemove: {
		route: "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
		statuses: { 204: "users removed from the bypass list" },
		denialHint: BYPASS_DENIAL,
		hints: { 422: "every users entry must be an existing GitHub login; see the bypass-list endpoint documentation" }
	}
};
/**
* An EMPTY plain object is GitHub's "no limit set"; anything else falls through to the limit parse,
* which fails loudly instead of reading a malformed body as absence.
*/
function noLiveLimit(live) {
	return typeof live === "object" && live !== null && !Array.isArray(live) && Object.keys(live).length === 0;
}
const LiveCreationCap = z.looseObject({
	enabled: z.boolean(),
	max_open_pull_requests: z.number()
});
const LiveInteractionLimit = z.looseObject({
	limit: z.string(),
	origin: z.string().optional()
});
async function liveBaseLimit(ctx, section) {
	const body = await ctx.read.get.call();
	if (noLiveLimit(body)) return { kind: "none" };
	const parsed = parseLive(section, ENDPOINTS$9.get, LiveInteractionLimit, body);
	return parsed.origin !== void 0 && parsed.origin.toLowerCase() !== "repository" ? {
		kind: "inherited",
		limit: parsed.limit,
		origin: parsed.origin,
		body: parsed
	} : {
		kind: "repository",
		limit: parsed.limit,
		body: parsed
	};
}
function splitDeclared(desired) {
	const base = Object.fromEntries(Object.entries(desired).filter(([key]) => !INTERACTION_LIMITS_ROUTED_KEYS.has(key)));
	const cap = desired.pull_request_creation_cap;
	const bypass = desired.pull_request_creation_bypass;
	if (Object.keys(base).length === 0) return {
		cap,
		bypass
	};
	const limit = base.limit;
	if (typeof limit !== "string") throw new Error(`BUG: interaction_limits base key(s) [${Object.keys(base).join(", ")}] reached plan() without a limit; the shape rejects this pairing during document validation`);
	return {
		base: {
			...base,
			limit
		},
		cap,
		bypass
	};
}
/**
* GitHub logins are case-insensitive. Removals go FIRST because the list holds at most 100 users,
* so adding before removing could transiently overflow it and 422.
*/
function bypassDelta(declared, liveLogins) {
	const declaredKeys = new Set(declared.map((login) => login.toLowerCase()));
	const liveKeys = new Set(liveLogins.map((login) => login.toLowerCase()));
	return {
		add: declared.filter((login) => !liveKeys.has(login.toLowerCase())),
		remove: liveLogins.filter((login) => !declaredKeys.has(login.toLowerCase()))
	};
}
/**
* A single GET, not listAll(): the endpoint documents no pagination parameters (the list holds at
* most 100 users), so a page loop on a full 100-user list would re-request the same body forever.
*/
async function liveBypassLogins(ctx, section) {
	return parseLive(section, ENDPOINTS$9.bypassList, z.array(z.looseObject({ login: z.string() })), await ctx.read.bypassList.call()).map((user) => user.login);
}
const interactionLimitsSection = {
	key: "interaction_limits",
	undeclaredDefault: "untouched",
	permission: permission$8,
	endpoints: ENDPOINTS$9,
	shape: requirePlainMapping(loosen(InteractionLimitsConfig)),
	async plan(ctx, desired) {
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		if (desired === null) {
			const live = await liveBaseLimit(ctx, this);
			if (live.kind === "none") return plan;
			plan.ops.push({
				role: "remove",
				describe: "clearing the interaction limit",
				drift: [live.kind === "inherited" ? `interaction_limits: declared null but a live "${live.limit}" limit is set at the ${live.origin} level; apply cannot remove it from the repository` : `interaction_limits: declared null but a live "${live.limit}" limit is set; apply will remove it`],
				tolerate: {
					statuses: [409],
					outcome: (error) => ({ note: `interaction_limits: ${ORG_OVERRIDE}, so the repository-level clear was not applied (${error.status})` })
				},
				change: "cleared the interaction limit"
			});
			return plan;
		}
		const { base, cap, bypass } = splitDeclared(desired);
		if (base !== void 0) {
			const live = await liveBaseLimit(ctx, this);
			const drift = [];
			if (live.kind === "none") drift.push(`interaction_limits: no live limit (never set, or it expired); apply will (re-)arm the declared "${base.limit}" limit`);
			else {
				const { expiry: _expiry, ...comparable } = base;
				drift.push(...subsetDiff(comparable, live.body, "interaction_limits"));
				if (live.kind === "inherited") plan.notes.push(`interaction_limits: ${ORG_OVERRIDE} (origin: ${live.origin}); apply cannot change it from the repository`);
			}
			if (desired.expiry !== void 0) plan.notes.push(`interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be verified; apply re-arms it on every run`);
			plan.ops.push({
				role: "put",
				payload: plainData(base),
				describe: `arming the "${base.limit}" interaction limit`,
				drift,
				tolerate: {
					statuses: [409],
					outcome: (error) => ({ note: `interaction_limits: ${ORG_OVERRIDE}, so the repository-level limit was not applied (${error.status})` })
				},
				change: `armed the "${base.limit}" interaction limit (expiry: ${desired.expiry ?? "one_day (GitHub default)"})`
			});
		}
		if (cap !== void 0) {
			const outcome = await ctx.read.capGet.tryCall({ describe: "reading the pull request creation cap" });
			if ("error" in outcome) plan.drift.push(`interaction_limits.pull_request_creation_cap: declared but ${CAP_UNAVAILABLE} (405); apply cannot set it`);
			else {
				const phantom = phantomKeys(cap, outcome.data);
				if (phantom.length > 0) plan.notes.push(phantomNote("interaction_limits.pull_request_creation_cap", phantom, "creation cap", "this PATCH will re-run"));
				const drift = subsetDiff(cap, outcome.data, "interaction_limits.pull_request_creation_cap");
				if (hasDrift(drift)) plan.ops.push({
					role: "capPatch",
					payload: plainData(cap),
					describe: "setting the pull request creation cap",
					drift,
					tolerate: {
						statuses: [405],
						outcome: (error) => ({ note: `interaction_limits.pull_request_creation_cap: ${CAP_UNAVAILABLE}, so the declared cap was not applied (${error.status})` })
					},
					change: `set the pull request creation cap (enabled: ${cap.enabled}${cap.max_open_pull_requests !== void 0 ? `, max_open_pull_requests: ${cap.max_open_pull_requests}` : ""})`
				});
			}
		}
		if (bypass !== void 0) {
			const { add, remove } = bypassDelta(bypass, await liveBypassLogins(ctx, this));
			if (remove.length > 0) plan.ops.push({
				role: "bypassRemove",
				payload: { users: remove },
				describe: "removing users from the pull request creation cap bypass list",
				drift: [`interaction_limits.pull_request_creation_bypass: live login(s) [${remove.join(", ")}] are not declared; apply will remove them`],
				change: `removed [${remove.join(", ")}] from the pull request creation cap bypass list`
			});
			if (add.length > 0) plan.ops.push({
				role: "bypassAdd",
				payload: { users: add },
				describe: "adding users to the pull request creation cap bypass list",
				drift: [`interaction_limits.pull_request_creation_bypass: declared login(s) [${add.join(", ")}] are not on the live bypass list; apply will add them`],
				change: `added [${add.join(", ")}] to the pull request creation cap bypass list`
			});
		}
		return plan;
	},
	/**
	* Only what the repository itself owns reads back; an inherited limit is the org's or user's
	* setting, and a disabled cap is GitHub's default.
	*
	*   limit inherited (org or user origin)   -> noted, not declared
	*   cap answers 405                        -> cap and bypass both omitted, noted
	*   cap disabled, or nobody on the bypass  -> omitted
	*/
	async snapshot(ctx) {
		const notes = [];
		const value = {};
		const live = await liveBaseLimit(ctx, this);
		if (live.kind === "repository") {
			value.limit = live.limit;
			notes.push("interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be read back; apply re-arms the limit with GitHub's default (one_day) unless you declare expiry");
		} else if (live.kind === "inherited") notes.push(`interaction_limits: the live "${live.limit}" limit is set at the ${live.origin} level, not on the repository, so it is not part of the repository's snapshot`);
		const cap = await ctx.read.capGet.tryCall({ describe: "reading the pull request creation cap" });
		if ("error" in cap) notes.push(`interaction_limits: ${CAP_UNAVAILABLE} (405), so pull_request_creation_cap and pull_request_creation_bypass are omitted`);
		else {
			const liveCap = parseLive(this, ENDPOINTS$9.capGet, LiveCreationCap, cap.data);
			if (liveCap.enabled) value.pull_request_creation_cap = projectOntoSchema(InteractionLimitsConfig.unwrap().shape.pull_request_creation_cap, liveCap);
			const bypass = await liveBypassLogins(ctx, this);
			if (bypass.length > 0) value.pull_request_creation_bypass = bypass;
		}
		if (Object.keys(value).length === 0) return {
			value: void 0,
			notes
		};
		return {
			value,
			notes
		};
	}
};
//#endregion
//#region src/sections/labels/index.ts
function nameKey(name) {
	return name.toLowerCase();
}
function normalizeColor(color) {
	return color.replace(/^#/, "").toLowerCase();
}
const labelsSection = listSection({
	key: "labels",
	permission: { repo: ["issues"] },
	undeclaredDefault: "delete",
	noun: "label",
	entry: LabelConfig,
	live: z.looseObject({
		name: z.string(),
		color: z.string(),
		description: z.string().nullable()
	}),
	endpoints: {
		list: {
			route: "GET /repos/{owner}/{repo}/labels",
			statuses: { 200: "the label list" },
			primaryRead: { notFound: "denied" }
		},
		create: {
			route: "POST /repos/{owner}/{repo}/labels",
			statuses: { 201: "label created" }
		},
		update: {
			route: "PATCH /repos/{owner}/{repo}/labels/{name}",
			statuses: { 200: "label updated" }
		},
		remove: {
			route: "DELETE /repos/{owner}/{repo}/labels/{name}",
			statuses: { 204: "label deleted" }
		}
	},
	identity: {
		field: "name",
		fold: nameKey,
		aliases: (label) => label.new_name === void 0 ? [] : [label.name],
		renameKey: "new_name"
	},
	address: (live) => ({ name: live.name }),
	lens: {
		toWrite: ({ name, new_name, color, description, ...passthrough }) => ({
			name: new_name ?? name,
			...color === void 0 ? {} : { color: normalizeColor(color) },
			...description === void 0 ? {} : { description },
			...passthrough
		}),
		fromLive: (live) => ({
			...live,
			color: normalizeColor(live.color),
			description: live.description ?? ""
		}),
		matchBy: {}
	},
	prose: { undeclaredAction: "DELETE it" },
	layering: { combine: "replace" }
});
//#endregion
//#region src/sections/milestones/index.ts
/**
* `milestones:` section: upsert by title. Undeclared milestones are kept by default, unlike Probot:
* deleting a milestone detaches it from every issue carrying it.
*/
const LiveMilestone = z.looseObject({
	number: z.number(),
	title: z.string()
});
const permission$7 = { repo: ["issues"] };
const ENDPOINTS$7 = {
	list: {
		route: "GET /repos/{owner}/{repo}/milestones",
		statuses: { 200: "the milestone list" },
		primaryRead: { notFound: "denied" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/milestones",
		statuses: { 201: "milestone created" }
	},
	update: {
		route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}",
		statuses: { 200: "milestone updated" }
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}",
		statuses: { 204: "milestone deleted" }
	}
};
/** Deleting a milestone detaches it from its issues; every undeclared-delete line says so. */
const DETACH_ACTION = "DELETE it, detaching it from every issue that carries it";
const milestonesSection = {
	key: "milestones",
	undeclaredDefault: "keep",
	permission: permission$7,
	endpoints: ENDPOINTS$7,
	shape: loosen(knobbed(MilestoneConfig)),
	async plan(ctx, declared) {
		const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
		rejectDuplicates(this, desired, (m) => m.title, (m) => m.title);
		const live = parseLive(this, ENDPOINTS$7.list, z.array(LiveMilestone), await ctx.read.list.listAll({ query: { state: "all" } }));
		const liveByTitle = new Map(live.map((m) => [m.title, m]));
		const declaredKeys = /* @__PURE__ */ new Set();
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		for (const milestone of desired) {
			declaredKeys.add(milestone.title);
			const label = `milestones[${milestone.title}]`;
			const existing = liveByTitle.get(milestone.title);
			const payload = plainData({ ...milestone });
			if (existing === void 0) {
				plan.ops.push({
					role: "create",
					payload,
					describe: `creating milestone "${milestone.title}"`,
					drift: [`${label}: missing - declared in the settings file but not on the repo; apply will create it`],
					change: `created milestone "${milestone.title}"`
				});
				continue;
			}
			const { title: _t, ...declaredFields } = milestone;
			const drift = deltas(declaredFields, existing, { matchBy: {} }).map((delta) => renderDelta(label, delta));
			if (!hasDrift(drift)) continue;
			const phantom = phantomKeys(declaredFields, existing);
			if (phantom.length > 0) plan.notes.push(phantomNote(label, phantom, "milestone", "this update will re-run"));
			plan.ops.push({
				role: "update",
				params: { milestone_number: String(existing.number) },
				payload,
				describe: `updating milestone "${milestone.title}"`,
				drift,
				change: `updated milestone "${milestone.title}"`
			});
		}
		for (const milestone of live) {
			if (declaredKeys.has(milestone.title)) continue;
			if (policy === "delete") {
				plan.ops.push({
					role: "remove",
					params: { milestone_number: String(milestone.number) },
					describe: `deleting undeclared milestone "${milestone.title}"`,
					drift: [undeclaredDrift(defaultUndeclaredPolicy(this), {
						label: `milestones[${milestone.title}]`,
						action: DETACH_ACTION
					})],
					change: `DELETED undeclared milestone "${milestone.title}" (detached from every issue that carried it)`
				});
				continue;
			}
			plan.notes.push(undeclaredNote({
				subject: `milestone "${milestone.title}"`,
				action: `${DETACH_ACTION} (closing is not enough; closed milestones are still listed)`
			}));
		}
		return plan;
	},
	async snapshot(ctx) {
		const live = parseLive(this, ENDPOINTS$7.list, z.array(LiveMilestone), await ctx.read.list.listAll({ query: { state: "all" } }));
		if (live.length === 0) return {
			value: void 0,
			notes: []
		};
		rejectLiveDuplicates(this, "milestone", live, (milestone) => milestone.title, (milestone) => `${milestone.title} (number ${milestone.number})`);
		const entries = live.map((milestone) => projectOntoSchema(MilestoneConfig, milestone));
		return {
			value: knobbedSnapshot(this, entries),
			notes: []
		};
	}
};
//#endregion
//#region src/sections/pages/index.ts
const permission$6 = { repo: ["pages"] };
const ENDPOINTS$6 = {
	get: {
		route: "GET /repos/{owner}/{repo}/pages",
		statuses: {
			200: "the Pages site",
			404: "Pages is not enabled on the repository"
		},
		primaryRead: { notFound: "absent" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/pages",
		statuses: { 201: "Pages enabled" }
	},
	update: {
		route: "PUT /repos/{owner}/{repo}/pages",
		statuses: { 204: "Pages configuration updated" }
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/pages",
		statuses: { 204: "Pages disabled" }
	}
};
/** The update PUT requires path alongside branch and the create POST defaults it, so it is defaulted everywhere. */
function wireSource(source) {
	return {
		...source,
		path: source.path ?? "/"
	};
}
const pagesSection = {
	key: "pages",
	undeclaredDefault: "untouched",
	permission: permission$6,
	endpoints: ENDPOINTS$6,
	shape: loosen(PagesConfig),
	async plan(ctx, desired) {
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		const probe = await ctx.read.get.probeAbsent();
		if (desired === null) {
			if ("missing" in probe) {
				plan.notes.push("pages: declared null and GitHub reports no Pages site, so there is nothing to disable. A fine-grained token missing the Pages permission gets the same answer; if this repo does have a Pages site, grant the token Pages read and write");
				return plan;
			}
			plan.ops.push({
				role: "remove",
				drift: ["pages: enabled live but the settings file declares pages: null; apply will disable GitHub Pages"],
				change: "disabled GitHub Pages"
			});
			return plan;
		}
		if (Object.keys(desired).length === 0) {
			plan.notes.push("pages: declared as an empty mapping, which configures nothing (the update endpoint rejects an empty body). Declare at least one field, use pages: null to disable the site, or remove the section");
			return plan;
		}
		const { source, ...restConfig } = desired;
		const payload = source === void 0 ? restConfig : {
			...restConfig,
			source: wireSource(source)
		};
		if (!("missing" in probe)) {
			const drift = subsetDiff(payload, probe.data, "pages");
			if (hasDrift(drift)) plan.ops.push({
				role: "update",
				payload: plainData(payload),
				drift,
				change: "updated GitHub Pages configuration"
			});
			return plan;
		}
		const create = {};
		if (payload.build_type !== void 0) create.build_type = payload.build_type;
		if (payload.source !== void 0) create.source = payload.source;
		plan.ops.push({
			role: "create",
			payload: plainData(create),
			drift: ["pages: declared in the settings file but GitHub Pages is not enabled on the repo; apply will enable it"],
			change: "enabled GitHub Pages"
		});
		const rest = Object.keys(payload).filter((k) => !Object.hasOwn(create, k));
		if (rest.length > 0) plan.ops.push({
			role: "update",
			payload: plainData(payload),
			drift: [`pages: the create call takes only build_type and source, so apply will then set the remaining configuration (${rest.join(", ")})`],
			change: "applied remaining Pages configuration"
		});
		return plan;
	},
	async snapshot(ctx) {
		const probe = await ctx.read.get.probeAbsent();
		if ("missing" in probe) return {
			value: void 0,
			notes: []
		};
		const site = parseLive(this, ENDPOINTS$6.get, z.looseObject({}), probe.data);
		return {
			value: projectOntoSchema(PagesConfig, site),
			notes: []
		};
	}
};
//#endregion
//#region src/sections/repository/index.ts
function normalizeTopics(raw) {
	const values = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",").map((t) => t.trim());
	return [...new Set(values.map((t) => t.toLowerCase()).filter(Boolean))];
}
const permission$5 = { repo: ["administration"] };
const LFS_DENIAL_HINT = "a 403 here can also mean Git LFS is disabled account-wide or for the root of this repository network, or that the credential lacks billing access (organization repositories need an organization owner or billing manager), rather than a missing token grant";
const OWNER_ENFORCED = "the repository owner enforces immutable releases";
const ENDPOINTS$5 = {
	get: {
		route: "GET /repos/{owner}/{repo}",
		statuses: { 200: "the repository" },
		primaryRead: { notFound: "denied" }
	},
	update: {
		route: "PATCH /repos/{owner}/{repo}",
		statuses: { 200: "repository fields patched" }
	},
	topics: {
		route: "PUT /repos/{owner}/{repo}/topics",
		statuses: { 200: "topics replaced" }
	},
	vulnerabilityAlertsGet: {
		route: "GET /repos/{owner}/{repo}/vulnerability-alerts",
		statuses: {
			204: "vulnerability alerts are enabled",
			404: "vulnerability alerts are disabled"
		}
	},
	vulnerabilityAlertsPut: {
		route: "PUT /repos/{owner}/{repo}/vulnerability-alerts",
		statuses: { 204: "vulnerability alerts enabled" }
	},
	vulnerabilityAlertsRemove: {
		route: "DELETE /repos/{owner}/{repo}/vulnerability-alerts",
		statuses: { 204: "vulnerability alerts disabled" }
	},
	automatedSecurityFixesGet: {
		route: "GET /repos/{owner}/{repo}/automated-security-fixes",
		statuses: {
			200: "the automated security fixes state",
			404: "the feature is not enabled"
		}
	},
	automatedSecurityFixesPut: {
		route: "PUT /repos/{owner}/{repo}/automated-security-fixes",
		statuses: { 204: "automated security fixes enabled" }
	},
	automatedSecurityFixesRemove: {
		route: "DELETE /repos/{owner}/{repo}/automated-security-fixes",
		statuses: { 204: "automated security fixes disabled" }
	},
	privateVulnerabilityReportingGet: {
		route: "GET /repos/{owner}/{repo}/private-vulnerability-reporting",
		statuses: {
			200: "the private vulnerability reporting state readable from the body",
			404: "the feature is not applicable on this repository (observed: private repos); read as not enabled",
			422: "the same condition as 404, alternate answer"
		}
	},
	privateVulnerabilityReportingPut: {
		route: "PUT /repos/{owner}/{repo}/private-vulnerability-reporting",
		statuses: { 204: "private vulnerability reporting enabled" }
	},
	privateVulnerabilityReportingRemove: {
		route: "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting",
		statuses: {
			204: "private vulnerability reporting disabled",
			404: "the feature is not applicable, so it is already off",
			422: "the feature is not applicable, so it is already off"
		}
	},
	immutableReleasesGet: {
		route: "GET /repos/{owner}/{repo}/immutable-releases",
		statuses: {
			200: "the immutable releases state readable from the body",
			404: "immutable releases are not enabled"
		}
	},
	immutableReleasesPut: {
		route: "PUT /repos/{owner}/{repo}/immutable-releases",
		statuses: {
			204: "immutable releases enabled",
			409: OWNER_ENFORCED
		}
	},
	immutableReleasesRemove: {
		route: "DELETE /repos/{owner}/{repo}/immutable-releases",
		statuses: {
			204: "immutable releases disabled",
			409: OWNER_ENFORCED
		}
	},
	lfsPut: {
		route: "PUT /repos/{owner}/{repo}/lfs",
		statuses: { 202: "Git LFS enabled (GitHub processes the change asynchronously)" },
		denialHint: LFS_DENIAL_HINT,
		alwaysRewrite: true
	},
	lfsRemove: {
		route: "DELETE /repos/{owner}/{repo}/lfs",
		statuses: { 204: "Git LFS disabled" },
		denialHint: LFS_DENIAL_HINT,
		alwaysRewrite: true
	}
};
const LiveRepository = z.looseObject({ topics: z.array(z.string()).nullish() });
const FEATURES_QUERY = graphqlOp()({
	name: "RepositoryFeatures",
	kind: "read",
	query: "query RepositoryFeatures($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id hasSponsorshipsEnabled issueCreationPolicy } }",
	outcomes: { ok: "the sponsor-button and issue-creation-policy state, plus the node id the mutation addresses" }
});
const ISSUE_CREATION_POLICIES = {
	all: "ALL",
	collaborators_only: "COLLABORATORS_ONLY"
};
const UPDATE_FEATURES = graphqlOp()({
	name: "UpdateRepositoryFeatures",
	kind: "write",
	query: `mutation UpdateRepositoryFeatures(
    $repositoryId: ID!
    $hasSponsorshipsEnabled: Boolean
    $issueCreationPolicy: IssueCreationPolicy
  ) {
    updateRepository(
      input: {
        repositoryId: $repositoryId
        hasSponsorshipsEnabled: $hasSponsorshipsEnabled
        issueCreationPolicy: $issueCreationPolicy
      }
    ) {
      repository { hasSponsorshipsEnabled issueCreationPolicy }
    }
  }`,
	outcomes: { ok: "the carried values set; the echoed state verifies each one took" }
});
const GRAPHQL_OPS = {
	featuresQuery: FEATURES_QUERY,
	updateFeatures: UPDATE_FEATURES
};
const LiveNoContent = z.null();
const LiveToggleState = z.looseObject({
	enabled: z.boolean(),
	enforced_by_owner: z.boolean().optional()
});
const READABLE_TOGGLES = [
	{
		key: "enable_vulnerability_alerts",
		label: "vulnerability alerts",
		get: "vulnerabilityAlertsGet",
		put: "vulnerabilityAlertsPut",
		remove: "vulnerabilityAlertsRemove",
		live: LiveNoContent,
		isEnabled: () => true
	},
	{
		key: "enable_automated_security_fixes",
		label: "automated security fixes",
		get: "automatedSecurityFixesGet",
		put: "automatedSecurityFixesPut",
		remove: "automatedSecurityFixesRemove",
		live: LiveToggleState,
		isEnabled: (live) => live?.enabled === true
	},
	{
		key: "enable_private_vulnerability_reporting",
		label: "private vulnerability reporting",
		get: "privateVulnerabilityReportingGet",
		put: "privateVulnerabilityReportingPut",
		remove: "privateVulnerabilityReportingRemove",
		live: LiveToggleState,
		isEnabled: (live) => live?.enabled === true
	},
	{
		key: "enable_immutable_releases",
		label: "immutable releases",
		get: "immutableReleasesGet",
		put: "immutableReleasesPut",
		remove: "immutableReleasesRemove",
		live: LiveToggleState,
		isEnabled: (live) => live?.enabled === true,
		isEnforced: (live) => live?.enforced_by_owner === true
	}
];
const WRITE_ONLY_TOGGLES = [{
	key: "enable_git_lfs",
	label: "Git LFS",
	put: "lfsPut",
	remove: "lfsRemove"
}];
const GRAPHQL_ROUTED_KEYS = [{
	key: "enable_sponsorships",
	label: "sponsor button",
	field: "hasSponsorshipsEnabled",
	variables: (declared) => ({ hasSponsorshipsEnabled: declared }),
	decode: (live) => typeof live === "boolean" ? live : void 0,
	show: (value) => String(value),
	changeText: (value) => value ? "enabled" : "disabled"
}, {
	key: "issue_creation_policy",
	label: "issue creation policy",
	field: "issueCreationPolicy",
	variables: (declared) => ({ issueCreationPolicy: ISSUE_CREATION_POLICIES[declared] }),
	decode: (live) => live === "ALL" ? "all" : live === "COLLABORATORS_ONLY" ? "collaborators_only" : void 0,
	show: (value) => String(value),
	changeText: (value) => String(value),
	unreadableHint: "a null policy means GitHub reported no issue creation policy for this repository; otherwise the field vocabulary may have changed"
}];
/**
* Strictness is scoped to the DECLARED keys: an unreadable value (the SDL-nullable policy, a future
* enum member) must fail loudly for a key the file declares and must not fail a run that never declared it.
*/
function decodeRoutedFields(fields, routed, opName) {
	const values = {};
	for (const entry of routed) {
		const decoded = entry.decode(fields[entry.field]);
		if (decoded === void 0) {
			const hint = entry.unreadableHint ? `; ${entry.unreadableHint}` : "";
			throw new Error(`repository: GRAPHQL ${opName} returned ${entry.field} ${JSON.stringify(fields[entry.field])}, which this section cannot read as a repository.${entry.key} value${hint}. Drop the key, or update the action if GitHub's vocabulary moved`);
		}
		values[entry.key] = decoded;
	}
	return values;
}
async function fetchRoutedState(ctx, routed) {
	const repository = (await ctx.read.featuresQuery.call(repoVariables(ctx))).repository;
	if (!repository || typeof repository.id !== "string") throw new Error(`repository: GRAPHQL ${FEATURES_QUERY.name} returned no repository object with an id, so the ${GRAPHQL_ROUTED_KEYS.map((entry) => entry.key).join("/")} state cannot be read. Check the token's repository access`);
	return {
		id: repository.id,
		values: decodeRoutedFields(repository, routed, FEATURES_QUERY.name)
	};
}
/** Exported for the table-driven test that pins each toggle to its own PUT/DELETE pair, never the base PATCH. */
const FEATURE_TOGGLES = [...READABLE_TOGGLES, ...WRITE_ONLY_TOGGLES];
/** Exported for the docs examples test (test/docs/settings-examples.ts). */
const SPECIAL_KEYS = /* @__PURE__ */ new Set([
	"topics",
	...FEATURE_TOGGLES.map((toggle) => toggle.key),
	...GRAPHQL_ROUTED_KEYS.map((routed) => routed.key)
]);
/** A 409 means owner enforcement; any other tolerated status means the feature does not apply here and was already off. */
function toggleTolerated(section, toggle, role, status) {
	const meaning = section.endpoints[role]?.statuses[status];
	return status === 409 ? `repository.${toggle.key}: ${meaning}, so apply cannot change it from the repository (${status})` : `repository.${toggle.key}: ${meaning}, so nothing changed (${status})`;
}
const repositorySection = {
	key: "repository",
	undeclaredDefault: "untouched",
	permission: permission$5,
	endpoints: ENDPOINTS$5,
	graphql: GRAPHQL_OPS,
	shape: requirePlainMapping(loosen(RepositoryConfig)),
	async plan(ctx, declared) {
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		const desired = declared;
		const patch = {};
		for (const [key, value] of Object.entries(desired)) if (!SPECIAL_KEYS.has(key)) patch[key] = value;
		const live = parseLive(this, ENDPOINTS$5.get, LiveRepository, await ctx.read.get.call());
		if (Object.keys(patch).length > 0) {
			const phantom = phantomKeys(patch, live);
			if (phantom.length > 0) plan.notes.push(phantomNote("repository", phantom, "repository", "this PATCH will re-run"));
			const drift = subsetDiff(patch, live, "repository");
			if (hasDrift(drift)) plan.ops.push({
				role: "update",
				payload: plainData(patch),
				drift,
				change: `patched repository fields: ${Object.keys(patch).join(", ")}`
			});
		}
		if ("topics" in desired) {
			const names = normalizeTopics(desired.topics);
			const drift = subsetDiff([...names].sort(), [...live.topics ?? []].sort(), "repository.topics");
			if (hasDrift(drift)) plan.ops.push({
				role: "topics",
				payload: { names },
				drift,
				change: `set topics: ${names.join(", ") || "(none)"}`
			});
		}
		for (const toggle of READABLE_TOGGLES) {
			if (!(toggle.key in desired)) continue;
			const want = desired[toggle.key] === true;
			const probe = await ctx.read[toggle.get].probeAbsent();
			const live = "missing" in probe ? void 0 : parseLive(this, ENDPOINTS$5[toggle.get], toggle.live, probe.data);
			const enabled = live === void 0 ? false : toggle.isEnabled(live);
			if (enabled === want) continue;
			const enforced = live !== void 0 && toggle.isEnforced?.(live) === true;
			const role = want ? toggle.put : toggle.remove;
			plan.ops.push({
				role,
				drift: [enforced ? `repository.${toggle.key}: declared ${want} != live ${enabled}; the repository owner enforces ${toggle.label}, so apply cannot change it from the repository` : `repository.${toggle.key}: declared ${want} != live ${enabled}; apply will set the declared value`],
				tolerate: { outcome: (error) => ({ note: toggleTolerated(this, toggle, role, error.status) }) },
				change: `${toggle.label}: ${want ? "enabled" : "disabled"}`
			});
		}
		for (const toggle of WRITE_ONLY_TOGGLES) {
			if (!(toggle.key in desired)) continue;
			const want = desired[toggle.key] === true;
			plan.notes.push(`repository.${toggle.key}: GitHub exposes no endpoint to read this state back, so check mode cannot verify it; apply re-asserts the declared value (${JSON.stringify(desired[toggle.key])}) on every run`);
			plan.ops.push({
				role: want ? toggle.put : toggle.remove,
				drift: [],
				change: `${toggle.label}: ${want ? "enabled" : "disabled"}`
			});
		}
		const declaredRouted = GRAPHQL_ROUTED_KEYS.filter((routed) => routed.key in desired);
		if (declaredRouted.length > 0) {
			const liveRouted = await fetchRoutedState(ctx, declaredRouted);
			const diverged = declaredRouted.filter((routed) => desired[routed.key] !== liveRouted.values[routed.key]);
			const [first, ...rest] = diverged;
			if (first !== void 0) {
				const variables = Object.assign({ repositoryId: liveRouted.id }, ...diverged.map((routed) => routed.variables(desired[routed.key])));
				plan.ops.push({
					role: "updateFeatures",
					variables,
					drift: diverged.map((routed) => `repository.${routed.key}: declared ${routed.show(desired[routed.key])} != live ${routed.show(liveRouted.values[routed.key])}; apply will set the declared value`),
					change: (response) => {
						const echoedRepo = response.updateRepository?.repository;
						if (!echoedRepo) throw new Error(`repository: GRAPHQL ${UPDATE_FEATURES.name} returned no repository echo, so the write cannot be verified. GitHub may have changed the mutation payload; update the action`);
						const echoed = decodeRoutedFields(echoedRepo, diverged, UPDATE_FEATURES.name);
						const verified = (routed) => {
							if (echoed[routed.key] !== desired[routed.key]) throw new Error(`repository: GRAPHQL ${UPDATE_FEATURES.name} was accepted, but GitHub reports repository.${routed.key} ${routed.show(echoed[routed.key])} where ${routed.show(desired[routed.key])} was set, so the write did not take. GitHub may restrict this setting on the repository`);
							return `${routed.label}: ${routed.changeText(echoed[routed.key])}`;
						};
						return [verified(first), ...rest.map(verified)];
					}
				});
			}
		}
		return plan;
	}
};
//#endregion
//#region src/sections/rulesets/index.ts
/** `rulesets:` section: upsert by name with a full-payload PUT, because a partial PUT silently narrows a ruleset. */
/**
* The file may use short names ("staging", "templates/*") where the API wants full refs; native
* tokens (~DEFAULT_BRANCH, ~ALL) and already-qualified refs pass through untouched.
*/
function normalizeRefName(value, target) {
	if (value.startsWith("~") || value.startsWith("refs/")) return value;
	if (target === "tag") return `refs/tags/${value}`;
	if (target === "branch") return `refs/heads/${value}`;
	return value;
}
function normalizeRuleset(ruleset) {
	const copy = structuredClone(ruleset);
	copy.target = copy.target ?? "branch";
	copy.enforcement = copy.enforcement ?? "active";
	const target = copy.target;
	const refName = copy.conditions?.ref_name;
	if (refName && target !== "push") {
		if (refName.include) refName.include = refName.include.map((v) => normalizeRefName(v, target));
		if (refName.exclude) refName.exclude = refName.exclude.map((v) => normalizeRefName(v, target));
	}
	return copy;
}
const LiveRulesetSummary = z.looseObject({
	id: z.number(),
	name: z.string(),
	source_type: z.string().optional()
});
const permission$4 = { repo: ["administration"] };
/**
* GitHub returns a ruleset's bypass_actors only to a token with write access to the ruleset
* (Administration at write); any other GET omits the KEY, never `[]`. Returns the input itself when
* nothing is hidden, so the caller can tell the two apart by identity.
*/
function observableRuleset(ruleset, live) {
	if (!(Object.hasOwn(ruleset, "bypass_actors") && typeof live === "object" && live !== null && !Object.hasOwn(live, "bypass_actors"))) return ruleset;
	const { bypass_actors: _hidden, ...visible } = ruleset;
	return visible;
}
const RULES_HINT = "Usually this means a rules[].type GitHub does not recognize, or \"parameters\" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)";
const ENDPOINTS$4 = {
	list: {
		route: "GET /repos/{owner}/{repo}/rulesets",
		statuses: { 200: "the repository ruleset list" },
		primaryRead: { notFound: "denied" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/rulesets",
		statuses: { 201: "ruleset created" },
		hints: { 422: RULES_HINT }
	},
	get: {
		route: "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
		statuses: { 200: "the ruleset" }
	},
	update: {
		route: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
		statuses: { 200: "ruleset updated" },
		hints: { 422: RULES_HINT }
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}",
		statuses: { 204: "ruleset deleted" }
	}
};
const rulesetsSection = {
	key: "rulesets",
	undeclaredDefault: "keep",
	permission: permission$4,
	endpoints: ENDPOINTS$4,
	shape: loosen(knobbed(RulesetConfig)),
	layering: {
		keys: (entry) => typeof entry.name === "string" ? [entry.name] : null,
		keyField: "name",
		combine: "merge",
		nested: { rules: {
			keys: (rule) => typeof rule.type === "string" ? [rule.type] : null,
			keyField: "type",
			combine: "replace"
		} }
	},
	async plan(ctx, declared) {
		const { policy, entries } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
		const desired = entries.map(normalizeRuleset);
		rejectDuplicates(this, desired, (r) => r.name, (r) => r.name);
		const repoRulesets = parseLive(this, ENDPOINTS$4.list, z.array(LiveRulesetSummary), await ctx.read.list.listAll()).filter((r) => (r.source_type ?? "Repository") === "Repository");
		const idByName = new Map(repoRulesets.map((r) => [r.name, r.id]));
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		for (const ruleset of desired) {
			const payload = plainData(ruleset);
			const id = idByName.get(ruleset.name);
			if (id === void 0) {
				plan.ops.push({
					role: "create",
					payload,
					describe: `creating ruleset "${ruleset.name}"`,
					drift: [`rulesets[${ruleset.name}]: missing - declared in the settings file but not on the repo; apply will create it`],
					change: `created ruleset "${ruleset.name}"`
				});
				continue;
			}
			const live = await ctx.read.get.call({ params: { ruleset_id: String(id) } });
			const compared = observableRuleset(ruleset, live);
			if (compared !== ruleset) plan.notes.push(`rulesets[${ruleset.name}]: bypass_actors is not visible to this token (GitHub returns it only to a token with write access to the ruleset), so drift on it cannot be judged here; grant Administration write to check it`);
			const drift = subsetDiff(compared, live, `rulesets[${ruleset.name}]`);
			if (!hasDrift(drift)) continue;
			const phantom = phantomKeys(compared, live);
			if (phantom.length > 0) plan.notes.push(phantomNote(`rulesets[${ruleset.name}]`, phantom, "ruleset", "this update will re-run"));
			plan.ops.push({
				role: "update",
				params: { ruleset_id: String(id) },
				payload,
				describe: `updating ruleset "${ruleset.name}"`,
				drift,
				change: `updated ruleset "${ruleset.name}" (id ${id})`
			});
		}
		const declaredNames = new Set(desired.map((r) => r.name));
		for (const live of repoRulesets) {
			if (declaredNames.has(live.name)) continue;
			if (policy === "delete") {
				if (live.source_type !== "Repository") {
					plan.notes.push(`ruleset "${live.name}" is undeclared, but the list response does not mark it source_type "Repository"; NOT deleting - only rulesets the API explicitly marks repository-owned are deleted; add it to the settings file to manage it, or delete it in GitHub if it should not exist`);
					continue;
				}
				plan.ops.push({
					role: "remove",
					params: { ruleset_id: String(live.id) },
					describe: `deleting undeclared ruleset "${live.name}"`,
					drift: [undeclaredDrift(defaultUndeclaredPolicy(this), {
						label: `rulesets[${live.name}]`,
						action: "DELETE it"
					})],
					change: `DELETED undeclared ruleset "${live.name}"`
				});
				continue;
			}
			plan.notes.push(undeclaredNote({
				subject: `ruleset "${live.name}"`,
				action: "DELETE it"
			}));
		}
		return plan;
	}
};
//#endregion
//#region src/sections/secret_scanning_custom_patterns/index.ts
/**
* The pattern name is immutable upstream (the PATCH takes no name field), so a renamed entry is a
* create under the new name while the old pattern follows the undeclared policy.
*
* undeclared pattern  -> KEPT by default: removing a pattern disposes of its alerts
* every DELETE        -> post_delete_action "resolve_alerts", never delete_alerts: a settings change must not destroy alert history
* PATCH and DELETE    -> carry custom_pattern_version when GitHub supplies one; a pattern edited between read and write answers 412
*/
const permission$3 = { repo: ["secret_scanning_alerts"] };
/** The known entry keys the update PATCH accepts: everything but the immutable name. */
const UPDATABLE_KEYS = [
	"pattern",
	"start_delimiter",
	"end_delimiter",
	"must_match",
	"must_not_match"
];
const NOT_ENABLED_HINT = "a 404 can also mean secret scanning is not enabled for the repository (it requires GitHub Advanced Security on private repositories)";
/** Exported so the troubleshooting guide's verbatim quote is test-pinned. */
const STALE_VERSION_HINT = "the pattern changed on GitHub between this run's read and its write (stale custom_pattern_version); re-run the workflow";
const ENDPOINTS$3 = {
	list: {
		route: "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns",
		statuses: { 200: "the custom-pattern list" },
		denialHint: NOT_ENABLED_HINT,
		primaryRead: { notFound: "denied" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns",
		statuses: { 201: "patterns created" },
		hints: { 422: "GitHub rejected a declared pattern - usually an invalid regular expression in one of its fields; the response names the rejected pattern" },
		denialHint: NOT_ENABLED_HINT
	},
	update: {
		route: "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}",
		statuses: { 200: "pattern updated" },
		hints: { 412: STALE_VERSION_HINT },
		denialHint: NOT_ENABLED_HINT
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns",
		statuses: { 204: "patterns deleted" },
		hints: { 412: STALE_VERSION_HINT },
		denialHint: NOT_ENABLED_HINT
	}
};
const LivePatternEntry = z.looseObject({
	id: z.number(),
	name: z.string(),
	custom_pattern_version: z.string().nullish()
});
function liveFrom(entry) {
	const fields = {};
	for (const key of UPDATABLE_KEYS) if (entry[key] !== void 0) fields[key] = entry[key];
	return {
		id: entry.id,
		name: entry.name,
		version: typeof entry.custom_pattern_version === "string" ? entry.custom_pattern_version : void 0,
		fields
	};
}
function declaredFields(declared) {
	return Object.fromEntries(UPDATABLE_KEYS.flatMap((key) => {
		const value = declared[key];
		return value === void 0 ? [] : [[key, value]];
	}));
}
function createBody(declared) {
	return {
		name: declared.name,
		pattern: declared.pattern,
		...declaredFields(declared)
	};
}
function deleteBody(pattern) {
	return pattern.version === void 0 ? { pattern_id: pattern.id } : {
		pattern_id: pattern.id,
		custom_pattern_version: pattern.version
	};
}
/** The GET marks the lists nullable, so a live null/absent LIST equals a declared [], or [] would PATCH on every run. */
function matches(declaredValue, liveValue) {
	return JSON.stringify(Array.isArray(declaredValue) && (liveValue === void 0 || liveValue === null) ? [] : liveValue) === JSON.stringify(declaredValue);
}
const key = "secret_scanning_custom_patterns";
const secretScanningPatternsSection = {
	key,
	undeclaredDefault: "keep",
	permission: permission$3,
	endpoints: ENDPOINTS$3,
	shape: loosen(knobbed(SecretScanningPatternConfig)),
	closedSurface: {
		known: {
			name: true,
			pattern: true,
			start_delimiter: true,
			end_delimiter: true,
			must_match: true,
			must_not_match: true
		},
		describe: (p) => p.name,
		consequence: "the pattern endpoints accept no other field - in particular \"state\" and \"push_protection_enabled\" are read-only through this API surface - so the key would be dropped silently and never converge"
	},
	async plan(ctx, declared) {
		const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
		rejectDuplicates(this, desired, (p) => p.name, (p) => p.name);
		const live = parseLive(this, ENDPOINTS$3.list, z.array(LivePatternEntry), await ctx.read.list.listAll()).map(liveFrom);
		const liveByName = new Map(live.map((p) => [p.name, p]));
		const declaredNames = new Set(desired.map((p) => p.name));
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		const toCreate = [];
		const updates = [];
		for (const entry of desired) {
			const existing = liveByName.get(entry.name);
			if (existing === void 0) {
				toCreate.push(entry);
				continue;
			}
			const divergent = Object.entries(declaredFields(entry)).filter(([field, value]) => !matches(value, existing.fields[field]));
			const drift = divergent.map(([field, value]) => {
				const liveValue = existing.fields[field];
				const liveRendered = liveValue === void 0 ? "(absent)" : JSON.stringify(liveValue);
				return `${key}[${entry.name}].${field}: declared ${JSON.stringify(value)} != live ${liveRendered}; apply will set the declared value`;
			});
			if (!hasDrift(drift)) continue;
			updates.push({
				role: "update",
				params: { pattern_id: String(existing.id) },
				payload: {
					custom_pattern_version: existing.version ?? null,
					...Object.fromEntries(divergent)
				},
				describe: `updating secret scanning pattern "${existing.name}"`,
				drift,
				change: `updated secret scanning custom pattern "${existing.name}"`
			});
		}
		const toDelete = [];
		for (const pattern of live) {
			if (declaredNames.has(pattern.name)) continue;
			if (policy === "keep") {
				plan.notes.push(undeclaredNote({
					subject: `secret scanning custom pattern "${pattern.name}"`,
					action: "DELETE it (its alerts are then resolved, not deleted)"
				}));
				continue;
			}
			toDelete.push(pattern);
		}
		const [firstCreate, ...restCreate] = toCreate;
		if (firstCreate !== void 0) {
			const missing = (p) => `${key}[${p.name}]: missing - declared in the settings file but not on the repo; apply will create it`;
			const created = (p) => `created secret scanning custom pattern "${p.name}"`;
			plan.ops.push({
				role: "create",
				payload: { patterns: toCreate.map(createBody) },
				describe: `creating secret scanning pattern(s) ${toCreate.map((p) => `"${p.name}"`).join(", ")}`,
				drift: [missing(firstCreate), ...restCreate.map(missing)],
				change: () => [created(firstCreate), ...restCreate.map(created)]
			});
		}
		plan.ops.push(...updates);
		const [firstDelete, ...restDelete] = toDelete;
		if (firstDelete !== void 0) {
			const undeclared = (p) => undeclaredDrift(defaultUndeclaredPolicy(this), {
				label: `${key}[${p.name}]`,
				action: "DELETE it and resolve its alerts"
			});
			const deleted = (p) => `DELETED undeclared secret scanning custom pattern "${p.name}" (alerts resolved, not deleted)`;
			plan.ops.push({
				role: "remove",
				payload: {
					patterns: toDelete.map(deleteBody),
					post_delete_action: "resolve_alerts"
				},
				describe: `deleting undeclared secret scanning pattern(s) ${toDelete.map((p) => `"${p.name}"`).join(", ")}`,
				drift: [undeclared(firstDelete), ...restDelete.map(undeclared)],
				change: () => [deleted(firstDelete), ...restDelete.map(deleted)]
			});
		}
		return plan;
	},
	async snapshot(ctx) {
		const live = parseLive(this, ENDPOINTS$3.list, z.array(LivePatternEntry), await ctx.read.list.listAll());
		if (live.length === 0) return {
			value: void 0,
			notes: []
		};
		const entries = live.map((pattern) => projectOntoSchema(SecretScanningPatternConfig, pattern));
		return {
			value: knobbedSnapshot(this, entries),
			notes: []
		};
	}
};
//#endregion
//#region src/sections/teams/index.ts
/** `teams:` section: team repository access. Organization repos only, so a personal account no-ops with a note. */
const permission$2 = {
	repo: ["administration"],
	org: "members"
};
const ENDPOINTS$2 = {
	org: {
		route: "GET /orgs/{org}",
		statuses: {
			200: "the organization",
			404: "not an organization (a personal account)"
		},
		permission: "none",
		primaryRead: { notFound: "absent" }
	},
	probe: {
		route: "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
		statuses: {
			200: "the team's access to the repository",
			404: "the team has no access"
		}
	},
	grant: {
		route: "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}",
		statuses: { 204: "team access granted" }
	}
};
const LiveTeamRepo = z.looseObject({ role_name: z.string().optional() }).nullish();
const teamsSection = {
	key: "teams",
	undeclaredDefault: "untouched",
	permission: permission$2,
	ownerSensitivity: "org",
	endpoints: ENDPOINTS$2,
	shape: loosen(TeamsConfig),
	closedSurface: {
		known: {
			name: true,
			permission: true
		},
		describe: (t) => t.name,
		consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`
	},
	async plan(ctx, desired) {
		rejectDuplicates(this, desired, (t) => t.name.toLowerCase(), (t) => t.name);
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		if ("missing" in await ctx.read.org.probeAbsent({ params: { org: ctx.repo.owner } })) {
			plan.notes.push(`teams: owner "${ctx.repo.owner}" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note`);
			return plan;
		}
		for (const team of desired) {
			const role = team.permission ?? "push";
			const params = {
				org: ctx.repo.owner,
				team_slug: team.name
			};
			const probe = await ctx.read.probe.probeAbsent({
				params,
				accept: "application/vnd.github.v3.repository+json"
			});
			const wantRole = roleForPermission(role);
			let drift;
			if ("missing" in probe) drift = `teams[${team.name}]: no access to ${ctx.repo.slug}; apply will grant "${role}"`;
			else {
				const liveRole = parseLive(this, ENDPOINTS$2.probe, LiveTeamRepo, probe.data, `team "${team.name}"`)?.role_name ?? "";
				if (liveRole === wantRole) continue;
				drift = `teams[${team.name}]: live role "${liveRole}" != declared "${wantRole}"; apply will set the declared permission`;
			}
			plan.ops.push({
				role: "grant",
				params,
				payload: { permission: role },
				describe: `granting team "${team.name}" access`,
				drift: [drift],
				change: `granted team "${team.name}" ${role}`
			});
		}
		return plan;
	}
};
//#endregion
//#region src/sections/webhooks/index.ts
/**
* `webhooks:` section: repository webhooks, at most ONE per config.url (a changed url is a NEW
* hook; the old one turns undeclared). Hook urls are configuration and appear in drift on purpose;
* the secret never does, and a declared one is re-sent on every run.
*/
const LiveHook = z.looseObject({
	id: z.number(),
	name: z.string().optional(),
	active: z.boolean().optional(),
	events: z.array(z.string()).optional(),
	config: z.looseObject({ secret: z.string().optional() }).optional()
});
const permission$1 = { repo: ["webhooks"] };
const ENDPOINTS$1 = {
	list: {
		route: "GET /repos/{owner}/{repo}/hooks",
		statuses: { 200: "the webhook list" },
		primaryRead: { notFound: "denied" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/hooks",
		statuses: { 201: "webhook created" },
		unverifiable: true
	},
	update: {
		route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}",
		statuses: { 200: "webhook events/active updated" }
	},
	updateConfig: {
		route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config",
		statuses: { 200: "webhook config updated" },
		unverifiable: true
	},
	remove: {
		route: "DELETE /repos/{owner}/{repo}/hooks/{hook_id}",
		statuses: { 204: "webhook deleted" }
	}
};
/**
* GitHub stores insecure_ssl as the STRING "0" or "1" and echoes it back that way even when the
* write sent a number, so both sides normalize to the string form for comparison.
*/
function normalizeInsecureSsl(value) {
	return typeof value === "number" ? String(value) : value;
}
function comparableConfig(config) {
	const { secret: _secret, ...rest } = config;
	if ("insecure_ssl" in rest) rest.insecure_ssl = normalizeInsecureSsl(rest.insecure_ssl);
	return rest;
}
/** Compared as sets: GitHub does not define an event order. */
function eventsMatch(declared, live) {
	const declaredSet = new Set(declared);
	const liveSet = new Set(live);
	return declaredSet.size === liveSet.size && [...declaredSet].every((event) => liveSet.has(event));
}
/** The engine resolved every reference up front, so the lookup cannot miss. */
function resolvedConfig(exec, hook) {
	if (hook.config.secret === void 0) return plainData({ ...hook.config });
	return plainData({
		...hook.config,
		secret: exec.resolveSecret(hook.config.secret)
	});
}
/**
* Each label carries its hook's url (configuration that appears in drift lines on purpose, never a
* secret). A malformed container returns [] instead of throwing, so the actionable error always
* comes from shape validation.
*/
function secretValues(declared) {
	const container = declared;
	const isWrapper = typeof container === "object" && container !== null && !Array.isArray(container) && Array.isArray(container.entries);
	if (!Array.isArray(container) && !isWrapper) return [];
	const { entries } = undeclaredPolicy(container, "keep");
	return entries.flatMap((entry) => {
		const value = typeof entry === "object" && entry !== null ? entry.config?.secret : void 0;
		if (typeof value !== "string") return [];
		const url = entry.config?.url;
		return [{
			label: typeof url === "string" && url !== "" ? `the webhook "${url}" config.secret` : "a webhook entry's config.secret",
			value
		}];
	});
}
function describeHook(hook) {
	const url = hook.config?.url;
	return typeof url === "string" && url !== "" ? `"${url}"` : `id ${hook.id} (no config.url)`;
}
const CANNOT_VERIFY_SECRET = "GitHub never reveals a webhook secret (reads echo \"********\"), so the declared value cannot be verified; apply re-sends it on every run so rotations propagate";
/**
* The reference a snapshot writes for one live hook's secret, keyed by the hook's id (the number
* in its settings URL): a list position would rebind every later hook's variable to another
* hook's value once a hook is deleted and the repository is snapshotted again.
*/
function snapshotSecretReference(hook) {
	return mintSecretReference(`WEBHOOK_SECRET_${hook.id}`, `the webhook ${describeHook(hook)} secret`);
}
const webhooksSection = {
	key: "webhooks",
	undeclaredDefault: "keep",
	permission: permission$1,
	endpoints: ENDPOINTS$1,
	shape: loosen(knobbed(WebhookConfig)),
	secretValues,
	async plan(ctx, declared) {
		const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
		rejectDuplicates(this, desired, (hook) => hook.config.url, (hook) => hook.config.url);
		const live = parseLive(this, ENDPOINTS$1.list, z.array(LiveHook), await ctx.read.list.listAll());
		const declaredUrls = new Set(desired.map((hook) => hook.config.url));
		const ambiguous = [];
		for (const hook of desired) {
			const matches = live.filter((candidate) => candidate.config?.url === hook.config.url);
			if (matches.length > 1) ambiguous.push(`"${hook.config.url}" matches ${matches.length} live hooks (ids ${matches.map((candidate) => candidate.id).join(", ")})`);
		}
		if (ambiguous.length > 0) throw new Error(`webhooks: ${ambiguous.length} declared url(s) each match more than one live hook, and this section manages at most one hook per config.url: ${ambiguous.join("; ")}. Delete the duplicates on GitHub so exactly one remains per url, then re-run`);
		const plan = {
			ops: [],
			notes: [],
			drift: []
		};
		for (const hook of desired) {
			const url = hook.config.url;
			const existing = live.find((candidate) => candidate.config?.url === url);
			const { name: _name, config: _config, events, active, ...extraKeys } = hook;
			const secretNote = `webhooks["${url}"].config.secret: ${CANNOT_VERIFY_SECRET}`;
			const general = {
				...events === void 0 ? {} : { events },
				...active === void 0 ? {} : { active },
				...extraKeys
			};
			if (existing === void 0) {
				const missing = `webhooks["${url}"]: missing - declared in the settings file but not on the repo; apply will create it`;
				plan.ops.push({
					role: "create",
					payload: (exec) => plainData({
						name: "web",
						config: resolvedConfig(exec, hook),
						...general
					}),
					describe: `creating webhook "${url}"`,
					drift: hook.config.secret === void 0 ? [missing] : {
						unverifiable: secretNote,
						lines: [missing]
					},
					change: `created webhook "${url}"`
				});
				continue;
			}
			const configDrift = deltas(comparableConfig(hook.config), comparableConfig(existing.config ?? {})).map((delta) => renderDelta(`webhooks["${url}"].config`, delta));
			const configOp = {
				role: "updateConfig",
				params: { hook_id: String(existing.id) },
				payload: (exec) => resolvedConfig(exec, hook),
				describe: `updating webhook "${url}" config`
			};
			if (hook.config.secret !== void 0) plan.ops.push({
				...configOp,
				drift: {
					unverifiable: secretNote,
					lines: configDrift
				},
				change: `updated webhook "${url}" config (the declared secret is re-sent every run)`
			});
			else if (hasDrift(configDrift)) plan.ops.push({
				...configOp,
				drift: configDrift,
				change: `updated webhook "${url}" config`
			});
			const generalDrift = [
				...events !== void 0 && !eventsMatch(events, existing.events ?? []) ? [`webhooks["${url}"].events: declared ${JSON.stringify(events)} != live ${JSON.stringify(existing.events ?? [])} (compared order-insensitively); apply will set the declared events`] : [],
				...active !== void 0 && (existing.active ?? true) !== active ? [`webhooks["${url}"].active: declared ${JSON.stringify(active)} != live ${JSON.stringify(existing.active ?? true)}; apply will set the declared value`] : [],
				...deltas(extraKeys, existing).map((delta) => renderDelta(`webhooks["${url}"]`, delta))
			];
			if (hasDrift(generalDrift)) plan.ops.push({
				role: "update",
				params: { hook_id: String(existing.id) },
				payload: plainData(general),
				describe: `updating webhook "${url}"`,
				drift: generalDrift,
				change: `updated webhook "${url}"`
			});
		}
		for (const hook of live) {
			const url = hook.config?.url;
			if (typeof url === "string" && declaredUrls.has(url)) continue;
			if (policy === "delete") {
				plan.ops.push({
					role: "remove",
					params: { hook_id: String(hook.id) },
					describe: `deleting undeclared webhook ${describeHook(hook)}`,
					drift: [undeclaredDrift(defaultUndeclaredPolicy(this), {
						label: `webhooks[${describeHook(hook)}]`,
						action: "DELETE it"
					})],
					change: `DELETED undeclared webhook ${describeHook(hook)}`
				});
				continue;
			}
			plan.notes.push(undeclaredNote({
				subject: `webhook ${describeHook(hook)}`,
				action: "DELETE it"
			}));
		}
		return plan;
	},
	async snapshot(ctx) {
		const live = parseLive(this, ENDPOINTS$1.list, z.array(LiveHook), await ctx.read.list.listAll());
		const notes = [];
		const withUrl = live.filter((hook) => {
			if (typeof hook.config?.url === "string" && hook.config.url !== "") return true;
			notes.push(`webhooks[${describeHook(hook)}]: the hook has no config.url, the natural key this section manages by, so it is left out of the snapshot`);
			return false;
		});
		rejectLiveDuplicates(this, "webhook", withUrl, (hook) => String(hook.config?.url), (hook) => `${String(hook.config?.url)} (id ${hook.id})`);
		const addressable = withUrl.filter((hook) => {
			if (hook.name === void 0 || hook.name === "web") return true;
			notes.push(`webhooks[${describeHook(hook)}]: a "${hook.name}" service hook is not a web hook this section manages, so it is left out of the snapshot`);
			return false;
		});
		if (addressable.length === 0) return {
			value: void 0,
			notes
		};
		const entries = addressable.map((hook) => {
			const entry = projectOntoSchema(WebhookConfig, hook);
			if (entry.config.secret === void 0) return entry;
			const { variable, reference } = snapshotSecretReference(hook);
			notes.push(`webhooks[${describeHook(hook)}].config.secret: the webhook secret is not readable; export a value as ${variable} into the environment before apply`);
			return {
				...entry,
				config: {
					...entry.config,
					secret: reference
				}
			};
		});
		return {
			value: knobbedSnapshot(this, entries),
			notes
		};
	}
};
//#endregion
//#region src/sections/workflows/index.ts
/**
* `workflows:` section: enable/disable existing workflows by path. A declared workflow whose file
* does not exist is skipped loudly, never created: workflow files are code, not settings.
*/
const LiveWorkflow = z.looseObject({
	id: z.number(),
	path: z.string(),
	state: z.string()
});
const permission = { repo: ["actions"] };
const ENDPOINTS = {
	list: {
		route: "GET /repos/{owner}/{repo}/actions/workflows",
		statuses: { 200: "the workflow list" },
		primaryRead: { notFound: "denied" }
	},
	enable: {
		route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable",
		statuses: { 204: "workflow enabled" }
	},
	disable: {
		route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable",
		statuses: { 204: "workflow disabled" }
	}
};
//#endregion
//#region src/sections/registry.ts
const byKey = {
	repository: repositorySection,
	labels: labelsSection,
	rulesets: rulesetsSection,
	environments: environmentsSection,
	branches: branchesSection,
	autolinks: autolinksSection,
	actions: actionsSection,
	actions_secrets: actionsSecretsSection,
	dependabot_secrets: dependabotSecretsSection,
	codespaces_secrets: codespacesSecretsSection,
	agents_secrets: agentsSecretsSection,
	workflows: {
		key: "workflows",
		undeclaredDefault: "untouched",
		permission,
		endpoints: ENDPOINTS,
		shape: loosen(WorkflowsConfig),
		closedSurface: {
			known: {
				path: true,
				state: true
			},
			describe: (w) => w.path,
			consequence: "the enable/disable calls send no payload, so the key would silently do nothing"
		},
		async plan(ctx, desired) {
			rejectDuplicates(this, desired, (w) => w.path.includes("/") ? w.path : `.github/workflows/${w.path}`, (w) => w.path);
			const present = parseLive(this, ENDPOINTS.list, z.array(LiveWorkflow), await ctx.read.list.listAllEnveloped("workflows")).filter((w) => w.state !== "deleted");
			const plan = {
				ops: [],
				notes: [],
				drift: []
			};
			for (const workflow of desired) {
				const match = present.find((w) => w.path === workflow.path || w.path === `.github/workflows/${workflow.path}`);
				if (!match) {
					plan.drift.push(`workflows[${workflow.path}]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section`);
					continue;
				}
				const liveState = match.state === "active" ? "active" : "disabled";
				if (liveState === workflow.state) continue;
				const action = workflow.state === "active" ? "enable" : "disable";
				const raw = match.state === liveState ? "" : ` (${match.state})`;
				plan.ops.push({
					role: action,
					params: { workflow_id: String(match.id) },
					drift: [`workflows[${workflow.path}]: declared "${workflow.state}" != live "${liveState}"${raw}; apply will ${action} the workflow`],
					change: `${action}d workflow "${match.path}"`
				});
			}
			return plan;
		},
		async snapshot(ctx) {
			const present = parseLive(this, ENDPOINTS.list, z.array(LiveWorkflow), await ctx.read.list.listAllEnveloped("workflows")).filter((w) => w.state !== "deleted");
			if (present.length === 0) return {
				value: void 0,
				notes: []
			};
			return {
				value: present.map((w) => ({
					path: w.path,
					state: w.state === "active" ? "active" : "disabled"
				})),
				notes: []
			};
		}
	},
	check_suite_preferences: checkSuitePreferencesSection,
	pages: pagesSection,
	code_scanning_default_setup: codeScanningDefaultSetupSection,
	code_quality_setup: codeQualitySetupSection,
	collaborators: collaboratorsSection,
	teams: teamsSection,
	milestones: milestonesSection,
	interaction_limits: interactionLimitsSection,
	actions_variables: actionsVariablesSection,
	agents_variables: agentsVariablesSection,
	webhooks: webhooksSection,
	custom_properties: customPropertiesSection,
	deploy_keys: deployKeysSection,
	secret_scanning_custom_patterns: secretScanningPatternsSection
};
/**
* Erasure must go through THIS mapped annotation: the compiler relates SectionModule<K> to
* SectionModule<SectionKey> by variance, while a literal module's closedSurface compared structurally
* against the union-collapsed wide form would be rejected.
*/
const byKeyErased = byKey;
const SECTIONS = SECTION_KEYS.map((key) => byKeyErased[key]);
function sectionShape(key) {
	return byKey[key].shape;
}
/** The section module for a key (validate.ts reads shape + closedSurface). */
function sectionModule(key) {
	return byKeyErased[key];
}
/**
* ":" is RESERVED for a future scope prefix ("<scope>:<section>.<role>"); a colon smuggled in today
* would be indistinguishable from a scoped key later.
*/
function assertScopeFree(kind, value) {
	if (value.includes(":")) throw new Error(`BUG: ${kind} "${value}" contains ":", which the "section.role" key space reserves for a future scope prefix ("<scope>:<section>.<role>"); rename it without a colon`);
}
function allEndpoints(sections = SECTIONS) {
	const out = {};
	for (const section of sections) {
		assertScopeFree("section key", section.key);
		for (const [role, endpoint] of Object.entries(section.endpoints)) {
			assertScopeFree("role", role);
			Object.freeze(endpoint.statuses);
			if (endpoint.permission && typeof endpoint.permission === "object") {
				Object.freeze(endpoint.permission);
				Object.freeze(endpoint.permission.repo);
			}
			out[`${section.key}.${role}`] = Object.freeze({
				...endpoint,
				section: section.key,
				role
			});
		}
	}
	return Object.freeze(out);
}
function allGraphqlOps(sections = SECTIONS) {
	const out = {};
	const byName = /* @__PURE__ */ new Map();
	for (const section of sections) {
		assertScopeFree("section key", section.key);
		for (const [role, op] of Object.entries(section.graphql ?? {})) {
			assertScopeFree("role", role);
			const key = `${section.key}.${role}`;
			if (section.endpoints[role] !== void 0) throw new Error(`BUG: section "${section.key}" declares both a REST endpoint and a GraphQL operation under the role "${role}"; fault and corruption directives share the "section.role" key space, so roles must be distinct`);
			const holder = byName.get(op.name);
			if (holder !== void 0) throw new Error(`BUG: GraphQL operation name "${op.name}" is declared by both ${holder} and ${key}; operation names are the wire dispatch key and must be globally unique`);
			byName.set(op.name, key);
			Object.freeze(op.outcomes);
			if (op.permission && typeof op.permission === "object") {
				Object.freeze(op.permission);
				Object.freeze(op.permission.repo);
			}
			out[key] = Object.freeze({
				...op,
				section: section.key,
				role
			});
		}
	}
	return Object.freeze(out);
}
//#endregion
//#region src/engine/layers.ts
/**
* The layered merge, folded low to high; pure (no Io, no GitHub), and layers are trees: a document aliasing a node
* inside itself is refused. Lists never combine except a knobbed section's entries under "merge", unioned by the
* module's key (and the nested lists that key declares).
*
* higher plain mapping                  -> merged key by key
* higher scalar, list, tagged           -> replaces
* higher null over a lower declaration  -> deletes it (an opt-out notice)
* higher null over nothing, or a null   -> stays as written, so `pages: null` keeps its engine meaning
*/
const LAYERING_KEY = "_layering";
const LAYERINGS$1 = ["merge", "replace"];
function isLayering(value) {
	return LAYERINGS$1.some((layering) => layering === value);
}
/**
* A plain array becomes `{entries}` with NO `_undeclared`: that omission is what lets a merge inherit a lower layer's
* policy. Resolved to the section default here, a higher layer's default would overwrite the lower's explicit policy.
*/
function normalizeKnobbedSections(settings) {
	if (!isPlainObject$1(settings)) return settings;
	const out = { ...settings };
	for (const key of UNDECLARED_POLICY_SECTIONS) {
		const value = out[key];
		if (Array.isArray(value)) out[key] = { entries: value };
	}
	return out;
}
function sectionDefaultPolicy(key) {
	return defaultUndeclaredPolicy(sectionModule(key));
}
/** After the fold, a wrapper still without `_undeclared` takes the section default, so the merged document is self-describing. */
function resolveUndeclaredPolicies(merged) {
	for (const key of UNDECLARED_POLICY_SECTIONS) {
		const value = merged[key];
		if (isPlainObject$1(value) && Array.isArray(value.entries) && value._undeclared === void 0) value._undeclared = sectionDefaultPolicy(key);
	}
}
function sectionLayering(key) {
	const section = UNDECLARED_POLICY_SECTIONS.find((candidate) => candidate === key);
	return section === void 0 ? void 0 : sectionModule(section).layering;
}
function stripValue(value, descent) {
	return isPlainObject$1(value) ? stripMapping(value, void 0, descent) : structuredClone(value);
}
/** Mirrors mergeMappings: a null-valued key is a marker and drops, and `keyed` names the same fields it names there. */
function stripMapping(map, keyed, descent) {
	const enclosing = descent.get(map);
	if (enclosing !== void 0) return enclosing;
	const out = {};
	descent.set(map, out);
	for (const [key, value] of Object.entries(map)) {
		if (value === null) continue;
		const nested = keyed === void 0 ? void 0 : own(keyed, key);
		put(out, key, nested === void 0 ? stripValue(value, descent) : stripKeyedList(value, nested, descent));
	}
	descent.delete(map);
	return out;
}
/** Mirrors unionKeyed: the same lists are entered. */
function stripKeyedList(list, keyed, descent) {
	if (!Array.isArray(list) || keyed.combine === "replace") return stripValue(list, descent);
	const enclosing = descent.get(list);
	if (enclosing !== void 0) return enclosing;
	const out = [];
	descent.set(list, out);
	for (const item of list) out.push(isPlainObject$1(item) ? stripMapping(item, keyed.nested, descent) : structuredClone(item));
	descent.delete(list);
	return out;
}
/**
* A layer validated on its own is seen as the merge could leave it: every null the merge would read as a marker drops,
* every other null stays for the validator to judge. A cyclic input yields a cyclic clone; the merge is what refuses those.
*
* `rulesets[main].bypass_actors: null`  -> dropped (a mapping key inside a keyed list the merge combines)
* `branches[].protection: null`         -> kept (inside a list the merge copies as written)
* a null list element                   -> kept
*/
function stripNulls(doc) {
	if (!isPlainObject$1(doc)) return structuredClone(doc);
	const descent = /* @__PURE__ */ new WeakMap();
	const out = {};
	descent.set(doc, out);
	for (const [key, value] of Object.entries(doc)) {
		if (value === null) continue;
		const layering = sectionLayering(key);
		let stripped;
		if (layering === void 0) stripped = stripValue(value, descent);
		else if (isPlainObject$1(value)) stripped = stripMapping(value, { entries: layering }, descent);
		else stripped = stripKeyedList(value, layering, descent);
		put(out, key, stripped);
	}
	return out;
}
/**
* No document key or value ever enters a refusal's prose; the marker test in test/engine/layers.test.ts pins it.
*
* `actual`    -> the only document value carried, and describeProblem describes it by shape
* `keyField`  -> the module's declared key field
* `site`      -> section keys, entry indices, module-declared field names, LAYERING_KEY, "the document"
*/
function refuse(layer, site, refusal) {
	return err({
		layer,
		site,
		...refusal
	});
}
/** Value-free under the refusals' invariant: mode: merge has no redaction context, so no document value may reach a log through the merge. */
function describeOptOut(notice) {
	return `${notice.layer}: null removed ${notice.path} declared by a lower layer`;
}
function asMappings(list) {
	return list.every(isPlainObject$1) ? list : null;
}
function admitEntries(layer, path, list) {
	const mappings = asMappings(list);
	if (mappings !== null) return ok(mappings);
	const index = list.findIndex((entry) => !isPlainObject$1(entry));
	return refuse(layer, `${path}[${index}]`, {
		code: "layer-wrong-shape",
		expected: "a mapping",
		actual: list[index]
	});
}
/** Two entries of one layer claiming a key (a label renaming into a sibling's name) are refused here, so unionKeyed never meets them. */
function checkKeyed(layer, entries, keyed, path) {
	const seen = /* @__PURE__ */ new Map();
	for (const [index, entry] of entries.entries()) {
		const keys = keyed.keys(entry);
		if (keys === null) return refuse(layer, `${path}[${index}]`, {
			code: "layer-no-key",
			keyField: keyed.keyField
		});
		for (const key of keys) {
			const first = seen.get(key);
			if (first !== void 0) return refuse(layer, path, {
				code: "layer-duplicate-key",
				keyField: keyed.keyField,
				first,
				second: index
			});
			seen.set(key, index);
		}
		for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
			const value = entry[field];
			if (!Array.isArray(value)) continue;
			const nestedPath = `${path}[${index}].${field}`;
			const checked = admitEntries(layer, nestedPath, value).andThen((mappings) => checkKeyed(layer, mappings, nested, nestedPath));
			if (checked.isErr()) return checked;
		}
	}
	return ok();
}
function fileLayering(layer, doc) {
	const value = doc[LAYERING_KEY];
	if (value === void 0) return ok(void 0);
	if (!isLayering(value)) return refuse(layer, LAYERING_KEY, {
		code: "layer-bad-directive",
		actual: value
	});
	return ok(value);
}
function admitSection(layer, key, value, fallback) {
	if (!isPlainObject$1(value) || !Array.isArray(value.entries)) return refuse(layer, key, {
		code: "layer-wrong-shape",
		expected: "a list of mappings or an {_undeclared, entries} wrapper",
		actual: value,
		detail: isPlainObject$1(value) ? " without an entries list" : void 0
	});
	return admitEntries(layer, key, value.entries).andThen((entries) => {
		const { entries: _entries, [LAYERING_KEY]: directive, ...knobs } = value;
		if (directive !== void 0 && !isLayering(directive)) return refuse(layer, `${key}.${LAYERING_KEY}`, {
			code: "layer-bad-directive",
			actual: directive
		});
		const explicit = directive ?? fallback.file;
		const keyed = sectionModule(key).layering;
		if (keyed === void 0 && explicit === "merge") return refuse(layer, key, { code: "layer-no-layering-key" });
		const section = {
			knobs,
			entries,
			layering: explicit ?? fallback.run,
			keyed
		};
		return keyed === void 0 ? ok(section) : checkKeyed(layer, entries, keyed, key).map(() => section);
	});
}
/**
* Only a node on the current descent counts: a node aliased twice without enclosing itself is a tree to the merge, which
* clones it per site. `walked` keeps a fully walked node from being entered again.
*/
function hasCycle(value, descent, walked) {
	if (!Array.isArray(value) && !isPlainObject$1(value)) return false;
	if (walked.has(value)) return false;
	if (descent.has(value)) return true;
	descent.add(value);
	const cyclic = (Array.isArray(value) ? value : Object.values(value)).some((child) => hasCycle(child, descent, walked));
	descent.delete(value);
	walked.add(value);
	return cyclic;
}
/**
* The layer boundary: past it the fold never meets a cycle, an unkeyed entry, or a duplicated key. A non-mapping
* passes as written for the top-level validator to name.
*/
function admit(layer, run) {
	if (hasCycle(layer.doc, /* @__PURE__ */ new WeakSet(), /* @__PURE__ */ new WeakSet())) return refuse(layer.name, "the document", { code: "layer-cycle" });
	const doc = normalizeKnobbedSections(layer.doc);
	if (!isPlainObject$1(doc)) return ok(null);
	return fileLayering(layer.name, doc).andThen((file) => {
		const sections = /* @__PURE__ */ new Map();
		for (const key of UNDECLARED_POLICY_SECTIONS) {
			const value = doc[key];
			if (value === void 0 || value === null) continue;
			const admitted = admitSection(layer.name, key, value, {
				file,
				run
			});
			if (admitted.isErr()) return err(admitted.error);
			sections.set(key, admitted.value);
		}
		return ok({
			name: layer.name,
			doc,
			sections
		});
	});
}
function childPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** An own property's value: an inherited name (`constructor`) is not a document key. */
function own(record, key) {
	return Object.hasOwn(record, key) ? record[key] : void 0;
}
/** Set an own data property whatever the key; assigning `__proto__` would set the prototype. */
function put(record, key, value) {
	Object.defineProperty(record, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}
function applyNull(out, key, path, step) {
	const lower = own(out, key);
	if (lower !== void 0 && lower !== null) {
		delete out[key];
		step.notices.push({
			layer: step.layer,
			path
		});
		return;
	}
	put(out, key, null);
}
function mergeValue(below, above, path, step, keyed) {
	if (isPlainObject$1(below) && isPlainObject$1(above)) return mergeMappings(below, above, path, step, keyed);
	return structuredClone(above);
}
function mergeMappings(below, above, path, step, keyed) {
	const out = { ...below };
	for (const [key, value] of Object.entries(above)) {
		if (value === void 0) continue;
		const here = childPath(path, key);
		if (value === null) {
			applyNull(out, key, here, step);
			continue;
		}
		const nested = keyed === void 0 ? void 0 : own(keyed, key);
		const lower = own(out, key);
		if (nested !== void 0 && Array.isArray(lower) && Array.isArray(value)) {
			put(out, key, unionKeyed(lower, value, nested, here, step));
			continue;
		}
		put(out, key, mergeValue(lower, value, here, step));
	}
	return out;
}
/**
* Matching reads the lower list as it stood before this layer, so which entries result does not depend on the higher
* entries' order; a lower entry two higher entries claim is superseded by both, and checkKeyed's key-disjointness keeps
* the result one the section's planner accepts.
*/
function unionKeyed(lower, higher, keyed, path, step) {
	const intersect = (a, b) => a.some((key) => b.includes(key));
	const lowerKeys = lower.map((item) => (isPlainObject$1(item) ? keyed.keys(item) : null) ?? []);
	const placements = higher.map((item, index) => {
		const keys = isPlainObject$1(item) ? keyed.keys(item) : null;
		const slot = keys === null ? -1 : lowerKeys.findIndex((claims) => intersect(claims, keys));
		return isPlainObject$1(item) && keys !== null && slot !== -1 ? {
			item,
			index,
			keys,
			slot
		} : {
			item,
			slot: void 0
		};
	});
	const placed = placements.flatMap((p) => p.slot === void 0 ? [] : [p]);
	const out = [];
	lower.forEach((below, index) => {
		if (!placed.some((p) => intersect(lowerKeys[index] ?? [], p.keys))) {
			out.push(below);
			return;
		}
		for (const placement of placed) if (placement.slot === index) out.push(keyed.combine === "replace" ? structuredClone(placement.item) : mergeValue(below, placement.item, `${path}[${placement.index}]`, step, keyed.nested));
	});
	for (const { item, slot } of placements) if (slot === void 0) out.push(structuredClone(item));
	return out;
}
function mergeSection(key, lower, section, step) {
	const { entries: lowerEntries, ...lowerKnobs } = isPlainObject$1(lower) ? lower : {};
	const out = mergeMappings(lowerKnobs, section.knobs, key, step);
	out.entries = section.layering === "merge" && section.keyed !== void 0 && Array.isArray(lowerEntries) ? unionKeyed(lowerEntries, section.entries, section.keyed, key, step) : structuredClone(section.entries);
	return out;
}
function mergeStep(acc, layer, notices) {
	const step = {
		layer: layer.name,
		notices
	};
	const out = { ...isPlainObject$1(acc) ? acc : {} };
	for (const [key, value] of Object.entries(layer.doc)) {
		if (key === LAYERING_KEY || value === void 0) continue;
		if (value === null) {
			applyNull(out, key, key, step);
			continue;
		}
		const section = layer.sections.get(key);
		const lower = own(out, key);
		put(out, key, section === void 0 ? mergeValue(lower, value, key, step) : mergeSection(key, lower, section, step));
	}
	return out;
}
function mergeLayers(layers, options) {
	const notices = [];
	let acc = {};
	for (const layer of layers) {
		const admitted = admit(layer, options.layering);
		if (admitted.isErr()) return err(admitted.error);
		acc = admitted.value === null ? structuredClone(layer.doc) : mergeStep(acc, admitted.value, notices);
	}
	if (isPlainObject$1(acc)) resolveUndeclaredPolicies(acc);
	return ok({
		settings: acc,
		notices
	});
}
//#endregion
//#region src/engine/execute.ts
/**
* OWN property only: an erased plan carries a bare string role, and an inherited name ("constructor") must read as
* undeclared, never as a value to call.
*/
function declared(dict, role) {
	return dict !== void 0 && Object.hasOwn(dict, role) ? dict[role] : void 0;
}
function noop() {}
/**
* The change thunk and capture hook are synchronous by contract: a promise would let the line record before the hook
* settled and drop its rejection, so a thenable is a bug caught before the line records.
*/
function rejectThenable(section, role, hook, value) {
	const then = value?.then;
	if (typeof then === "function") {
		try {
			then.call(value, noop, noop);
		} catch {}
		throw new Error(`BUG: ${section.key}: the ${hook} of operation "${role}" returned a promise; it must be synchronous`);
	}
}
async function executePlan(plan, section, api, repo, tools) {
	const exec = Object.freeze({ resolveSecret: (reference) => tools.resolveSecret(reference) });
	const ctx = {
		api,
		repo,
		check: false,
		resolveSecret: exec.resolveSecret
	};
	const changes = [];
	const notes = [];
	let landed = 0;
	for (const op of plan.ops) try {
		let response;
		if (typeof op.role !== "string") throw new Error(`BUG: ${section.key} planned an operation whose role is a ${typeof op.role}, not the name of a declared write`);
		const endpoint = declared(section.endpoints, op.role);
		if (endpoint !== void 0) {
			if (endpointMethod(endpoint.route) === "GET") throw new Error(`BUG: ${section.key} planned an operation under role "${op.role}", which is a read endpoint (${endpoint.route}); only write roles are plannable`);
			await op.before?.(exec);
			const payload = typeof op.payload === "function" ? await op.payload(exec) : op.payload;
			const request = {
				params: op.params,
				query: op.query,
				payload,
				describe: op.describe
			};
			if (op.tolerate === void 0) response = await callDeclared(ctx, section, endpoint, request);
			else {
				const result = await tryCallDeclared(ctx, section, endpoint, {
					...request,
					tolerated: declaredTolerance(endpoint, op.tolerate.statuses)
				});
				if ("error" in result) {
					const outcome = op.tolerate.outcome(result.error);
					if (outcome.failure !== void 0) throw new Error(outcome.failure);
					notes.push(outcome.note);
					continue;
				}
				response = result.data;
			}
		} else {
			const graphqlOp = declared(section.graphql, op.role);
			if (graphqlOp === void 0) throw new Error(`BUG: ${section.key} planned an operation under role "${op.role}", which names no declared endpoint or GraphQL operation`);
			if (graphqlOp.kind !== "write") throw new Error(`BUG: ${section.key} planned an operation under role "${op.role}", which is a GraphQL ${graphqlOp.kind} operation; only write roles are plannable`);
			await op.before?.(exec);
			response = await callGraphql(ctx, section, graphqlOp, (typeof op.variables === "function" ? await op.variables(exec) : op.variables) ?? {}, { describe: op.describe });
		}
		landed++;
		const lines = typeof op.change === "function" ? op.change(response) : op.change;
		rejectThenable(section, op.role, "change thunk", lines);
		if (lines.length === 0) throw new Error(`BUG: ${section.key}: operation "${op.role}" rendered no change line for a request that landed`);
		rejectThenable(section, op.role, "capture hook", op.capture?.(response));
		changes.push(...typeof lines === "string" ? [lines] : lines);
	} catch (error) {
		return {
			status: "failed",
			changes,
			notes,
			landed,
			error
		};
	}
	return {
		status: "applied",
		changes,
		notes,
		landed
	};
}
//#endregion
//#region src/engine/validate.ts
/** Shape validation against each section's loose zod shape; the parsed output, not the input, is what the engine applies. */
/**
* zod's object schemas accept a Date, Set, or Uint8Array (YAML !!timestamp, !!set, !!binary) as an empty mapping, so a
* tagged value where a mapping is expected (actions.cache, a pages mapping) would validate and then silently configure
* nothing. One walk here covers every section instead of a guard each new mapping must remember; `seen` keeps a YAML
* anchor cycle from hanging it.
*/
function findNonPlain(value, path, seen) {
	if (value === null || typeof value !== "object") return null;
	if (seen.has(value)) return null;
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const hit = findNonPlain(value[index], `${path}[${index}]`, seen);
			if (hit !== null) return hit;
		}
		return null;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return `${path} is not plain YAML data (${nonPlainKind(value)}); replace it with a plain value`;
	for (const [key, entry] of Object.entries(value)) {
		const hit = findNonPlain(entry, `${path}.${key}`, seen);
		if (hit !== null) return hit;
	}
	return null;
}
/** The result is zod's output (fresh plain objects at every node the shape describes), never the caller's document. */
function validateSectionShapes(settings, sourceLabel) {
	const problems = [];
	const parsedSections = {};
	for (const key of SECTION_KEYS) {
		const declared = settings[key];
		if (declared === void 0) continue;
		const nonPlain = findNonPlain(declared, key, /* @__PURE__ */ new WeakSet());
		if (nonPlain !== null) {
			problems.push(nonPlain);
			continue;
		}
		const parsed = sectionShape(key).safeParse(declared);
		if (!parsed.success) {
			const issues = parsed.error.issues;
			for (const issue of issues.slice(0, 5)) {
				const path = issue.path.map((p) => typeof p === "number" ? `[${p}]` : `.${String(p)}`).join("");
				problems.push(`${key}${path}: ${issue.message}`);
			}
			if (issues.length > 5) problems.push(`${key}: ...and ${issues.length - 5} more issue(s) in this section`);
			continue;
		}
		problems.push(...closedSurfaceProblems(key, parsed.data));
		parsedSections[key] = parsed.data;
	}
	if (problems.length === 0) return ok(parsedSections);
	return err({
		code: "settings-malformed-sections",
		source: sourceLabel,
		issues: problems
	});
}
/** Only the entries are checked here, in either form; the wrapper's own keys are the section shape's strictObject to judge. */
function closedSurfaceProblems(key, declared) {
	const closed = sectionModule(key).closedSurface;
	if (closed === void 0) return [];
	const entries = Array.isArray(declared) ? declared : typeof declared === "object" && declared !== null && Array.isArray(declared.entries) ? declared.entries : null;
	if (entries === null) return [];
	const knownKeys = Object.keys(closed.known);
	const known = new Set(knownKeys);
	const problems = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		const unknown = Object.keys(record).filter((k) => !known.has(k));
		if (unknown.length > 0) {
			const list = unknown.map((k) => `"${k}"`).join(", ");
			problems.push(`${key}[${closed.describe(record)}]: declares ${list}, which this section does not recognize (known keys: ${knownKeys.join(", ")}) - ${closed.consequence}. Fix the key name, or remove it`);
		}
	}
	if (problems.length > 5) return [...problems.slice(0, 5), `${key}: ...and ${problems.length - 5} more entr${problems.length - 5 === 1 ? "y" : "ies"} with unrecognized keys in this section`];
	return problems;
}
//#endregion
//#region src/engine/orchestrate.ts
/**
* The per-repository pipeline (active-section filter, preflight barrier, section loop) the single- and multi-repo flows
* share. All output goes through the Io sink; callers decide how to tag lines per repository.
*/
/**
* Worst-first, the ranking worstOf() applies; the single source for the action.yml `result` output docs too (the
* contract test imports it). The lockstep below keeps it locked to RepoResult.
*/
const REPO_RESULTS = [
	"failed",
	"drift",
	"partial",
	"skipped",
	"applied",
	"clean"
];
function skippedSectionKeys(outcomes) {
	return outcomes.filter((o) => o.status === "skipped").map((o) => o.key);
}
/**
* The ONE boundary that turns a raw parsed document into the ValidatedSettings the engine accepts. Unknown top-level
* keys are errors, except outside a non-empty `sections` allowlist, where they downgrade to a warning.
*/
function validateSettingsDoc(settings, sourceLabel, onlySections, io) {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return err({
		code: "settings-not-mapping",
		source: sourceLabel,
		shape: nonMappingShape(settings)
	});
	const proto = Object.getPrototypeOf(settings);
	if (proto !== Object.prototype && proto !== null) return err({
		code: "settings-not-plain-mapping",
		source: sourceLabel
	});
	const knownSections = new Set(SECTION_KEYS);
	const allowed = onlySections;
	const unknownKeys = Object.keys(settings).filter((key) => !knownSections.has(key) && !key.startsWith("_"));
	if (unknownKeys.length > 0) {
		if (onlySections.size === 0 || unknownKeys.some((key) => allowed.has(key))) return err({
			code: "settings-unknown-sections",
			source: sourceLabel,
			unknown: unknownKeys,
			known: SECTION_KEYS
		});
		io.annotate("warning", `ignoring unknown top-level section(s) outside the "sections" allowlist: ${unknownKeys.join(", ")}. Upgrade the action to a version that knows them, or remove them from ${sourceLabel}`);
	}
	return validateSectionShapes(settings, sourceLabel).map((parsed) => parsed);
}
/** A non-mapping document's top level in typeof terms; the only object left by the caller's guard is null. */
function nonMappingShape(value) {
	if (Array.isArray(value)) return "list";
	const kind = typeof value;
	return kind === "object" ? "null" : kind;
}
/** A plan section has no write capability, so planning IS the read-only probe; `active` is injectable for tests. */
async function preflightProbe(api, repo, active, settings) {
	const denied = [];
	for (const section of active) {
		const declared = settings[section.key];
		if (declared === void 0) throw new Error(`BUG: preflightProbe was given section "${section.key}" but the settings document does not declare it; the active list must be filtered to declared sections`);
		try {
			await section.plan(planContext(section, api, repo), declared);
		} catch (error) {
			if (error instanceof PermissionDenied) denied.push(`${section.key}: ${error.detail}`);
		}
	}
	return denied;
}
async function runForRepo(api, opts, io) {
	const check = opts.mode === "check";
	const repo = opts.repo;
	const settings = opts.settings;
	const disposition = (key) => {
		if (settings[key] === void 0) return "absent";
		if (opts.sections.only.size > 0 && !opts.sections.only.has(key)) return "excluded";
		return "active";
	};
	const active = SECTIONS.filter((section) => disposition(section.key) === "active");
	const secretValues = collectSecretValues(settings, active, opts.secretSource ?? "operator");
	const secretFailure = (errorsBySection) => {
		const outcomes = [];
		for (const [key, errors] of errorsBySection) {
			for (const message of errors) io.annotate("error", `${key}: ${message}`);
			outcomes.push({
				key,
				status: "failed",
				detail: errors
			});
		}
		return {
			repo: opts.repo.slug,
			result: "failed",
			outcomes,
			preflightDenied: []
		};
	};
	const pushError = (map, key, message) => {
		const list = map.get(key) ?? [];
		list.push(message);
		map.set(key, list);
	};
	const syntaxErrors = /* @__PURE__ */ new Map();
	for (const { section, value, source, label } of secretValues) {
		const checked = validateSecretRef(value, source, label);
		if (!checked.ok) pushError(syntaxErrors, section, checked.error);
	}
	if (syntaxErrors.size > 0) return secretFailure(syntaxErrors);
	if (!check && opts.onMissingPermission === "fail") {
		const denied = await preflightProbe(api, repo, active, settings);
		if (denied.length > 0) {
			for (const line of denied) io.annotate("error", `preflight: ${line}`);
			return {
				repo: opts.repo.slug,
				result: "failed",
				outcomes: [],
				preflightDenied: denied
			};
		}
	}
	let tools = null;
	if (!check) {
		const resolved = {};
		if (secretValues.length > 0) {
			const env = opts.secretEnv ?? process.env;
			const bySection = /* @__PURE__ */ new Map();
			for (const value of secretValues) {
				const list = bySection.get(value.section) ?? [];
				list.push(value);
				bySection.set(value.section, list);
			}
			const resolutionErrors = /* @__PURE__ */ new Map();
			const mask = /* @__PURE__ */ new Set();
			for (const [key, values] of bySection) {
				const resolution = resolveSecretRefs(values, env);
				if (!resolution.ok) {
					resolutionErrors.set(key, resolution.errors);
					continue;
				}
				Object.assign(resolved, resolution.values);
				for (const plaintext of resolution.mask) mask.add(plaintext);
			}
			if (resolutionErrors.size > 0) return secretFailure(resolutionErrors);
			for (const plaintext of mask) io.mask(plaintext);
		}
		tools = { resolveSecret: (reference) => {
			const plaintext = reference.startsWith("$") ? resolved[reference.slice(1)] : void 0;
			if (plaintext === void 0) throw new Error(`BUG: secret reference ${reference} was not resolved up front; the engine resolves every declared secret value before any section runs`);
			return plaintext;
		} };
	}
	const outcomes = [];
	let failed = false;
	let partial = false;
	let drifted = false;
	for (const section of SECTIONS) {
		switch (disposition(section.key)) {
			case "absent": continue;
			case "excluded":
				outcomes.push({
					key: section.key,
					status: "excluded",
					detail: ["excluded by `sections`"]
				});
				continue;
		}
		const desired = settings[section.key];
		if (desired === void 0) throw new Error(`BUG: section "${section.key}" was classified active but the settings document does not declare it`);
		let result;
		let produced = {
			notes: [],
			changes: [],
			landed: 0
		};
		try {
			const plan = await section.plan(planContext(section, api, repo), desired);
			if (tools === null) result = {
				check: true,
				drift: planDrift(plan),
				notes: planCheckNotes(plan)
			};
			else {
				const execution = await executePlan(plan, section, api, repo, tools);
				const notes = [
					...plan.notes,
					...plan.drift,
					...execution.notes
				];
				produced = {
					notes,
					changes: execution.changes,
					landed: execution.landed
				};
				if (execution.status === "failed") throw execution.error;
				result = {
					check: false,
					changes: [...execution.changes],
					notes
				};
			}
		} catch (error) {
			for (const note of produced.notes) io.annotate("notice", `${section.key}: ${note}`);
			for (const line of produced.changes) io.log(`${section.key}: ${line}`);
			const before = [...produced.notes, ...produced.changes];
			if (error instanceof PermissionDenied) {
				const required = opts.sections.required.has(section.key);
				const landed = produced.landed;
				if (opts.onMissingPermission === "warn" && !required && landed === 0) {
					io.annotate("warning", `${section.key}: skipped - ${error.detail}`);
					outcomes.push({
						key: section.key,
						status: "skipped",
						detail: [...before, error.detail],
						httpStatus: error.status
					});
					partial = true;
					continue;
				}
				const why = landed > 0 ? ` (${landed} request(s) landed before the denial, so this fails the run whatever the on-missing-permission policy)` : required ? " (listed in required-sections, so this fails the run)" : "";
				io.annotate("error", `${section.key}: ${landed > 0 ? "partially applied" : "not applied"}${why} - ${error.detail}`);
				outcomes.push({
					key: section.key,
					status: "failed",
					detail: [...before, error.detail],
					httpStatus: error.status
				});
				failed = true;
				continue;
			}
			const message = error instanceof Error ? error.message : String(error);
			const prefixed = message.startsWith(`${section.key}:`) ? message : `${section.key}: ${message}`;
			const annotated = produced.landed > 0 ? `${prefixed} (${produced.landed} request(s) landed before this failure, so the repository is partially applied)` : prefixed;
			io.annotate("error", annotated);
			outcomes.push({
				key: section.key,
				status: "failed",
				detail: [...before, annotated]
			});
			failed = true;
			continue;
		}
		for (const note of result.notes) io.annotate("notice", `${section.key}: ${note}`);
		if (result.check) {
			if (result.drift.length > 0) {
				drifted = true;
				for (const line of result.drift) io.log(`drift: ${line}`);
				outcomes.push({
					key: section.key,
					status: "drift",
					detail: result.drift
				});
			} else outcomes.push({
				key: section.key,
				status: "clean",
				detail: result.notes
			});
		} else {
			for (const line of result.changes) io.log(`${section.key}: ${line}`);
			outcomes.push({
				key: section.key,
				status: "applied",
				detail: result.changes.length > 0 ? result.changes : result.notes.length > 0 ? result.notes : ["no changes needed"]
			});
		}
	}
	const result = failed ? "failed" : check ? drifted ? "drift" : partial ? "partial" : "clean" : partial ? "partial" : "applied";
	return {
		repo: opts.repo.slug,
		result,
		outcomes,
		preflightDenied: []
	};
}
function worstOf(results, check) {
	for (const rank of REPO_RESULTS) if (results.some((r) => r.result === rank)) return rank;
	return check ? "clean" : "applied";
}
//#endregion
//#region src/engine/section-selection.ts
/**
* Which sections a run processes and which of them must fully apply. The
* pair is validated ONCE here: a required section outside a non-empty
* allowlist would let the run pass green having proven nothing about it,
* because the engine reports excluded sections without attempting them. The
* constructor is private and the fields are too, so neither a literal nor a
* spread of an existing selection typechecks as one (a spread drops private
* members): every selection the engine sees passed `of`, whether it came from
* the action's inputs or a library caller.
*/
var SectionSelection = class SectionSelection {
	onlyKeys;
	requiredKeys;
	/** The selection that processes every declared section and requires none. */
	static ALL = new SectionSelection(/* @__PURE__ */ new Set(), /* @__PURE__ */ new Set());
	constructor(onlyKeys, requiredKeys) {
		this.onlyKeys = onlyKeys;
		this.requiredKeys = requiredKeys;
	}
	/** The only public way in; a refusal names the required sections the allowlist excludes. */
	static of(input) {
		const only = new Set(input.only ?? []);
		const required = new Set(input.required ?? []);
		if (only.size > 0) {
			const excluded = [...required].filter((key) => !only.has(key));
			if (excluded.length > 0) return err({
				code: "required-sections-excluded",
				excluded
			});
		}
		return ok(new SectionSelection(only, required));
	}
	/** The allowlist; empty means every declared section is processed. */
	get only() {
		return this.onlyKeys;
	}
	/** The sections that must fully apply even under on-missing-permission: warn. */
	get required() {
		return this.requiredKeys;
	}
};
//#endregion
//#region src/problem.ts
/**
* The failures the run returns instead of throwing: config parsing, settings
* reading and validation, the layer fold, target resolution, and the flows'
* fatal paths. One union, discriminated on `code`, and the one renderer that
* words each member. A library caller branches on the code; the action
* renders at its edge, so its lines stay exactly what they were.
* Outside this union: the sections' API failures, which stay exceptions so
* the permission policy can classify them.
*/
/**
* The advice appended to a transient (non-permission) API failure: a network
* blip or a 5xx that survived the retries. One source for the discovery
* problems rendered here and multi.ts's remote-file read failure, so the "not
* a permission problem" wording cannot drift between them.
*/
const RERUN_ADVICE = "This is not a permission problem; re-run the workflow, and retry later if it persists";
/** Names as an error message lists them: each quoted, comma-separated. */
function quoteList(names) {
	return names.map((name) => `"${name}"`).join(", ");
}
const PAT_ADVICE = "Discovery needs a user PAT; the workflow GITHUB_TOKEN and GitHub App installation tokens cannot enumerate a user's repositories. List the target repositories explicitly in the \"repos\" input";
const PASSTHROUGH_ADVICE = "Fix these values in the settings file (only the named keys are validated; extra fields pass through, except in closed sections and strict nested objects like actions.cache, which reject unrecognized keys)";
function quote(value) {
	return JSON.stringify(String(value));
}
/** A value's kind for refusal prose: what it is, not what it contains. */
function describeShape(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	if (isPlainObject$1(value)) return "a mapping";
	if (typeof value === "object") return `a ${value.constructor?.name ?? "tagged"} value`;
	return `a ${typeof value}`;
}
function describeCentralFile(file) {
	switch (file.kind) {
		case "not-a-slug": return `${file.filePath} resolves to the target "${file.slug}", which is not a valid owner/name slug. Rename the file so <owner> and <name> contain only letters, digits, dots, underscores, and dashes`;
		case "duplicate": return `duplicate target ${file.slug}: defined by both ${file.first} and ${file.second}. Keep exactly one settings file per repository`;
		case "ownerless": return `cannot resolve ${file.files.join(", ")}: top-level repos-dir files use the current repository's owner, which is unknown outside GitHub Actions. Use the <owner>/<name>.yml layout instead`;
	}
}
function describeUnreadable(problem) {
	switch (problem.role) {
		case "settings-file": return `cannot read settings from ${problem.path}: ${problem.reason}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`;
		case "defaults-file": return `cannot read the defaults file ${problem.path}: ${problem.reason}. Check the "defaults-file" path and that the file is valid YAML`;
		case "layer": return `cannot read the settings layer ${problem.path}: ${problem.reason}. Check that every path in the "settings-file" input exists and is valid YAML`;
	}
}
function describeFiltersWithoutWildcard(problem) {
	const named = quoteList(problem.filters);
	switch (problem.targets) {
		case "single-repo": return `the discovery filter input(s) ${named} only apply to repos: "*" discovery, but this run is in single-repo mode. Set repos: "*" to discover repositories, or remove the filter input(s)`;
		case "explicit-repos": return `the discovery filter input(s) ${named} only apply when repos is "*", but the "repos" input lists explicit repositories. Set repos: "*", or remove the filter input(s)`;
		case "repos-dir": return `the discovery filter input(s) ${named} only apply to repos: "*" discovery, but targets come only from repos-dir files. Set repos: "*", or remove the filter input(s)`;
	}
}
function describeUnknownSectionInput(unknown, known) {
	const quoted = quoteList(unknown.names);
	return unknown.names.length === 1 ? `unknown section ${quoted} in the "${unknown.input}" input; it matches none of: ${known.join(", ")}. Fix the name in the workflow's input list` : `unknown sections ${quoted} in the "${unknown.input}" input; each matches none of: ${known.join(", ")}. Fix the names in the workflow's input list`;
}
function describeInvalidReposEntries(problem) {
	const parts = [];
	if (problem.invalid.length > 0) parts.push(`${quoteList(problem.invalid)} ${problem.invalid.length === 1 ? "is not an owner/name slug" : "are not owner/name slugs"} (use values like "octocat/hello-world", comma- or newline-separated)`);
	if (problem.duplicated.length > 0) parts.push(`${quoteList(problem.duplicated)} ${problem.duplicated.length === 1 ? "is" : "are"} listed more than once (keep exactly one entry per repository)`);
	const count = problem.invalid.length + problem.duplicated.length;
	return `the "repos" input has ${count} invalid entr${count === 1 ? "y" : "ies"}: ${parts.join("; ")}. Or use "*" alone to discover repositories`;
}
/**
* The ONE place a problem is worded. INVARIANT for the layer members: a
* message names the layer as the layer list names it, the site's key path, and
* the kind of problem - never a value from the document. mode: merge has no
* private-repos redaction context, so a value echoed there (a label name, a
* rule type, a mis-shaped section body) could land a private repository's
* settings in a public log. `actual` reaches the prose only through
* describeShape; the marker test in test/engine/layers.test.ts pins this.
*/
function describeProblem(problem) {
	switch (problem.code) {
		case "input-unsupported-value": {
			const values = problem.allowed.map((v) => v === problem.fallback ? `"${v}" (default)` : `"${v}"`);
			return `the "${problem.input}" input is "${problem.value}", which is not a supported ${problem.noun}. Set it to ${values.join(", ")}`;
		}
		case "input-unknown-sections": return problem.unknown.map((unknown) => describeUnknownSectionInput(unknown, problem.known)).join("; ");
		case "required-sections-excluded": {
			const one = problem.excluded.length === 1;
			const [noun, pronoun] = one ? ["entry", "it"] : ["entries", "them"];
			return `the "required-sections" ${noun} ${quoteList(problem.excluded)} ${one ? "is" : "are"} excluded by the "sections" allowlist, so the run would pass without ever attempting ${pronoun}. Add ${pronoun} to the "sections" input, or remove ${pronoun} from "required-sections"`;
		}
		case "input-report-key-unused": return `the "report-public-key" input only applies to private-report: artifact, but the channel is "${problem.channel}", so the key would never be used. Remove report-public-key, or set private-report: artifact`;
		case "input-report-key-missing": return "private-report: artifact needs a \"report-public-key\" input: the age recipient every report is encrypted to. Generate a keypair with \"age-keygen -o key.txt\", keep key.txt secret, and set report-public-key to the printed \"age1...\" recipient (safe to commit)";
		case "input-report-key-invalid": return `the "report-public-key" input is not a valid age recipient: ${problem.reason}. It must be an "age1..." public key from "age-keygen" (the recipient line, not the AGE-SECRET-KEY identity)`;
		case "input-rejected-in-merge": return `the ${quoteList(problem.inputs)} input(s) do not apply to mode: merge, which only folds the settings-file layers into merged-file: it never targets a repository, calls the GitHub API, delivers a report, or narrows the sections it writes. Remove the input(s), or move them to the apply or check step that runs the merged document`;
		case "input-merged-file-missing": return "mode: merge needs a \"merged-file\" input: the path the merged settings document is written to. Set it (for example .github/settings.merged.yml) and feed that path to a later apply or check step as its settings-file";
		case "input-settings-file-empty": return `the "settings-file" input is "${problem.value}", which lists no file. In mode: merge it is the ordered list of layers to fold, newline- or comma-separated, lowest first; name at least one settings file`;
		case "input-merge-only": return `the ${quoteList(problem.inputs)} input(s) only apply to mode: merge, but this run is in ${problem.mode} mode, so ${problem.inputs.length === 1 ? "it" : "they"} would never be used. Remove the input(s), or set mode: merge to fold settings files`;
		case "input-token-missing": return "cannot call the GitHub API: no token was provided. Set the \"token\" input on the action step (or export GITHUB_TOKEN)";
		case "input-report-without-redaction": return "the \"private-report\" input delivers reports only for redacted targets, but \"private-repos\" is \"show\", so nothing is redacted and no report would ever be sent. Set private-repos: redact, or set private-report: none";
		case "input-affiliation-unsupported": return `the "affiliation" input entry "${problem.entry}" is not a supported affiliation, so discovery cannot build the /user/repos query. Use a comma-separated list of ${quoteList(problem.allowed)}`;
		case "input-exclude-pattern-invalid": return `the "exclude" input pattern "${problem.pattern}" can never match an owner/name repository: a pattern takes at most one "/", with a non-empty glob on each side of it. Use "<name-glob>" or "<owner-glob>/<name-glob>", where "*" matches any characters`;
		case "input-repository-with-multi": return "the \"repository\" input cannot be combined with \"repos\" or \"repos-dir\"; multi-repo targets come from those inputs. Remove \"repository\", or remove the multi-repo inputs to stay in single-repo mode";
		case "input-settings-file-with-multi": return "the \"settings-file\" input cannot be combined with \"repos\" or \"repos-dir\": central targets are read from repos-dir files and remote targets from each repository's own .github/settings.yml. Remove the settings-file override";
		case "discovery-filters-without-wildcard": return describeFiltersWithoutWildcard(problem);
		case "input-defaults-file-without-multi": return "the \"defaults-file\" input only applies to multi-repo mode, but this run is in single-repo mode, so the defaults would never apply. Remove the input, or add \"repos\" or \"repos-dir\" to switch to multi-repo mode";
		case "input-settings-file-is-list": return `the "settings-file" input is "${problem.value}", which contains a list separator: ${problem.mode} mode reads exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file, or set mode: merge to fold the list into one document`;
		case "input-repository-not-slug": return `cannot target a repository: "${problem.value}" is not an owner/name slug. Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"`;
		case "settings-not-mapping": return `${problem.source} must be a YAML mapping of section names to settings, but its top level parsed as a ${problem.shape}. Rewrite the top level as "section: ..." keys`;
		case "settings-not-plain-mapping": return `${problem.source} must be a plain YAML mapping of section names to settings, but its top level parsed as another type (a YAML-tagged value like !!timestamp parses to a Date). Rewrite the top level as "section: ..." keys`;
		case "settings-unknown-sections": return `unknown top-level section(s) in ${problem.source}: ${problem.unknown.join(", ")} (known: ${problem.known.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`;
		case "settings-malformed-sections": return `${problem.source} has malformed section entries: ${problem.issues.join("; ")}. ${PASSTHROUGH_ADVICE}`;
		case "yaml-invalid": return problem.reason;
		case "settings-file-unreadable": return describeUnreadable(problem);
		case "layer-cycle": return `${layerSite(problem)} contains a reference cycle (a YAML anchor that includes itself); layers must be trees`;
		case "layer-wrong-shape": return `${layerSite(problem)} must be ${problem.expected}; got ${describeShape(problem.actual)}${problem.detail ?? ""}`;
		case "layer-bad-directive": return `${layerSite(problem)} must be "merge" or "replace"; got ${describeShape(problem.actual)}${typeof problem.actual === "string" ? " that is neither" : ""}`;
		case "layer-no-layering-key": return `${layerSite(problem)} has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive`;
		case "layer-no-key": return `${layerSite(problem)} carries no string ${quote(problem.keyField)}, which every entry needs to layer by`;
		case "layer-duplicate-key": return `${layerSite(problem)}[${problem.first}] and ${problem.site}[${problem.second}] both claim one ${problem.keyField}; each ${problem.keyField} belongs to one entry within a layer`;
		case "artifact-uploader-missing": return "private-report: artifact needs an artifact uploader, and none was supplied: the action supplies its own; a library caller passes one as the uploader argument, or picks another private-report channel";
		case "merged-file-is-layer": return `the "merged-file" input "${problem.mergedFile}" is layer ${problem.index + 1} of the "settings-file" list ("${problem.layer}"): the merge would overwrite that layer with the folded document, and the next run would fold the merged document as a layer. Write the merged document to a path outside the layer list`;
		case "merged-file-unwritable": return `cannot write the merged document to ${problem.path}: ${problem.reason}. Check that the "merged-file" input names a writable path`;
		case "no-targets": return problem.filteredOut > 0 ? `multi-repo mode found no targets: repos: "*" discovery found ${problem.filteredOut} ${problem.filteredOut === 1 ? "repository" : "repositories"}, but the discovery filters removed all of them (see the notices above). Relax the filter inputs, or add per-repo files to the repos-dir` : `multi-repo mode found no targets: repos-dir yielded no settings files and the "repos" input resolved to no repositories. Add per-repo files to the repos-dir, or list repositories in the "repos" input`;
		case "repo-slug-invalid": return `"${problem.value}" is not an owner/name repository slug (use a value like "octocat/hello-world")`;
		case "repos-input-wildcard-mixed": return "the \"repos\" input mixes \"*\" with explicit repositories. Use \"*\" alone to discover every repository the token owns, or list the repositories without it";
		case "repos-input-invalid-entries": return describeInvalidReposEntries(problem);
		case "repos-dir-missing": return `repos-dir "${problem.reposDir}" does not exist in the workspace, so there are no central settings files to read. Add an actions/checkout step before this action, or fix the repos-dir path`;
		case "repos-dir-unreadable": return `cannot read repos-dir "${problem.reposDir}": ${problem.reason}. Check that it is a readable directory of settings files`;
		case "repos-dir-invalid-files": return `repos-dir "${problem.reposDir}" has ${problem.files.length} invalid settings file(s):\n- ${problem.files.map(describeCentralFile).join("\n- ")}`;
		case "discovery-request-failed": return `cannot discover repositories for repos: "*": GET ${problem.path} failed: ${problem.status} ${problem.message}. ${problem.denied ? PAT_ADVICE : RERUN_ADVICE}`;
		case "discovery-transport-failed": return `cannot discover repositories for repos: "*": ${problem.reason}. ${RERUN_ADVICE}`;
		case "discovery-response-not-a-list": return `cannot discover repositories for repos: "*": GET ${problem.path} returned a JSON value that is not a list, so the response cannot be paginated. ${RERUN_ADVICE}`;
		case "age-recipient-invalid": return `not a valid age recipient: ${problem.reason}`;
	}
}
/** The `layer "<name>": <site>` prefix every layer refusal opens with. */
function layerSite(problem) {
	return `layer ${quote(problem.layer)}: ${problem.site}`;
}
//#endregion
//#region src/report/artifact-report.ts
/**
* The `artifact` private-report channel: the concatenated report document, age-encrypted to an operator-held
* recipient and uploaded on the (public) run, so access control is key possession.
*
* crypto      -> the `age-encryption` package (typage, by age's author); nothing here rolls its own
* the upload  -> a port the caller supplies (src/action/artifact.ts), so this module never touches the artifact service
*/
const ARTIFACT_NAME = "settings-as-code-private-report";
const ARTIFACT_FILE = "private-report.md.age";
/** For config parse: a malformed `report-public-key` is rejected before any API work. Accepts exactly what the age library accepts. */
function parseRecipient(recipient) {
	try {
		new Encrypter().addRecipient(recipient);
		return ok();
	} catch (error) {
		return err({
			code: "age-recipient-invalid",
			reason: error instanceof Error ? error.message : String(error)
		});
	}
}
/** Decrypt locally with `age -d -i key.txt private-report.md.age`. */
async function encryptReport(recipient, content) {
	const encrypter = new Encrypter();
	encrypter.addRecipient(recipient);
	return encrypter.encrypt(content);
}
/**
* Never throws: report delivery is auxiliary, so every failure is a warning and the run's result stays untouched. The
* messages describe the artifact service or the recipient, never the report content, which leaves this module only as ciphertext.
*/
async function deliverArtifactReport(uploader, document, recipient) {
	try {
		const ciphertext = await encryptReport(recipient, document);
		await uploader.upload(ARTIFACT_NAME, {
			name: ARTIFACT_FILE,
			data: ciphertext
		});
		return { uploaded: true };
	} catch (error) {
		return { warning: `could not upload the private report artifact: ${error instanceof Error ? error.message : String(error)}. Re-run the workflow, or set private-report: none if it persists` };
	}
}
//#endregion
//#region src/report/markdown.ts
/** Markdown building blocks shared by the private-report composer and the step summary; action-layer-free so the composer's independence holds. */
/** Backslashes FIRST: a bare backslash before an escaped pipe would read as an escaped backslash plus a live pipe and split the row. */
function markdownCell(text) {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n?|\n/g, " ");
}
//#endregion
//#region src/report/composer.ts
/** A fence longer than any backtick run inside the content, so a transcript line can never terminate the block early. */
function fenceFor(content) {
	const longest = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
	return "`".repeat(Math.max(3, longest + 1));
}
function transcriptLine(entry) {
	return entry.level === void 0 ? entry.line : `[${entry.level}] ${entry.line}`;
}
function composeReport(input) {
	const lines = [
		`# settings-as-code private report: ${input.target}`,
		"",
		"Full, unredacted report for this target. The public run redacts it; this document is its private mirror.",
		"",
		"| | |",
		"|---|---|",
		`| Target | ${markdownCell(input.target)} |`,
		`| Admin repository | ${markdownCell(input.adminRepo)} |`,
		`| Run | ${markdownCell(input.runUrl)} |`,
		`| Mode | ${markdownCell(input.mode)} |`,
		`| Result | ${markdownCell(input.result)} |`,
		`| Generated | ${markdownCell(input.timestamp)} |`,
		"",
		"## Sections",
		""
	];
	if (input.outcomes.length === 0) lines.push("No sections ran for this target.");
	else {
		lines.push("| Section | Status | Detail |", "|---|---|---|");
		for (const outcome of input.outcomes) {
			const detail = outcome.detail.map(markdownCell).join("<br>");
			lines.push(`| ${markdownCell(outcome.key)} | ${markdownCell(outcome.status)} | ${detail} |`);
		}
	}
	lines.push("", "## Transcript", "");
	if (input.transcript.length === 0) lines.push("No output was captured for this target.");
	else {
		const body = input.transcript.map(transcriptLine).join("\n");
		const fence = fenceFor(body);
		lines.push(fence, body, fence);
	}
	lines.push("");
	return lines.join("\n");
}
//#endregion
//#region src/report/issue-report.ts
/** The lookup key: one exact-titled report issue per repo, forever reused. */
const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
/** Makes the lookup one indexed request; the search API is eventually consistent and separately throttled, so it is never used. */
const MARKER_LABEL = "settings-as-code-report";
const MARKER_LABEL_CONFIG = {
	name: MARKER_LABEL,
	color: "0e2a47",
	description: "managed by settings-as-code private reporting - do not remove"
};
const ISSUE_REPORT_PERMISSION = { repo: ["issues"] };
const ISSUE_REPORT_ENDPOINTS = {
	list: {
		route: "GET /repos/{owner}/{repo}/issues",
		statuses: { 200: "the issue list (pull requests included)" }
	},
	create: {
		route: "POST /repos/{owner}/{repo}/issues",
		statuses: { 201: "report issue created" }
	},
	update: {
		route: "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
		statuses: { 200: "report issue updated" }
	},
	createLabel: {
		route: "POST /repos/{owner}/{repo}/labels",
		statuses: {
			201: "marker label created",
			422: "the marker label already exists"
		}
	}
};
/** Public-safe by construction: the HTTP status and generic advice only. The slug, the path, or the API message would land in public logs. */
function deliveryWarning(error) {
	const advice = isPermissionError(error) ? `To fix, ${grantFor(ISSUE_REPORT_PERMISSION)} for the target repository, or set private-report: none` : "Re-run the workflow, or set private-report: none if it persists";
	return { warning: `could not deliver the private report (HTTP ${error.status}). ${advice}` };
}
/** Under the same public-safety rule: `what` is a route template or a structural fact, never the expanded path or response content. */
function malformedWarning(what) {
	return { warning: `could not deliver the private report: ${what}. Check the "api-version" input, or set private-report: none` };
}
/**
* The issues list includes pull requests, so they are skipped. The label names ride along so a fallback-scan hit can
* reattach the stripped marker without clobbering human-added labels.
*/
function reportIssueIn(items) {
	for (const item of items) {
		if (typeof item !== "object" || item === null) continue;
		const issue = item;
		if (issue.pull_request !== void 0 || issue.title !== "[automated] settings-as-code: private settings report") continue;
		if (typeof issue.number !== "number") continue;
		const labels = Array.isArray(issue.labels) ? issue.labels.flatMap((label) => {
			if (typeof label === "string") return [label];
			const name = label?.name;
			return typeof name === "string" ? [name] : [];
		}) : [];
		return {
			number: issue.number,
			url: typeof issue.html_url === "string" ? issue.html_url : "",
			labels
		};
	}
	return null;
}
/**
* Walks the issue list page by page until the report issue turns up; `lookup` names the query in the malformed
* warning without exposing the expanded path.
*/
async function findReportIssue(api, ref, query, lookup) {
	const page = await paginate(api, expand(ISSUE_REPORT_ENDPOINTS.list, ref, void 0, query), void 0, (items) => reportIssueIn(items) !== null);
	if ("error" in page) return deliveryWarning(page.error);
	if ("malformed" in page) return malformedWarning(`${lookup} returned a non-list page`);
	return { found: reportIssueIn(page.items) };
}
/**
* For a human-stripped marker label: scans every issue by title, oldest first, and runs BEFORE any create so a
* stripped label never causes a duplicate. The creator is deliberately not a filter: a rotated PAT belongs to a
* different user, and a creator-scoped scan under it would miss the issue and open a second one.
*/
function fallbackScan(api, ref) {
	return findReportIssue(api, ref, {
		state: "all",
		sort: "created",
		direction: "asc"
	}, "the issue list (title scan)");
}
/**
* The label ensure-create and the title scan are skipped on purpose: both exist to keep a CREATE from duplicating, and
* this path never creates. The cost: a human-stripped marker leaves a stale open issue until the next needs-attention run.
*/
async function closeIfOpen(api, ref, body) {
	const listed = await findReportIssue(api, ref, {
		state: "open",
		labels: MARKER_LABEL
	}, "the open-issue lookup");
	if ("warning" in listed) return listed;
	const found = listed.found;
	if (!found) return { skipped: true };
	const closed = await api.tryRequest("PATCH", expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(found.number) }), {
		body,
		state: "closed"
	});
	if ("error" in closed) return deliveryWarning(closed.error);
	return { url: found.url };
}
async function deliver(api, repo, body, needsAttention, mode) {
	const ref = { repo };
	if (mode === "on-failure" && !needsAttention) return closeIfOpen(api, ref, body);
	const label = await api.tryRequest("POST", expand(ISSUE_REPORT_ENDPOINTS.createLabel, ref), {
		name: MARKER_LABEL_CONFIG.name,
		color: MARKER_LABEL_CONFIG.color,
		description: MARKER_LABEL_CONFIG.description
	});
	if ("error" in label && label.error.status !== 422) return deliveryWarning(label.error);
	const listed = await findReportIssue(api, ref, {
		state: "all",
		labels: MARKER_LABEL
	}, "the report-issue lookup");
	if ("warning" in listed) return listed;
	let found = listed.found;
	let relabel;
	if (!found) {
		const scanned = await fallbackScan(api, ref);
		if ("warning" in scanned) return scanned;
		found = scanned.found;
		if (found && !found.labels.includes("settings-as-code-report")) relabel = [...found.labels, MARKER_LABEL];
	}
	const state = needsAttention ? "open" : "closed";
	if (found) {
		const updated = await api.tryRequest("PATCH", expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(found.number) }), relabel ? {
			body,
			state,
			labels: relabel
		} : {
			body,
			state
		});
		if ("error" in updated) return deliveryWarning(updated.error);
		return { url: found.url };
	}
	const created = await api.tryRequest("POST", expand(ISSUE_REPORT_ENDPOINTS.create, ref), {
		title: ISSUE_TITLE,
		body,
		labels: [MARKER_LABEL]
	});
	if ("error" in created) return deliveryWarning(created.error);
	const issue = created.data;
	const url = typeof issue?.html_url === "string" ? issue.html_url : "";
	if (state === "closed") {
		if (typeof issue?.number !== "number") return malformedWarning("the report issue was created but carried no issue number, so it could not be closed for this healthy run");
		const closed = await api.tryRequest("PATCH", expand(ISSUE_REPORT_ENDPOINTS.update, ref, { issue_number: String(issue.number) }), { state });
		if ("error" in closed) return deliveryWarning(closed.error);
	}
	return { url };
}
/**
* Never throws: report delivery is auxiliary, so every failure comes back as a public-safe warning and the run's result
* stays untouched. `needsAttention` (failed, or check-mode drift: exactly what fails the run) opens the issue; a healthy
* run closes it, or under `on-failure` closes only a still-open one.
*/
async function deliverIssueReport(api, repo, body, needsAttention, mode) {
	try {
		return await deliver(api, repo, body, needsAttention, mode);
	} catch {
		return { warning: "could not deliver the private report: the request failed before an HTTP response arrived. Re-run the workflow, or set private-report: none if it persists" };
	}
}
/**
* A declared `labels` section under the delete policy would DELETE the marker label an earlier run's report delivery
* created, so the marker joins the declared set unless an entry already manages it. An entry renaming the marker AWAY
* would break the next run's lookup, so its `new_name` is stripped instead ("rename-refused").
*/
function injectMarkerLabel(settings) {
	const declaration = settings.labels;
	const wrapped = !Array.isArray(declaration);
	const labels = wrapped ? declaration !== void 0 && Array.isArray(declaration?.entries) ? declaration.entries : null : declaration;
	if (labels === null || !Array.isArray(labels)) return {
		settings,
		outcome: "unchanged"
	};
	const rebuild = (entries) => wrapped ? {
		...declaration,
		entries
	} : entries;
	const marker = nameKey(MARKER_LABEL);
	const renamesMarkerAway = (label) => nameKey(label.name) === marker && label.new_name !== void 0 && nameKey(label.new_name) !== marker;
	if (labels.some(renamesMarkerAway)) {
		const guarded = labels.map((label) => renamesMarkerAway(label) ? {
			...label,
			new_name: void 0
		} : label);
		return {
			settings: {
				...settings,
				labels: rebuild(guarded)
			},
			outcome: "rename-refused"
		};
	}
	if (labels.some((label) => nameKey(label.name) === marker || nameKey(label.new_name ?? label.name) === marker)) return {
		settings,
		outcome: "unchanged"
	};
	return {
		settings: {
			...settings,
			labels: rebuild([...labels, MARKER_LABEL_CONFIG])
		},
		outcome: "injected"
	};
}
//#endregion
//#region src/report/delivery.ts
/**
* A report reaches only a redacted target proven private or internal (flows/deliver.ts decides).
*
* `none`              -> delivers nothing
* `issue`             -> the full report on the private target repo itself, the one GitHub-ACL-private channel a public run has
* `issue-on-failure`  -> the same issue, created only when the run needs attention; recovery closes it with the healthy report
* `artifact`          -> the delivered reports as one age-encrypted artifact, for readers with the key but no GitHub access
*/
const PRIVATE_REPORT_CHANNELS = [
	"none",
	"issue",
	"issue-on-failure",
	"artifact"
];
function isIssueChannel(channel) {
	return channel === "issue" || channel === "issue-on-failure";
}
/**
* `on` is false when the channel is off or the target is not redacted. The notice is returned rather than emitted, so
* the caller can route it through the target's capturing sink.
*/
function applyMarkerInjection(settings, on) {
	if (!on) return { settings };
	const injection = injectMarkerLabel(settings);
	switch (injection.outcome) {
		case "rename-refused": return {
			settings: injection.settings,
			notice: `refused to rename the "${MARKER_LABEL}" marker label: private reporting reuses its issue by that exact name, so the rename was dropped`
		};
		case "unchanged": return { settings: injection.settings };
		case "injected": return {
			settings: injection.settings,
			notice: `added the "${MARKER_LABEL}" marker label to the managed labels so private reporting can reuse its issue; it is managed like any declared label`
		};
	}
}
/**
* The flows check for the artifact uploader before any API work (requireUploader); the throw here is the backstop for
* a caller that skipped that check, an invariant violation and not a run outcome.
*/
function openReportChannel(api, channel, meta, reportPublicKey, io, uploader) {
	switch (channel) {
		case "none": return null;
		case "issue": return issueChannel(api, meta, "always", io);
		case "issue-on-failure": return issueChannel(api, meta, "on-failure", io);
		case "artifact":
			if (uploader === void 0) throw new Error(describeProblem({ code: "artifact-uploader-missing" }));
			return artifactChannel(meta, reportPublicKey, io, uploader);
	}
}
/** The seal opens in full here: the readers are the target repository's own, or hold the artifact's decryption key. */
function composeTargetReport(meta, target) {
	const { slug, outcomes, transcript } = revealPrivate(target.detail);
	return composeReport({
		target: slug,
		adminRepo: meta.adminRepo,
		runUrl: meta.runUrl,
		mode: meta.mode,
		result: target.conclusion.result,
		timestamp: meta.timestamp,
		outcomes: outcomes.map((o) => ({
			key: o.key,
			status: o.status,
			detail: o.detail
		})),
		transcript
	});
}
function issueChannel(api, meta, mode, io) {
	return {
		async deliver(target) {
			if (target.repo === null) {
				io.annotate("warning", `${target.display}: could not deliver the private report: the target name is not an owner/name repository slug, so there is no repository to hold the report issue`);
				return;
			}
			const body = composeTargetReport(meta, target);
			const delivery = await deliverIssueReport(api, target.repo, body, target.conclusion.exitCode === 1, mode);
			if ("warning" in delivery) io.annotate("warning", `${target.display}: ${delivery.warning}`);
		},
		flush: async () => {}
	};
}
/**
* Reports accumulate under placeholder headings and leave as one document on flush. The channel never addresses the
* target repository, so it mirrors even a target whose slug failed to parse.
*/
function artifactChannel(meta, reportPublicKey, io, uploader) {
	const reports = [];
	return {
		async deliver(target) {
			reports.push(`<!-- ${target.display} -->\n\n${composeTargetReport(meta, target)}`);
		},
		async flush() {
			if (reports.length === 0) return;
			const delivery = await deliverArtifactReport(uploader, reports.join("\n\n"), reportPublicKey);
			if ("warning" in delivery) io.annotate("warning", delivery.warning);
		}
	};
}
//#endregion
//#region src/flows/redact.ts
const PRIVATE_REPOS_POLICIES = ["redact", "show"];
const REDACTED_NOTE = "details hidden: the repository is private or internal. Set private-repos: show to reveal them, or run the action inside that repository";
const REDACTED_DETAIL = "hidden (private repository)";
/**
* For a redacted target whose visibility could not be PROVEN private or internal, so the report was withheld (delivery
* fails closed the opposite way from redaction). Shared verbatim by both run flows: the cause and the fix are slug-free.
*/
const WITHHELD_REPORT_NOTICE = "visibility could not be verified (the repository-metadata probe failed or was inconclusive - typically the token cannot read the target repository), so the private report was withheld rather than risk delivering it to a public repository. Grant the token metadata read access and re-run; a transient API failure also leaves visibility unverified";
/**
* The key and status (closed enums, provably leak-free) survive; every detail value becomes the placeholder plus, on
* failed/skipped rows, the HTTP code.
*/
function redactOutcomes(outcomes) {
	return outcomes.map((o) => {
		const withCode = o.httpStatus !== void 0 ? `${REDACTED_DETAIL}, HTTP ${o.httpStatus}` : REDACTED_DETAIL;
		return {
			key: o.key,
			status: o.status,
			detail: [withCode]
		};
	});
}
function publicDetail(detail) {
	if (isPrivate(detail)) return {
		outcomes: redactOutcomes(revealPrivate(detail).outcomes),
		note: REDACTED_NOTE
	};
	return {
		outcomes: detail.outcomes.map((o) => ({
			key: o.key,
			status: o.status,
			detail: o.detail
		})),
		note: detail.note
	};
}
function toPublicView(target) {
	return {
		display: target.display,
		source: target.source,
		result: target.result,
		...publicDetail(target.detail)
	};
}
function isPrivateVisibility(visibility) {
	return visibility === "private" || visibility === "internal";
}
/**
* The single generic annotation a redacted target gets, closed values only: failed and drifted section keys, HTTP
* codes; a healthy run says nothing.
*/
function emitRedactedResult(io, display, result, detail) {
	const { outcomes } = revealPrivate(detail);
	if (result === "failed") {
		const failed = outcomes.filter((o) => o.status === "failed").map((o) => o.httpStatus !== void 0 ? `${o.key} (${o.httpStatus})` : o.key);
		const sections = failed.length > 0 ? ` - ${failed.join(", ")}` : "";
		io.annotate("error", `${display}: failed${sections}. ${REDACTED_NOTE}`);
		return;
	}
	if (result === "drift") {
		const drifted = outcomes.filter((o) => o.status === "drift").map((o) => o.key);
		const sections = drifted.length > 0 ? ` - ${drifted.join(", ")}` : "";
		io.annotate("warning", `${display}: drift${sections}. ${REDACTED_NOTE}`);
		return;
	}
	if (result === "skipped") io.annotate("notice", `${display}: skipped. ${REDACTED_NOTE}`);
}
const SHOW_EVERYTHING = {
	isRedacted: () => false,
	display: (slug) => slug,
	maskedSlugs: []
};
function planRedaction(policy, orderedTargetSlugs, extraPrivateSlugs, isPrivateSlug, selfSlug) {
	if (policy === "show") return SHOW_EVERYTHING;
	const self = selfSlug.toLowerCase();
	const placeholders = /* @__PURE__ */ new Map();
	const masked = /* @__PURE__ */ new Map();
	let n = 0;
	for (const slug of orderedTargetSlugs) {
		const key = slug.toLowerCase();
		if (key === self || !isPrivateSlug(slug) || placeholders.has(key)) continue;
		n += 1;
		placeholders.set(key, `private repository #${n}`);
		masked.set(key, slug);
	}
	for (const sealed of extraPrivateSlugs) {
		const slug = revealPrivate(sealed);
		const key = slug.toLowerCase();
		if (key === self || masked.has(key)) continue;
		masked.set(key, slug);
	}
	return {
		isRedacted: (slug) => placeholders.has(slug.toLowerCase()),
		display: (slug) => placeholders.get(slug.toLowerCase()) ?? slug,
		maskedSlugs: [...masked.values()]
	};
}
/**
* Lets nothing textual out: annotate/log are recorded for the private report, debug/summary/output are dropped (those
* surfaces are written from the public view), only the mask registry passes through.
*/
function capturingIo(io) {
	const captured = [];
	return {
		io: {
			annotate: (level, message) => captured.push({
				level,
				line: message
			}),
			log: (line) => captured.push({ line }),
			debug: () => {},
			summary: () => {},
			output: () => {},
			mask: io.mask,
			masked: io.masked
		},
		drain: () => [...captured]
	};
}
function publicChannel(io, slug, attributed) {
	return {
		display: slug,
		io: prefixedIo(io, attributed ? `${slug}: ` : ""),
		unprefixed: io,
		close: (outcomes, note) => ({
			slug,
			outcomes,
			note
		})
	};
}
function redactedChannel(io, slug, display) {
	const capture = capturingIo(io);
	return {
		display,
		io: capture.io,
		unprefixed: capture.io,
		close: (outcomes, note) => markPrivate({
			slug,
			outcomes,
			note,
			transcript: capture.drain()
		})
	};
}
/**
* A crash (a preflight write attempt naming its path, an engine bug) is the target's failure, spoken only through the
* channel's sink, so a redacted repository's text never reaches a top-level handler.
*/
async function attempt(channel, work, failed) {
	try {
		return await work();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		channel.io.annotate("error", message);
		return failed(message);
	}
}
function openTargetChannel(plan, io, slug) {
	return plan.isRedacted(slug) ? redactedChannel(io, slug, plan.display(slug)) : publicChannel(io, slug, true);
}
//#endregion
//#region src/flows/summary.ts
const STATUS_ICON = {
	applied: "white_check_mark",
	clean: "white_check_mark",
	drift: "warning",
	partial: "warning",
	skipped: "fast_forward",
	excluded: "fast_forward",
	failed: "x"
};
function outcomeRows(outcomes) {
	const rows = ["| Section | Status | Detail |", "|---|---|---|"];
	for (const outcome of outcomes) {
		const detail = outcome.detail.map(markdownCell).join("<br>") || "-";
		rows.push(`| ${outcome.key} | :${STATUS_ICON[outcome.status]}: ${outcome.status} | ${detail} |`);
	}
	return rows;
}
/** From the target's PUBLIC detail: statuses stay visible under redaction, the projection hides the cells. */
function writeSummary(io, view, mode, result) {
	const lines = [`## github-settings-as-code (${mode})`, ""];
	if (view.note !== void 0) lines.push(`:${STATUS_ICON[result]}: ${result} - ${markdownCell(view.note)}`, "");
	io.summary([...lines, ...outcomeRows(view.outcomes)].join("\n"));
}
function writeMergeSummary(io, layers, mergedFile) {
	const lines = [
		"## github-settings-as-code (merge)",
		"",
		"| Layer | Settings file |",
		"|---|---|",
		...layers.map((path, index) => `| ${index + 1} | ${markdownCell(path)} |`),
		"",
		`Merged document written to ${markdownCell(mergedFile)}.`
	];
	io.summary(lines.join("\n"));
}
function writeMultiSummary(io, views, mode) {
	const lines = [
		`## github-settings-as-code (${mode}, ${views.length} repositories)`,
		"",
		"| Repository | Source | Result |",
		"|---|---|---|"
	];
	for (const view of views) lines.push(`| ${markdownCell(view.display)} | ${view.source} | :${STATUS_ICON[view.result]}: ${view.result} |`);
	for (const view of views) {
		lines.push("", `### ${markdownCell(view.display)} (${view.result})`, "");
		if (view.note) lines.push(markdownCell(view.note), "");
		if (view.outcomes.length > 0) lines.push(...outcomeRows(view.outcomes));
	}
	io.summary(lines.join("\n"));
}
//#endregion
//#region src/flows/deliver.ts
/**
* Where every run ends. Each target closes its channel and delivers here, and the summary, outputs, and exit code are
* decided here, so the single- and multi-repo flows cannot drift in what they report.
*/
function failedTarget(message) {
	return {
		result: "failed",
		outcomes: [],
		note: message
	};
}
/** A failure before the engine ran; the rich message goes to the target's channel (public in the clear, captured when redacted). */
function targetFailure(channelIo, richMessage) {
	channelIo.annotate("error", richMessage);
	return failedTarget(richMessage);
}
/** A preflight denial refused to write anything; its one line goes through the channel and its note heads the target's otherwise empty summary. */
function engineOutcome(run, channelIo) {
	const denied = run.preflightDenied.length;
	if (denied === 0) return {
		result: run.result,
		outcomes: run.outcomes
	};
	channelIo.annotate("error", `preflight failed: the token cannot access ${denied} section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`);
	return {
		result: run.result,
		outcomes: run.outcomes,
		note: `preflight denied ${denied} section(s); nothing was applied to this repository`
	};
}
/**
* The one outcome predicate: the run exits 1 exactly when the worst target result is failed or a check-mode drift. A
* single target's report opens under the same rule.
*/
function runOutcome(results, check) {
	const result = worstOf([...results], check);
	return {
		result,
		exitCode: result === "failed" || check && result === "drift" ? 1 : 0
	};
}
/** Both flows check this before any API work; openReportChannel asserts the same rule as its backstop. */
function requireUploader(cfg, uploader) {
	return cfg.privateReport === "artifact" && uploader === void 0 ? err({ code: "artifact-uploader-missing" }) : ok();
}
/** The delivery is flushed even when `body` throws: the artifact channel uploads every accumulated report as ONE document there. */
async function withDelivery(run, body) {
	const { api, cfg, io, uploader } = run;
	const check = cfg.mode === "check";
	const meta = {
		adminRepo: cfg.selfSlug,
		runUrl: cfg.runUrl,
		mode: cfg.mode,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	};
	const reports = openReportChannel(api, cfg.privateReport, meta, cfg.reportPublicKey, io, uploader);
	const deliverable = (exposure) => reports !== null && exposure.kind === "redacted" && isPrivateVisibility(exposure.visibility);
	const delivery = { async target({ repo, channel, exposure }, work) {
		const outcome = await work(deliverable(exposure) && isIssueChannel(cfg.privateReport));
		const detail = channel.close(outcome.outcomes, outcome.note);
		if (isPrivate(detail)) {
			if (reports !== null && !deliverable(exposure)) io.annotate("notice", `${channel.display}: ${WITHHELD_REPORT_NOTICE}`);
			else if (reports !== null) await reports.deliver({
				repo,
				display: channel.display,
				conclusion: runOutcome([outcome], check),
				detail
			});
			emitRedactedResult(io, channel.display, outcome.result, detail);
		}
		return {
			result: outcome.result,
			display: channel.display,
			detail
		};
	} };
	try {
		return await body(delivery);
	} finally {
		await reports?.flush();
	}
}
/** The public view is projected first, so nothing below carries a redacted slug. */
function concludeRun(io, run) {
	if (run.kind === "single") {
		const view = publicDetail(run.target.detail);
		writeSummary(io, view, run.mode, run.target.result);
		return conclude(io, [{
			...view,
			result: run.target.result
		}], run.mode === "check");
	}
	const views = run.targets.map(toPublicView);
	writeMultiSummary(io, views, run.mode);
	io.output("repos-result", JSON.stringify(Object.fromEntries(views.map((v) => [v.display, {
		result: v.result,
		source: v.source,
		skippedSections: skippedSectionKeys(v.outcomes)
	}]))));
	return conclude(io, views, run.mode === "check");
}
/**
* A run that failed before any target ran gets a failed target's conclusion and no summary; the one place a fatal problem becomes text.
* `describe` is the action's wording unless the caller's face (the command line) words a remedy differently.
*/
function failRun(io, problem, describe = describeProblem) {
	const message = describe(problem);
	io.annotate("error", message);
	return conclude(io, [failedTarget(message)], false);
}
/** Not a RepoResult: a merge has no target, so it never enters worstOf and never appears beside the per-repo values. */
const MERGE_RESULT = "merged";
function concludeMerge(io, run) {
	writeMergeSummary(io, run.layers, run.mergedFile);
	io.log(`merged ${run.layers.length} layer(s) into ${run.mergedFile}`);
	io.output("skipped-sections", "");
	io.output("result", MERGE_RESULT);
	io.log(`result: ${MERGE_RESULT}`);
	return 0;
}
function conclude(io, results, check) {
	io.output("skipped-sections", [...new Set(results.flatMap((r) => skippedSectionKeys(r.outcomes)))].join(","));
	const { result, exitCode } = runOutcome(results, check);
	io.output("result", result);
	io.log(`result: ${result}`);
	return exitCode;
}
//#endregion
//#region src/github/repo-file.ts
/**
* A contents 404 is ambiguous (missing file, missing Contents grant, or a repo the token cannot see), so `missing` means
* PROVEN ABSENT, and `unproven` is distinct from both it and `error`.
*
*   contents 404 -> GET /repos (Metadata, readable by every fine-grained PAT) names the default branch
*                -> that branch's git ref is read, which needs Contents: read and succeeds whether or not the file exists
*                -> the token could have read the file, so it is missing
*
* A failed ref read leaves the proof inconclusive: a denied grant, or an empty repository whose branch has no commit.
*/
async function getRepoFile(api, slug, filePath) {
	const result = await api.tryRequest("GET", `/repos/${slug}/contents/${filePath}`, void 0, {
		accept: "application/vnd.github.raw+json",
		raw: true
	});
	if (!("error" in result)) return { content: String(result.data ?? "") };
	if (result.error.status !== 404) return { error: result.error };
	const repoProbe = await api.tryRequest("GET", `/repos/${slug}`);
	if ("error" in repoProbe) return { error: repoProbe.error };
	const defaultBranch = repoProbe.data?.default_branch;
	if (typeof defaultBranch !== "string" || defaultBranch === "") return { error: {
		status: 500,
		message: `the repository object names no default branch, so Contents access cannot be proven and ${filePath} cannot be fetched`,
		body: ""
	} };
	const ref = `heads/${defaultBranch}`;
	const refPath = defaultBranch.split("/").map(encodeURIComponent).join("/");
	const refProbe = await api.tryRequest("GET", `/repos/${slug}/git/ref/heads/${refPath}`);
	if (!("error" in refProbe)) return { missing: true };
	if (!(refProbe.error.status === 404 || refProbe.error.status === 403) || isRateLimitError(refProbe.error)) return { error: refProbe.error };
	return { unproven: `cannot prove ${filePath} is absent: reading the default branch ref ${ref} returned ${refProbe.error.status}. Grant the token Contents: read on this repository, or initialize its default branch; a repository whose file cannot be read never receives the defaults` };
}
//#endregion
//#region src/github/repo-visibility.ts
function createVisibilityResolver(api) {
	const cache = /* @__PURE__ */ new Map();
	return (slug) => {
		const key = slug.toLowerCase();
		let pending = cache.get(key);
		if (!pending) {
			pending = probe(api, slug);
			cache.set(key, pending);
		}
		return pending;
	};
}
async function probe(api, slug) {
	let result;
	try {
		result = await api.tryRequest("GET", `/repos/${slug}`, void 0, { redactTrace: true });
	} catch {
		return "unknown";
	}
	if ("error" in result) return "unknown";
	const repo = result.data;
	if (repo?.private === true) return repo.visibility === "internal" ? "internal" : "private";
	const visibility = repo?.visibility;
	if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
	if (repo?.private === false) return "public";
	return "unknown";
}
//#endregion
//#region src/flows/settings-read.ts
/**
* The one place settings YAML is parsed. The read problem carries the role the caller names the file by, because the
* right advice differs per source, and the document comes back `unknown`: only validateSettingsDoc mints ValidatedSettings.
*/
/**
* `logLevel: "error"` is load-bearing: at its default the parser reports a warning (an unresolved tag, an anchor ending
* in ":") on a SUCCESSFUL parse through process.emitWarning, quoting the offending source line with its values straight
* to stderr, which nothing here redacts. Empty and null documents become {}.
*
* "error"   -> warnings silent; a syntax error still throws into the error path
* "silent"  -> would also swallow the syntax errors
*/
function parseSettingsDoc(raw) {
	try {
		return ok(parse(raw, { logLevel: "error" }) ?? {});
	} catch (error) {
		return err({
			code: "yaml-invalid",
			reason: String(error)
		});
	}
}
function readSettingsFile(path, role) {
	const unreadable = (reason) => ({
		code: "settings-file-unreadable",
		role,
		path,
		reason
	});
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return err(unreadable(String(error)));
	}
	return parseSettingsDoc(raw).mapErr((parse) => unreadable(parse.reason));
}
//#endregion
//#region src/flows/multi.ts
/**
* Multi-repo orchestration; each target runs independently, and the `defaults-file` document is applied WHOLE to a
* target without a file, never merged into one that has. Under `private-repos: redact` a hidden target closes SEALED:
* the summary, outputs, and report reach it only through projections.
*
*   resolve targets -> resolve visibility -> plan redaction, mask every hidden slug
*   -> flush buffered central warnings -> run each target through its channel
*
* Before the mask step nothing is emitted that could name a target, except a fatal exit: its message and the flushed
* central warnings may name slugs the operator wrote into the workflow or the admin repo.
*/
/** The single source for the action.yml `settings-file` default, the multi-repo override guard in src/flows/inputs.ts, and the prose below. */
const DEFAULT_SETTINGS_FILE = ".github/settings.yml";
/** The channel is the only sink in scope, so a redacted target's text lands only in its report. */
async function processTarget(ctx) {
	const { api, target, defaults, cfg, injectMarker, channel } = ctx;
	const fail = (richMessage) => targetFailure(channel.io, richMessage);
	const run = async (settings, secretSource) => {
		const injected = applyMarkerInjection(settings, injectMarker);
		if (injected.notice) channel.io.annotate("notice", injected.notice);
		return engineOutcome(await runForRepo(api, {
			repo: ctx.repo,
			settings: injected.settings,
			mode: cfg.mode,
			onMissingPermission: cfg.onMissingPermission,
			sections: cfg.sections,
			secretSource
		}, channel.io), channel.io);
	};
	const read = await readTargetSettings(api, target);
	if ("error" in read) return fail(read.error);
	if ("missing" in read) {
		if (defaults === null) {
			channel.io.annotate("notice", `skipped - the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch. Add the file to manage it, or remove ${target.slug} from the "repos" input`);
			return {
				result: "skipped",
				outcomes: [],
				note: `no ${DEFAULT_SETTINGS_FILE} on the default branch`
			};
		}
		channel.io.annotate("notice", `applying the defaults file: the repository has no ${DEFAULT_SETTINGS_FILE} on its default branch`);
		return run(defaults, "operator");
	}
	const parsed = parseSettingsDoc(read.raw);
	if (parsed.isErr()) return fail(`cannot parse ${read.sourceLabel}: ${parsed.error.reason}. Fix the YAML in that file`);
	const validated = validateSettingsDoc(parsed.value, read.sourceLabel, cfg.sections.only, channel.unprefixed);
	if (validated.isErr()) return fail(describeProblem(validated.error));
	return run(validated.value, read.source);
}
/**
* Channel and exposure come from ONE redaction decision, so a redacted channel never travels with a shown exposure.
* Discovery's full_name is API data, so parseRepoSlug is checked here; a slug that fails it becomes the target's failure.
*/
function openTarget(plan, io, slug, visibilityOf) {
	return {
		repo: parseRepoSlug(slug).unwrapOr(null),
		channel: openTargetChannel(plan, io, slug),
		exposure: plan.isRedacted(slug) ? {
			kind: "redacted",
			visibility: visibilityOf(slug)
		} : { kind: "shown" }
	};
}
/**
* The document's provenance is decided here, with the document: a central file is operator-authored, a target's own
* file is target-authored, so its $NAME references are refused (a target must not route the operator's environment
* into itself). `missing` means a remote target is PROVEN to have no file; an absence that could not be proven is `error`.
*/
async function readTargetSettings(api, target) {
	if (target.source === "central") {
		const sourceLabel = target.filePath;
		try {
			return {
				raw: readFileSync(target.filePath, "utf8"),
				sourceLabel,
				source: "operator"
			};
		} catch (error) {
			return { error: `cannot read settings from ${sourceLabel}: ${String(error)}. Fix the file, or delete it to stop managing this repository` };
		}
	}
	const sourceLabel = `${target.slug}:${DEFAULT_SETTINGS_FILE}`;
	const file = await getRepoFile(api, target.slug, DEFAULT_SETTINGS_FILE);
	if ("missing" in file) return { missing: true };
	if ("unproven" in file) return { error: `${file.unproven}. To stop managing it instead, remove ${target.slug} from the "repos" input` };
	if ("error" in file) return { error: isPermissionError(file.error) ? `the token was denied reading ${sourceLabel}: ${file.error.status} ${file.error.message}. Grant the PAT access to this repository (Contents: read), or remove it from the "repos" input` : `reading ${sourceLabel} failed: ${file.error.status} ${file.error.message}. ${RERUN_ADVICE}` };
	return {
		raw: file.content,
		sourceLabel,
		source: "target"
	};
}
function runMulti(api, cfg, io, uploader) {
	const bufferedWarnings = [];
	let warningsFlushed = false;
	const flushWarnings = () => {
		if (warningsFlushed) return;
		warningsFlushed = true;
		for (const warning of bufferedWarnings) io.annotate("warning", warning);
	};
	const fail = (problem) => err(problem);
	return safeTry(async function* () {
		yield* requireUploader(cfg, uploader);
		let defaults = null;
		if (cfg.defaultsFile) defaults = yield* validateSettingsDoc(yield* readSettingsFile(cfg.defaultsFile, "defaults-file"), cfg.defaultsFile, cfg.sections.only, io);
		let central = [];
		if (cfg.reposDir) {
			const resolved = yield* resolveCentralTargets(cfg.reposDir, cfg.adminOwner);
			bufferedWarnings.push(...resolved.warnings);
			central = resolved.targets;
		}
		let remote = [];
		let filteredOutCount = 0;
		const skipGroups = [];
		const knownVisibility = /* @__PURE__ */ new Map();
		const filteredPrivateSlugs = [];
		if (cfg.reposInput) {
			const parsed = yield* parseReposInput(cfg.reposInput);
			let slugs = parsed.slugs;
			let origin = "the \"repos\" input";
			if (parsed.discover) {
				const discovered = yield* discoverRepos(api, cfg.discoveryFilters);
				for (const group of discovered.filtered) {
					skipGroups.push(group);
					filteredOutCount += group.repos.length;
					for (const repo of group.repos) if (repo.visibility !== "public") filteredPrivateSlugs.push(repo.slug);
				}
				for (const repo of discovered.repos) knownVisibility.set(repo.slug.toLowerCase(), repo.visibility);
				slugs = discovered.repos.map((repo) => repo.slug);
				origin = "repos: \"*\" discovery";
			} else if (cfg.discoveryFiltersSet.length > 0) return fail({
				code: "discovery-filters-without-wildcard",
				filters: cfg.discoveryFiltersSet,
				targets: "explicit-repos"
			});
			remote = slugs.map((slug) => ({
				slug,
				source: "remote",
				origin
			}));
		} else if (cfg.discoveryFiltersSet.length > 0) return fail({
			code: "discovery-filters-without-wildcard",
			filters: cfg.discoveryFiltersSet,
			targets: "repos-dir"
		});
		const redact = cfg.privateRepos === "redact";
		const self = cfg.selfSlug.toLowerCase();
		const resolveVisibility = createVisibilityResolver(api);
		const orderedSlugs = [...central, ...remote].map((t) => t.slug);
		const visibilityBySlug = /* @__PURE__ */ new Map();
		if (redact) for (const slug of orderedSlugs) {
			const key = slug.toLowerCase();
			if (visibilityBySlug.has(key)) continue;
			if (key === self) {
				visibilityBySlug.set(key, "public");
				continue;
			}
			const known = knownVisibility.get(key);
			visibilityBySlug.set(key, known ?? await resolveVisibility(slug));
		}
		const visibilityOf = (slug) => visibilityBySlug.get(slug.toLowerCase()) ?? "unknown";
		const plan = planRedaction(cfg.privateRepos, orderedSlugs, filteredPrivateSlugs, (slug) => visibilityOf(slug) !== "public", cfg.selfSlug);
		for (const slug of plan.maskedSlugs) io.mask(slug);
		flushWarnings();
		for (const group of skipGroups) io.annotate("notice", formatSkipNotice(group, redact));
		const targets = dedupeTargets(central, remote, (message) => io.annotate("notice", message), (slug) => plan.display(slug), (slug) => plan.isRedacted(slug));
		if (targets.length === 0) return fail({
			code: "no-targets",
			filteredOut: filteredOutCount
		});
		const results = await withDelivery({
			api,
			cfg,
			io,
			uploader
		}, async (delivery) => {
			const delivered = [];
			for (const target of targets) {
				const opened = openTarget(plan, io, target.slug, visibilityOf);
				const { channel, repo } = opened;
				const closed = await delivery.target(opened, async (injectMarker) => repo === null ? targetFailure(channel.io, `the repository name "${target.slug}" from ${target.origin} is not an owner/name slug, so it cannot be targeted`) : attempt(channel, () => processTarget({
					api,
					target,
					repo,
					defaults,
					cfg,
					injectMarker,
					channel
				}), failedTarget));
				delivered.push({
					source: target.source,
					...closed
				});
			}
			return delivered;
		});
		return ok(results);
	}).orTee(flushWarnings);
}
//#endregion
//#region src/flows/inputs.ts
/**
* parseConfig() validates every input read through a caller-supplied port (each problem names the input and the fix)
* into the RunConfig the run executes, so no execution code touches a raw input and a CLI reads the same declarations
* the action does.
*/
/** Default `private-repos`, pinned against action.yml by the contract test. */
const DEFAULT_PRIVATE_REPOS = "redact";
/**
* The single source the inputs reference page and action.yml are generated from (bun run build:action-docs), in their
* listing order; adding an input here is the whole declaration. A new mode's inputs go beside their mode's.
*/
const INPUT_DECLS = {
	token: {
		description: "Token used for the API calls. Most sections need a fine-grained PAT with Administration read/write on the repository - the default GITHUB_TOKEN can never hold that permission.",
		default: "${{ github.token }}",
		summary: "Token for the API calls (see [Token permissions](docs/reference/permissions.md))",
		shownDefault: "`github.token`"
	},
	repository: {
		description: "Target repository (owner/name). Defaults to the current repository. Single-repo mode only; cannot be combined with repos or repos-dir.",
		default: "",
		summary: "Target `owner/name` (single-repo mode only)",
		shownDefault: "current repo"
	},
	"settings-file": {
		description: "Path to the settings YAML file: exactly one in apply and check. In mode: merge, the ordered list of settings files to fold instead, newline- or comma-separated, lowest layer first. Newlines and commas are list separators in every mode, so a settings-file path can never contain a comma. Single-repo and merge modes only; multi-repo targets read repos-dir files or each repository's own .github/settings.yml, so overriding it alongside repos or repos-dir fails the run.",
		default: DEFAULT_SETTINGS_FILE,
		summary: "Settings file path (single-repo mode); in `mode: merge`, the ordered list of layers to fold, low to high",
		list: true
	},
	mode: {
		description: "apply (mutate), check (report drift, exit 1 on any), or merge (fold the settings-file layers into one document written to merged-file, with no token and no GitHub API call; merge reads only settings-file, merged-file, and layering, ignores token, and rejects every other input set to a non-default value, since each controls an apply or check run). check makes no settings changes, though a private report may still be delivered.",
		default: "apply",
		summary: "`apply` mutates; `check` reports drift and exits 1 on any, making no settings changes (a private report may still be delivered); `merge` folds the settings-file layers into merged-file without touching GitHub"
	},
	"merged-file": {
		description: "mode: merge only, and required there: the path the merged settings document is written to (parent directories are created). The file holds exactly what apply would run: every section validated, each section that takes an undeclared policy in its policy-wrapper form with the policy made explicit, the other sections in their own shape, and private underscore keys and the _layering directives dropped. Feed it to a later apply or check step as its settings-file. Must not name one of the settings-file layers (the merge would overwrite it). Fails when set in apply or check.",
		default: "",
		summary: "`mode: merge` only (required there): where the merged document is written, exactly what `apply` would run"
	},
	"on-missing-permission": {
		description: "fail (default) or warn. Under warn, sections the token cannot access are skipped with a warning and the run stays green (partial success).",
		default: "fail",
		summary: "`warn` skips sections the token cannot access (partial success)"
	},
	"required-sections": {
		description: "Comma-separated section names that must fully apply even under on-missing-permission: warn (minimum requirements). Every name must also be allowed by the \"sections\" input when that allowlist is set; a required section the allowlist excludes is rejected up front, because the run could never attempt it.",
		default: "",
		summary: "Sections that must fully apply even under `warn`",
		list: true
	},
	sections: {
		description: "Optional comma-separated allowlist of sections to process. apply and check only: mode: merge writes every section its layers declare, so the allowlist belongs on the step that runs the merged document and fails the merge when set.",
		default: "",
		summary: "Comma-separated allowlist of sections to process (apply and check only; rejected in `mode: merge`)",
		shownDefault: "(all declared)",
		list: true
	},
	"api-version": {
		description: "X-GitHub-Api-Version header value. Override to opt into a newer REST API version before this action defaults to it.",
		default: DEFAULT_API_VERSION,
		summary: "`X-GitHub-Api-Version` header; override to opt into a newer REST API version"
	},
	repos: {
		description: "Multi-repo remote mode: comma- or newline-separated owner/name targets, each applied from its own .github/settings.yml (default branch), or \"*\" alone to discover every repository the token's user owns, filterable via the visibility, archived, forks, exclude, topics, and affiliation inputs. Combinable with repos-dir; a repos-dir file for the same repository wins.",
		default: "",
		summary: "Multi-repo remote mode: `owner/name` list (comma/newline), or `*` to discover owned repos",
		list: true
	},
	"repos-dir": {
		description: "Multi-repo central mode: a directory in the checked-out admin repository holding per-repo settings files - <name>.yml (same owner as this repository) or <owner>/<name>.yml. Requires actions/checkout.",
		default: "",
		summary: "Multi-repo central mode: directory of per-repo settings files in this repo"
	},
	"defaults-file": {
		description: "YAML settings document applied to every multi-repo target that has no settings file of its own (a repos target without .github/settings.yml, which is otherwise skipped). A target with its own file is applied as written; the defaults are never merged into it. With repos: \"*\" every discovered repository without a settings file receives the defaults; run mode: check first. Multi-repo mode only; fails when set without repos or repos-dir.",
		default: "",
		summary: "YAML applied to every multi-repo target without a settings file (multi-repo mode only)"
	},
	layering: {
		description: "mode: merge only: merge (default) or replace, the run-wide default for how the keyed list sections (labels, rulesets) combine with the layers below them; a layer's own _layering directive, at its top level or on a section's {entries} wrapper, overrides it per file or per section. Every other list is replaced by the higher layer's. Fails when set in apply or check.",
		default: "",
		summary: "`mode: merge` only: `merge` unions the keyed list sections (labels, rulesets) by key across layers, `replace` lets the higher layer's list win; a layer's `_layering` overrides it",
		shownDefault: "`merge`"
	},
	"private-repos": {
		description: "redact (default) or show. Under redact, private and internal targets are hidden from this run's public logs, summary, and outputs: their slug becomes a \"private repository #N\" placeholder, live values and error bodies are replaced with \"hidden (private repository)\", and each slug is registered with the runner's secret masker. A target equal to GITHUB_REPOSITORY is never redacted. show reveals everything (today's behavior); only use it when the run's logs are not publicly readable.",
		default: DEFAULT_PRIVATE_REPOS,
		summary: "`redact` hides private and internal targets from public logs, summary, and outputs; `show` reveals them"
	},
	"private-report": {
		description: "none (default), issue, issue-on-failure, or artifact. Delivers the full unredacted report only for redacted targets the visibility probe proves private or internal (an unknown visibility is redacted but excluded from delivery). Under issue, each such target's report is delivered as a reused, marker-labelled issue on that target repository itself (the one GitHub-private channel a public run has): the body is replaced every run, and the issue is opened when the target fails or drifts and closed when it is healthy. issue-on-failure is the quiet variant: a failing or drifting target gets the same issue, but a healthy run only closes a still-open issue from a previous failure and otherwise writes nothing - no issue ever appears on a repository that never needed attention (though a declared labels section still creates the marker label, and a manually-removed marker label defers the close: the next failing run reattaches it, and the first healthy run after that closes the issue). Under artifact, those reports are concatenated, age-encrypted to report-public-key, and uploaded as one workflow artifact (settings-as-code-private-report) for readers who hold the key but no GitHub access to the targets; the artifact channel needs the Actions artifact service, so on GitHub Enterprise Server it warns and uploads nothing. Applies only to redacted targets, so it is rejected alongside private-repos: show. Report delivery writes even in mode: check, and its failure never changes the run's result.",
		default: "none",
		summary: "`issue` delivers each redacted target's full report to a reused issue on that target repository; `issue-on-failure` writes that issue only when the target fails or drifts, closing it once healthy; `artifact` uploads all reports as one age-encrypted workflow artifact; rejected with `private-repos: show`"
	},
	"report-public-key": {
		description: "The age recipient (an \"age1...\" public key) the artifact channel encrypts every report to; safe to commit in the workflow. Generate a keypair with \"age-keygen -o key.txt\", keep key.txt secret, and decrypt a downloaded artifact with \"age -d -i key.txt private-report.md.age\". Required when private-report is artifact and rejected otherwise.",
		default: "",
		summary: "The `age1...` recipient the `artifact` channel encrypts reports to; required with `private-report: artifact`, rejected otherwise"
	},
	visibility: {
		description: "Keeps only repositories of this visibility in repos: \"*\" discovery. One of all (default), public, private, or internal; internal is matched client-side (Enterprise only). Fails if set without repos: \"*\".",
		default: "",
		summary: "Discovery-only: keep `public`, `private`, or `internal` repositories",
		shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.visibility}\``
	},
	archived: {
		description: "Archived-repository policy for repos: \"*\" discovery. One of skip (default; settings writes fail on archived repositories), include, or only (mostly useful with mode: check). Fails if set without repos: \"*\".",
		default: "",
		summary: "Discovery-only: `skip`, `include`, or `only` archived repositories",
		shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.archived}\``
	},
	forks: {
		description: "Fork policy for repos: \"*\" discovery. One of include (default), exclude, or only. Fails if set without repos: \"*\".",
		default: "",
		summary: "Discovery-only: `include`, `exclude`, or `only` forks",
		shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.forks}\``
	},
	exclude: {
		description: "Comma- or newline-separated wildcard patterns removing repositories from repos: \"*\" discovery. \"*\" matches any characters; a pattern containing \"/\" matches the full owner/name, any other the name alone. Case-insensitive. Fails if set without repos: \"*\".",
		default: "",
		summary: "Discovery-only: `*` wildcard patterns (name, or `owner/name` if the pattern has a `/`) to drop",
		list: true
	},
	topics: {
		description: "Comma- or newline-separated topics; repos: \"*\" discovery keeps only repositories carrying at least one of them. Unrelated to the topics settings section. Fails if set without repos: \"*\".",
		default: "",
		summary: "Discovery-only: keep repositories carrying at least one listed topic",
		list: true
	},
	affiliation: {
		description: "Comma-separated affiliations for repos: \"*\" discovery, passed to the GitHub /user/repos listing. Any of owner, collaborator, organization_member; the list replaces the default (owner), so use owner,collaborator to widen rather than move discovery. Fails if set without repos: \"*\".",
		default: "",
		summary: "Discovery-only: `owner`, `collaborator`, `organization_member` (comma list)",
		shownDefault: `\`${DEFAULT_DISCOVERY_FILTERS.affiliation.join(",")}\``,
		list: true
	}
};
function inputs(read) {
	const value = (name) => read(name).trim();
	const orDefault = (name) => value(name) || INPUT_DECLS[name].default;
	return {
		value,
		orDefault,
		list: (name) => splitList(orDefault(name))
	};
}
const FILTER_INPUTS = [
	"visibility",
	"archived",
	"forks",
	"exclude",
	"topics",
	"affiliation"
];
function readEnum(input, name, allowed, fallback, noun) {
	const value = input.value(name) || fallback;
	const match = allowed.find((candidate) => candidate === value);
	if (match === void 0) return err({
		code: "input-unsupported-value",
		input: name,
		value,
		noun,
		allowed,
		fallback
	});
	return ok(match);
}
/** What separates the entries of a list input; a single path can never contain one. */
const LIST_SEPARATOR = /[\n,]/;
function splitList(value) {
	return value.split(LIST_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}
const MODES = [
	"apply",
	"check",
	"merge"
];
const LAYERINGS = ["merge", "replace"];
/**
* Their declared defaults are empty so "explicitly set" is detectable, as with the discovery filters; apply and check
* reject a set one instead of silently ignoring it.
*/
const MERGE_ONLY_INPUTS = ["merged-file", "layering"];
function readSectionSelection(input) {
	const names = ["required-sections", "sections"].map((name) => ({
		input: name,
		names: input.list(name)
	}));
	const knownSections = new Set(SECTION_KEYS);
	const unknown = names.map(({ input: name, names: listed }) => ({
		input: name,
		names: [...new Set(listed)].filter((entry) => !knownSections.has(entry))
	})).filter((entry) => entry.names.length > 0);
	if (unknown.length > 0) return err({
		code: "input-unknown-sections",
		unknown,
		known: SECTION_KEYS
	});
	const isSectionKey = (name) => knownSections.has(name);
	const [required = [], only = []] = names.map((entry) => entry.names.filter(isSectionKey));
	return SectionSelection.of({
		only,
		required
	});
}
/**
* The key is required exactly when the channel is `artifact` and rejected otherwise (set for another channel it would
* silently do nothing); it is parsed through the age library here so a malformed recipient fails before any API work.
*/
function resolveReportPublicKey(input, channel) {
	const key = input.value("report-public-key");
	if (channel !== "artifact") return key ? err({
		code: "input-report-key-unused",
		channel
	}) : ok("");
	if (!key) return err({ code: "input-report-key-missing" });
	return parseRecipient(key).map(() => key).mapErr((invalid) => ({
		code: "input-report-key-invalid",
		reason: invalid.reason
	}));
}
/**
* `token` is tolerated unread (a workflow commonly sets it on every step). Every declared input NOT listed here is an
* apply/check control, so the merge rejects it unless it holds its declared default, which the runner supplies whether
* or not the workflow set the input.
*/
const MERGE_INPUTS = [
	"mode",
	"settings-file",
	"merged-file",
	"layering",
	"token"
];
/**
* Derived from the declarations, so a future input is rejected by the merge until listed in MERGE_INPUTS; exported so
* the layering guide's table is pinned to the whole set.
*/
const MERGE_REJECTED_INPUTS = Object.keys(INPUT_DECLS).filter((name) => !MERGE_INPUTS.includes(name));
function parseMergeConfig(input) {
	return safeTry(function* () {
		const rejected = MERGE_REJECTED_INPUTS.filter((name) => {
			const value = input.value(name);
			return value !== "" && value !== INPUT_DECLS[name].default;
		});
		if (rejected.length > 0) return err({
			code: "input-rejected-in-merge",
			inputs: rejected
		});
		const mergedFile = input.value("merged-file");
		if (!mergedFile) return err({ code: "input-merged-file-missing" });
		const layering = yield* readEnum(input, "layering", LAYERINGS, "merge", "layering");
		const settingsFiles = input.list("settings-file");
		if (settingsFiles.length === 0) return err({
			code: "input-settings-file-empty",
			value: input.orDefault("settings-file")
		});
		return ok({
			kind: "merge",
			settingsFiles,
			mergedFile,
			layering
		});
	});
}
function parseConfig(read, env) {
	const input = inputs(read);
	return safeTry(function* () {
		const mode = yield* readEnum(input, "mode", MODES, INPUT_DECLS.mode.default, "mode");
		if (mode === "merge") return parseMergeConfig(input);
		const mergeOnly = MERGE_ONLY_INPUTS.filter((name) => input.value(name) !== "");
		if (mergeOnly.length > 0) return err({
			code: "input-merge-only",
			inputs: mergeOnly,
			mode
		});
		const token = input.value("token") || env.GITHUB_TOKEN || "";
		if (!token) return err({ code: "input-token-missing" });
		const githubRepository = env.GITHUB_REPOSITORY ?? "";
		const onMissingPermission = yield* readEnum(input, "on-missing-permission", ["fail", "warn"], INPUT_DECLS["on-missing-permission"].default, "policy");
		const sections = yield* readSectionSelection(input);
		const apiVersion = input.orDefault("api-version");
		const privateRepos = yield* readEnum(input, "private-repos", PRIVATE_REPOS_POLICIES, INPUT_DECLS["private-repos"].default, "private-repository policy");
		const privateReport = yield* readEnum(input, "private-report", PRIVATE_REPORT_CHANNELS, INPUT_DECLS["private-report"].default, "private-report channel");
		if (privateReport !== "none" && privateRepos === "show") return err({ code: "input-report-without-redaction" });
		const reportPublicKey = yield* resolveReportPublicKey(input, privateReport);
		const serverUrl = env.GITHUB_SERVER_URL ?? "";
		const runId = env.GITHUB_RUN_ID ?? "";
		const common = {
			token,
			mode,
			onMissingPermission,
			sections,
			apiVersion,
			privateRepos,
			privateReport,
			reportPublicKey,
			selfSlug: githubRepository,
			runUrl: serverUrl && githubRepository && runId ? `${serverUrl}/${githubRepository}/actions/runs/${runId}` : ""
		};
		const discoveryFiltersSet = FILTER_INPUTS.filter((name) => input.value(name) !== "");
		const visibility = yield* readEnum(input, "visibility", VISIBILITY_FILTERS, DEFAULT_DISCOVERY_FILTERS.visibility, "discovery filter");
		const archived = yield* readEnum(input, "archived", ARCHIVED_FILTERS, DEFAULT_DISCOVERY_FILTERS.archived, "archived-repository policy");
		const forks = yield* readEnum(input, "forks", FORKS_FILTERS, DEFAULT_DISCOVERY_FILTERS.forks, "fork policy");
		const affiliation = [...new Set(input.list("affiliation"))];
		const unsupported = affiliation.find((entry) => !AFFILIATIONS.includes(entry));
		if (unsupported !== void 0) return err({
			code: "input-affiliation-unsupported",
			entry: unsupported,
			allowed: AFFILIATIONS
		});
		const exclude = input.list("exclude");
		const unmatchable = exclude.find((pattern) => {
			const parts = pattern.split("/");
			return parts.length > 2 || parts.length === 2 && (!parts[0] || !parts[1]);
		});
		if (unmatchable !== void 0) return err({
			code: "input-exclude-pattern-invalid",
			pattern: unmatchable
		});
		const discoveryFilters = {
			visibility,
			archived,
			forks,
			affiliation: affiliation.length > 0 ? affiliation : DEFAULT_DISCOVERY_FILTERS.affiliation,
			topics: input.list("topics").map((topic) => topic.toLowerCase()),
			exclude
		};
		const reposInput = input.value("repos");
		const reposDir = input.value("repos-dir");
		const defaultsFile = input.value("defaults-file");
		const settingsFile = input.orDefault("settings-file");
		if (reposInput || reposDir) {
			if (input.value("repository")) return err({ code: "input-repository-with-multi" });
			if (settingsFile !== ".github/settings.yml") return err({ code: "input-settings-file-with-multi" });
			const adminOwner = githubRepository.split("/")[0] ?? "";
			return ok({
				...common,
				kind: "multi",
				reposDir,
				reposInput,
				defaultsFile,
				adminOwner,
				discoveryFilters,
				discoveryFiltersSet
			});
		}
		if (discoveryFiltersSet.length > 0) return err({
			code: "discovery-filters-without-wildcard",
			filters: discoveryFiltersSet,
			targets: "single-repo"
		});
		if (defaultsFile) return err({ code: "input-defaults-file-without-multi" });
		if (LIST_SEPARATOR.test(settingsFile)) return err({
			code: "input-settings-file-is-list",
			value: settingsFile,
			mode
		});
		const rawRepo = input.value("repository") || githubRepository;
		const repo = yield* parseRepoSlug(rawRepo).mapErr(() => ({
			code: "input-repository-not-slug",
			value: rawRepo
		}));
		return ok({
			...common,
			kind: "single",
			repo,
			settingsFile
		});
	});
}
//#endregion
//#region src/flows/layers.ts
/** The action-side boundary of mode: merge; nothing here reaches GitHub. */
function readLayerFiles(paths) {
	return paths.reduce((layers, path) => layers.andThen((read) => readSettingsFile(path, "layer").map((doc) => [...read, {
		name: path,
		doc
	}])), ok([]));
}
const KNOWN_SECTIONS = new Set(SECTION_KEYS);
/**
* The layer as the standalone validation sees it; neither marker below may reach the section shapes.
*
* null on a known section  -> dropped: an opt-out marker, not a setting to judge
* a wrapper's `_layering`  -> dropped: a directive the fold validates itself
* null on an unknown key   -> kept: it opts out of nothing, and only this per-layer pass can name the file that misspelled it
*/
function standaloneView(doc) {
	const stripped = stripNulls(doc);
	if (!isPlainObject$1(doc) || !isPlainObject$1(stripped)) return stripped;
	for (const [key, value] of Object.entries(doc)) if (value === null && !KNOWN_SECTIONS.has(key)) stripped[key] = null;
	for (const key of UNDECLARED_POLICY_SECTIONS) {
		const value = stripped[key];
		if (isPlainObject$1(value)) delete value._layering;
	}
	return stripped;
}
/**
* A merge has no `sections` allowlist: the merged document is applied later by a step whose allowlist this run cannot
* know, so an unknown top-level section is an error naming the layer, as in an apply.
*/
const NO_ALLOWLIST$1 = /* @__PURE__ */ new Set();
/** A layer must be a valid document before it may contribute, so the merge can never complete a broken declaration into a valid one. */
function foldLayers(layers, sourceLabel, layering, io) {
	return Result.combine(layers.map((layer) => validateSettingsDoc(standaloneView(layer.doc), layer.name, NO_ALLOWLIST$1, io))).andThen(() => mergeLayers(layers, { layering })).andThen((merged) => validateSettingsDoc(merged.settings, sourceLabel, NO_ALLOWLIST$1, io).map((settings) => ({
		settings,
		notices: merged.notices
	})));
}
//#endregion
//#region src/flows/library.ts
const UNNAMED_SOURCE = "the settings document";
const NO_ALLOWLIST = /* @__PURE__ */ new Set();
function validateSettings(doc, options = {}) {
	const collected = collectingIo();
	return validateSettingsDoc(doc, options.source ?? UNNAMED_SOURCE, options.sections ?? NO_ALLOWLIST, collected.io).map((settings) => ({
		settings,
		warnings: collected.lines.map((entry) => entry.line)
	}));
}
async function runMode(client, opts, mode, io) {
	const collected = collectingIo();
	return {
		...await runForRepo(client, {
			...opts,
			mode
		}, io ?? collected.io),
		log: io === void 0 ? collected.lines : []
	};
}
function checkRepository(client, opts, io) {
	return runMode(client, opts, "check", io);
}
function applyRepository(client, opts, io) {
	return runMode(client, opts, "apply", io);
}
/** The merged document exactly as mode: merge writes it to merged-file. */
function renderMergedYaml(settings) {
	return stringify(settings);
}
//#endregion
//#region src/flows/merge.ts
/**
* The mode: merge run flow. The written document is exactly what a later apply or check runs from that path; nothing
* here touches GitHub, so the flow takes no client and needs no token.
*/
const MERGED_LABEL = "the merged settings document";
/**
* Paths are compared resolved, so "./a.yml" and "a.yml" collide. Guarded beside the write: the next run would fold the
* merged document as if it were a layer.
*/
function mergedFileCollision(cfg) {
	const mergedPath = resolve(cfg.mergedFile);
	const index = cfg.settingsFiles.findIndex((layer) => resolve(layer) === mergedPath);
	const layer = cfg.settingsFiles[index];
	return layer === void 0 ? ok() : err({
		code: "merged-file-is-layer",
		mergedFile: cfg.mergedFile,
		index,
		layer
	});
}
function runMerge(cfg, io) {
	return mergedFileCollision(cfg).andThen(() => readLayerFiles(cfg.settingsFiles)).andThen((layers) => foldLayers(layers, MERGED_LABEL, cfg.layering, io)).andThen((folded) => {
		for (const notice of folded.notices) io.annotate("notice", describeOptOut(notice));
		try {
			mkdirSync(dirname(cfg.mergedFile), { recursive: true });
			writeFileSync(cfg.mergedFile, renderMergedYaml(folded.settings));
		} catch (error) {
			return err({
				code: "merged-file-unwritable",
				path: cfg.mergedFile,
				reason: String(error)
			});
		}
		return ok({
			layers: cfg.settingsFiles,
			mergedFile: cfg.mergedFile
		});
	});
}
//#endregion
//#region src/flows/single.ts
/**
* The single-repo run flow. The file is operator-authored, so its read, parse, and validation errors name only the local
* path and never redact; only the engine's output and the fail/preflight annotations can carry the target's state, so
* those go through the target's channel, which captures them when the target is a different, non-public repository.
*/
/** Redaction fails closed: the target is hidden unless the probe proves it public (the self repository and the `show` policy skip the probe). */
async function openSingleRepoChannel(api, cfg, io) {
	const shown = () => ({
		channel: publicChannel(io, cfg.repo.slug, false),
		exposure: { kind: "shown" }
	});
	if (cfg.privateRepos !== "redact") return shown();
	if (cfg.repo.slug.toLowerCase() === cfg.selfSlug.toLowerCase()) return shown();
	const visibility = await createVisibilityResolver(api)(cfg.repo.slug);
	if (visibility === "public") return shown();
	io.mask(cfg.repo.slug);
	return {
		channel: redactedChannel(io, cfg.repo.slug, "private repository"),
		exposure: {
			kind: "redacted",
			visibility
		}
	};
}
function runSingle(api, cfg, io, uploader) {
	return requireUploader(cfg, uploader).andThen(() => readSettingsFile(cfg.settingsFile, "settings-file")).andThen((doc) => validateSettingsDoc(doc, cfg.settingsFile, cfg.sections.only, io)).asyncAndThen((settings) => ResultAsync.fromSafePromise(runTarget(api, cfg, io, settings, uploader)));
}
async function runTarget(api, cfg, io, settings, uploader) {
	const opened = await openSingleRepoChannel(api, cfg, io);
	const { channel } = opened;
	return withDelivery({
		api,
		cfg,
		io,
		uploader
	}, (delivery) => delivery.target({
		repo: cfg.repo,
		...opened
	}, (injectsMarker) => {
		const injected = applyMarkerInjection(settings, injectsMarker);
		if (injected.notice) channel.io.annotate("notice", injected.notice);
		return attempt(channel, async () => engineOutcome(await runForRepo(api, {
			repo: cfg.repo,
			settings: injected.settings,
			mode: cfg.mode,
			onMissingPermission: cfg.onMissingPermission,
			sections: cfg.sections
		}, channel.io), channel.io), failedTarget);
	}));
}
//#endregion
export { stripNulls as $, toPublicView as A, prefixedIo as At, parseRecipient as B, concludeMerge as C, discoverRepos as Ct, capturingIo as D, isRateLimitError as Dt, PRIVATE_REPOS_POLICIES as E, isPermissionError as Et, MARKER_LABEL as F, parseRepoSlug as Ft, REPO_RESULTS as G, describeProblem as H, MARKER_LABEL_CONFIG as I, skippedSectionKeys as J, preflightProbe as K, composeReport as L, applyMarkerInjection as M, silentIo as Mt, openReportChannel as N, resolveCentralTargets as Nt, planRedaction as O, collectingIo as Ot, ISSUE_TITLE as P, dedupeTargets as Pt, mergeLayers as Q, deliverArtifactReport as R, MERGE_RESULT as S, VISIBILITY_FILTERS as St, failRun as T, GithubApi as Tt, quoteList as U, RERUN_ADVICE as V, SectionSelection as W, worstOf as X, validateSettingsDoc as Y, describeOptOut as Z, runMulti as _, parseReposInput as _t, renderMergedYaml as a, readGating as at, createVisibilityResolver as b, DEFAULT_DISCOVERY_FILTERS as bt, readLayerFiles as c, writeGatedReads as ct, INPUT_DECLS as d, endpointPath as dt, SECTIONS as et, MERGE_INPUTS as f, DOCUMENT_DIRECTIVE_KEYS as ft, DEFAULT_SETTINGS_FILE as g, UNDECLARED_POLICY_SECTIONS as gt, parseConfig as h, SettingsFile as ht, checkRepository as i, denialPosture as it, PRIVATE_REPORT_CHANNELS as j, redactRanges as jt, publicDetail as k, maskRegistry as kt, DEFAULT_PRIVATE_REPOS as l, grantFor as lt, MODES as m, SECTION_KEYS as mt, runMerge as n, allGraphqlOps as nt, validateSettings as o, sectionGrant as ot, MERGE_REJECTED_INPUTS as p, PROBOT_PARITY_KEYS as pt, runForRepo as q, applyRepository as r, sectionModule as rt, foldLayers as s, sectionOperations as st, runSingle as t, allEndpoints as tt, FILTER_INPUTS as u, endpointMethod as ut, parseSettingsDoc as v, AFFILIATIONS as vt, concludeRun as w, DEFAULT_API_VERSION as wt, getRepoFile as x, FORKS_FILTERS as xt, readSettingsFile as y, ARCHIVED_FILTERS as yt, encryptReport as z };
