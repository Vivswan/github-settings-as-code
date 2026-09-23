#!/usr/bin/env node
import { Ft as countNoun, Kt as redactRanges, N as failRun, Rt as GitHubApi, S as writeReplacing, St as sectionGrant, Wt as maskRegistry, Z as skippedSectionKeys, a as RENDER_INPUTS, c as SNAPSHOT_INPUTS, d as parseConfig, et as describeProblem, f as parseSnapshotFileConfig, k as readSettingsFile, l as SNAPSHOT_ONLY_INPUTS, o as RENDER_ONLY_INPUTS, p as snapshotFileDestination, r as INPUT_DECLS, st as SECTIONS } from "./inputs-iptFyZKl.js";
import { a as snapshotRepository, o as validateSettings, s as executeRun } from "./src-DEZES5t1.js";
import { appendFileSync, existsSync } from "node:fs";
import { ResultAsync, err } from "neverthrow";
import { randomUUID } from "node:crypto";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { EOL } from "node:os";
import { Writable } from "node:stream";
import { LogLevels, createConsola } from "consola";
//#region src/cli/actions.ts
/**
* The runner as the CLI's second face: a gsac step under GitHub Actions speaks
* the runner's workflow commands and files, so the runner sees what the action
* step gives it. Written without @actions/core, which the CLI does not carry;
* test/cli/actions.test.ts pins every form against the action's Io.
*/
/** The runner's files as it sets them; an empty value is unset, as @actions/core reads it. */
function runnerFile(value) {
	return value === void 0 || value === "" ? void 0 : value;
}
/** The runner the process reports to: one when GITHUB_ACTIONS is "true", none for a terminal. */
function actionsRunner(env) {
	if (env.GITHUB_ACTIONS !== "true") return;
	return {
		outputFile: runnerFile(env.GITHUB_OUTPUT),
		summaryFile: runnerFile(env.GITHUB_STEP_SUMMARY)
	};
}
/** One `::name::message` line with the runner's data escaping (%, CR, LF), as @actions/core issues it. */
function workflowCommand(name, message) {
	return `::${name}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}${EOL}`;
}
/** One GITHUB_OUTPUT record in the heredoc form the runner reads, with the fresh delimiter @actions/core mints per record. */
function outputRecord(name, value) {
	const delimiter = `ghadelimiter_${randomUUID()}`;
	return `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`;
}
//#endregion
//#region src/cli/commands.ts
/**
* What the file-only subcommands and init render for the program to print;
* check, apply, render, and snapshot run through the library's executor from
* the program.
*/
/** The failed envelope of a file-only command: the problem's text, beside the file when one was named. */
function failedEnvelope(message, file) {
	return {
		result: "failed",
		...file === void 0 ? {} : { file },
		problem: message
	};
}
/** The section modules a validated document declares, in execution order. */
function declaredSections(settings) {
	return SECTIONS.filter((section) => settings[section.key] !== void 0);
}
/** Read and validate one settings file; the warnings go to `io`, the problem is the error. */
function readValidated(file, io) {
	return readSettingsFile(file, "settings-file").andThen((doc) => validateSettings(doc, {
		source: file,
		io
	})).map(({ settings }) => settings);
}
/** `validate <file>`: the schema verdict alone, no token and no API call. */
function validateFile(file, io) {
	return readValidated(file, io).match((settings) => {
		const sections = declaredSections(settings).map((section) => section.key);
		return {
			code: 0,
			lines: [`${file} is valid: ${countNoun(sections.length, "section", "sections")} declared (${sections.join(", ")})`],
			json: {
				result: "valid",
				file,
				sections
			}
		};
	}, (problem) => {
		const message = describeProblem(problem);
		io.annotate("error", message);
		return {
			code: 1,
			lines: [],
			json: failedEnvelope(message, file)
		};
	});
}
/** The PAT grant each section a document declares needs, from the section declarations, as lines and as an object. */
function grantTable(settings, bold) {
	const grants = declaredSections(settings).map((section) => [section.key, sectionGrant(section)]);
	return {
		sections: grants.map(([key]) => key),
		lines: grants.map(([key, grant]) => `${bold(key)}: ${grant}`),
		json: Object.fromEntries(grants)
	};
}
/** `permissions <file>`: the PAT grant each declared section needs, from the section declarations. */
function permissionsFor(file, io, bold) {
	return readValidated(file, io).match((settings) => {
		const { lines, json } = grantTable(settings, bold);
		return {
			code: 0,
			lines,
			json: {
				result: "valid",
				file,
				grant: json
			}
		};
	}, (problem) => {
		const message = describeProblem(problem);
		io.annotate("error", message);
		return {
			code: 1,
			lines: [],
			json: failedEnvelope(message, file)
		};
	});
}
//#endregion
//#region src/cli/init.ts
/**
* `init`: adoption in one command. Snapshot one repository into the settings
* file apply and check read (the one destination mode: snapshot refuses, since
* here that file is the point), refuse to replace a file that already exists
* unless --force, then print the PAT grant the written sections need. A
* command-line command alone: no action mode reaches it, so its config and its
* own problems live here beside the library's rather than in RunConfig and
* Problem.
*/
/** The init flags are the snapshot inputs of one repository with settings-file as the destination, so every problem is the library's. */
function parseInitConfig(read, force, env) {
	return parseSnapshotFileConfig(read, env).map((cfg) => ({
		kind: "init",
		token: cfg.token,
		apiVersion: cfg.apiVersion,
		repo: cfg.repo,
		settingsFile: cfg.snapshotFile,
		sections: cfg.sections,
		onMissingPermission: cfg.onMissingPermission,
		force
	}));
}
/** The wording for every problem init can end in: its own here, the library's through the one renderer. */
function describeInitProblem(problem) {
	switch (problem.code) {
		case "init-settings-file-exists": return `${problem.settingsFile} already exists: init writes the starting settings file and does not replace the one you author. Pass --force to replace it, or --settings-file <path> to write elsewhere`;
		case "init-settings-file-unwritable": return `cannot write the settings file ${problem.settingsFile}: ${problem.reason}. Check that --settings-file names a writable path`;
		case "init-snapshot-failed": return `the snapshot of ${problem.repository} failed, so ${problem.settingsFile} was not written; the errors above name the section and the fix`;
		case "init-empty-document": {
			const why = problem.reasons.filter(([, keys]) => keys.length > 0).map(([label, keys]) => `${label}: ${keys.join(", ")}`).join("; ");
			return `the snapshot of ${problem.repository} declares no section (${why}), so ${problem.settingsFile} was not written. Choose sections init can read back, or drop --sections to read every section`;
		}
		default: return describeProblem(problem);
	}
}
/** `file` is the settings file the command was told (or defaulted to); only a test that renders no command omits it. */
function failInit(io, problem, file) {
	const message = describeInitProblem(problem);
	io.annotate("error", message);
	return {
		code: 1,
		lines: [],
		json: failedEnvelope(message, file)
	};
}
function writeSettingsFile(cfg, yaml) {
	return writeReplacing(cfg.settingsFile, yaml).mapErr((reason) => ({
		code: "init-settings-file-unwritable",
		settingsFile: cfg.settingsFile,
		reason
	}));
}
/** The outcome keys in one status, for the lines that name them. */
function keysWith(report, ...statuses) {
	return report.outcomes.filter((o) => statuses.includes(o.status)).map((o) => o.key);
}
/** The existence check comes first so a refusal costs no API call. */
function runInit(cfg, io, host, bold) {
	if (!cfg.force && existsSync(cfg.settingsFile)) return Promise.resolve(failInit(io, {
		code: "init-settings-file-exists",
		settingsFile: cfg.settingsFile
	}, cfg.settingsFile));
	const api = host.createClient(cfg.token, io, cfg.apiVersion);
	return ResultAsync.fromSafePromise(snapshotRepository(api, cfg.repo, {
		sections: cfg.sections,
		onMissingPermission: cfg.onMissingPermission,
		io
	})).andThen((report) => {
		if (report.result === "failed") return err({
			code: "init-snapshot-failed",
			repository: cfg.repo.slug,
			settingsFile: cfg.settingsFile
		});
		const grant = grantTable(report.settings, bold);
		const unsupported = keysWith(report, "unsupported");
		const skipped = skippedSectionKeys(report.outcomes);
		if (grant.sections.length === 0) return err({
			code: "init-empty-document",
			repository: cfg.repo.slug,
			settingsFile: cfg.settingsFile,
			reasons: [
				["cannot be read back", unsupported],
				["skipped", skipped],
				["nothing exists on the repository", keysWith(report, "snapshot")]
			]
		});
		return writeSettingsFile(cfg, report.yaml).map(() => {
			return {
				code: 0,
				lines: [
					`${cfg.settingsFile} written from ${cfg.repo.slug}: ${countNoun(grant.sections.length, "section", "sections")} declared (${grant.sections.join(", ")})`,
					...unsupported.length === 0 ? [] : [`not read back: ${unsupported.join(", ")} (the file's header says why; declare them by hand to manage them)`],
					...skipped.length === 0 ? [] : [`skipped: ${skipped.join(", ")} (the file omits them; the warnings above say why)`],
					"Token permissions the file needs:",
					...grant.lines.map((line) => `  ${line}`)
				],
				json: {
					result: report.result,
					file: cfg.settingsFile,
					repository: cfg.repo.slug,
					"skipped-sections": skipped,
					grant: grant.json
				}
			};
		});
	}).match((rendered) => rendered, (problem) => failInit(io, problem, cfg.settingsFile));
}
//#endregion
//#region src/cli/inputs.ts
/**
* The CLI's read port over commander: every flag is one INPUT_DECLS entry
* spelled `--<name> <value>`, so the help text and the action's inputs
* reference come from one declaration. The subcommand is the `mode` input
* and `--token` is a program-level flag; every other input is a flag of the
* subcommands whose mode reads it. parseConfig validates the values; nothing
* here does.
*/
/** Declaration order is the help order, as on the inputs reference page. */
const INPUT_NAMES = Object.keys(INPUT_DECLS);
/** The two inputs that are not subcommand flags: the mode is the subcommand, the token is global. */
const PROGRAM_INPUTS = ["mode", "token"];
/**
* Inputs no subcommand exposes: the artifact report channel needs the Actions
* artifact service, which a terminal has no upload for, so its key has no use.
*/
const CLI_UNSUPPORTED_INPUTS = ["report-public-key"];
/** The flags a mode's subcommand takes: the inputs its mode reads, in declaration order. */
function inputsForMode(mode) {
	const hidden = [...PROGRAM_INPUTS, ...CLI_UNSUPPORTED_INPUTS];
	const modeOnly = [...RENDER_ONLY_INPUTS, ...SNAPSHOT_ONLY_INPUTS];
	const reads = (name) => {
		switch (mode) {
			case "render": return RENDER_INPUTS.includes(name);
			case "snapshot": return SNAPSHOT_INPUTS.includes(name);
			case "apply":
			case "check": return !modeOnly.includes(name);
		}
	};
	return INPUT_NAMES.filter((name) => !hidden.includes(name) && reads(name));
}
/** A mode's subcommand: its flags are the inputs the mode reads. */
function modeSubcommand(mode) {
	return {
		flags: new Set(inputsForMode(mode)),
		mode
	};
}
/**
* The init subcommand: the snapshot inputs of one repository, with
* settings-file as the destination in place of snapshot-file. No mode runs
* it, so the clauses restricted to modes leave its help.
*/
const INIT_SUBCOMMAND = {
	flags: /* @__PURE__ */ new Set([
		"repository",
		"settings-file",
		"on-missing-permission",
		"sections",
		"api-version"
	]),
	mode: null
};
/** init's flags in declaration order, the order the help keeps. */
const INIT_INPUTS = INPUT_NAMES.filter((name) => INIT_SUBCOMMAND.flags.has(name));
/**
* init's one reworded flag: the declaration describes the file apply and check
* READ, and init WRITES it; every other init flag keeps its declared text.
*/
const INIT_SETTINGS_FILE_DESCRIPTION = "Where the settings document is written: the file apply and check read. One path; an existing file is kept unless --force is passed.";
/** `text` as the declaration spells it; a reworded declaration fails here rather than leave the help stale. */
function declared(input, text) {
	if (!INPUT_DECLS[input].description.includes(text)) throw new Error(`BUG: the ${input} input's description no longer says "${text}"; reword the CLI's clause with it`);
	return text;
}
const MULTI_REPO_FLAGS = ["repos", "repos-dir"];
const CLAUSES = [
	{
		input: "repository",
		text: declared("repository", " Single-repo mode only; cannot be combined with repos or repos-dir."),
		flags: MULTI_REPO_FLAGS
	},
	{
		input: "settings-file",
		text: declared("settings-file", " Single-repo and render modes only; multi-repo targets read repos-dir files or each repository's own .github/settings.yml, so overriding it alongside repos or repos-dir fails the run."),
		flags: MULTI_REPO_FLAGS
	},
	{
		input: "snapshot-dir",
		text: declared("snapshot-dir", "; defaults-file does not apply"),
		flags: ["defaults-file"]
	},
	{
		input: "sections",
		text: declared("sections", " apply, check, and snapshot only: mode: render writes every section its layers declare, so the allowlist belongs on the step that runs the rendered document and fails the render when set."),
		modes: [
			"apply",
			"check",
			"snapshot"
		]
	},
	{
		input: "private-report",
		text: declared("private-report", " Under artifact, those reports are concatenated, age-encrypted to report-public-key, and uploaded as one workflow artifact (settings-as-code-private-report) for readers who hold the key but no GitHub access to the targets; the artifact channel needs the Actions artifact service, so on GitHub Enterprise Server it warns and uploads nothing."),
		flags: ["report-public-key"]
	},
	{
		input: "private-report",
		text: declared("private-report", "issue, issue-on-failure, or artifact."),
		replacement: "issue, or issue-on-failure.",
		flags: ["report-public-key"]
	}
];
function meets(subcommand, clause) {
	const flags = (clause.flags ?? []).every((flag) => subcommand.flags.has(flag));
	const mode = clause.modes === void 0 || subcommand.mode !== null && clause.modes.includes(subcommand.mode);
	return flags && mode;
}
/** The sentence the action's `repository` description spends on a default a terminal never has. */
const ACTIONS_DEFAULT_SENTENCE = declared("repository", "Defaults to the current repository.");
/**
* A flag's help text under `subcommand`: the declaration's, minus the clauses
* about flags and modes the subcommand lacks, and reworded where it assumes
* the Actions runner.
*/
function inputDescription(name, subcommand) {
	let description = INPUT_DECLS[name].description;
	for (const clause of CLAUSES) if (clause.input === name && !meets(subcommand, clause)) description = description.replace(clause.text, clause.replacement ?? "");
	if (name === "repository") {
		const unless = MULTI_REPO_FLAGS.every((flag) => subcommand.flags.has(flag)) ? " unless repos or repos-dir is set" : "";
		description = description.replace(ACTIONS_DEFAULT_SENTENCE, `Required${unless} (inside GitHub Actions, GITHUB_REPOSITORY supplies it).`);
	}
	return description;
}
/** Whether the declaration is a list; read through InputDecl since only the list members carry the field. */
function isList(name) {
	return INPUT_DECLS[name].list === true;
}
/** A repeated list flag accumulates as a newline-separated list, the form parseConfig splits. */
function accumulate(value, previous) {
	return previous === void 0 ? value : `${previous}\n${value}`;
}
/** A repeated single-value flag is refused: joined, it would form a value the action cannot receive. */
function once(flag) {
	return (value, previous) => {
		if (previous !== void 0) throw new InvalidArgumentError(`--${flag} takes one value and was given more than once`);
		return value;
	};
}
/**
* The commander option for one input under `subcommand`: `--<name> <value>`,
* repeatable when the declaration is a list; `description` replaces the
* declaration's where the subcommand reads the input for another purpose.
*/
function inputOption(name, subcommand, description = inputDescription(name, subcommand)) {
	const parse = isList(name) ? accumulate : once(name);
	return new Option(`--${name} <value>`, description).argParser(parse);
}
/** Commander's attribute for each flag (camelCase of the name), read from commander itself. */
const ATTRIBUTE = Object.fromEntries(INPUT_NAMES.map((name) => [name, new Option(`--${name} <value>`).attributeName()]));
/** A flag value as the runner would hand it over: trimmed, as @actions/core trims every input. */
function inputValue(value) {
	return typeof value === "string" ? value.trim() : "";
}
/**
* The read port for a subcommand: `mode` is the subcommand, every other
* input is its parsed flag, empty when unset, so parseConfig sees exactly
* what the action's runner would hand it.
*/
function argvReader(mode, values) {
	return (name) => name === "mode" ? mode : inputValue(values[ATTRIBUTE[name]]);
}
/**
* Every value `--token` carries in `argv`, in both spellings commander
* accepts, as the reader would read it. Read before parsing, so the token is
* masked before the parser can echo it in a message of its own.
*/
function tokenValues(argv) {
	const values = [];
	argv.forEach((argument, index) => {
		if (argument === "--token") values.push(inputValue(argv[index + 1]));
		else if (argument.startsWith("--token=")) values.push(inputValue(argument.slice(8)));
	});
	return values.filter((value) => value !== "");
}
//#endregion
//#region src/cli/io.ts
/**
* The CLI's output boundary and its Io. No runner masks for a terminal, so
* every writer, the parser included, goes through maskedStreams(). Under a
* GitHub Actions runner the same Io speaks the runner's commands and files
* beside that redaction, so a gsac step and the action step read alike.
*/
/** A chunk that is already final, a workflow command: its name must survive a masked value spelled like it. */
var Verbatim = class {
	text;
	constructor(text) {
		this.text = text;
	}
};
/** A stream that redacts each chunk before handing it to `target`; one queue, so no chunk overtakes another. */
var RedactingStream = class extends Writable {
	target;
	redact;
	constructor(target, redact) {
		super({ objectMode: true });
		this.target = target;
		this.redact = redact;
	}
	_write(chunk, _encoding, callback) {
		const text = chunk instanceof Verbatim ? chunk.text : this.redact(String(chunk));
		if (this.target.write(text)) callback();
		else this.target.once("drain", callback);
	}
};
/**
* Every write to the returned streams is redacted; register a value before
* anything can print it. One registry serves the parser, the Io, and the
* file-only commands alike, so no writer can bypass it. The runner's commands
* are the two writes redaction never touches whole: the add-mask command must
* carry the value, and a masked value spelled like a command name ("error")
* must not turn any command into `::***::`.
*/
function maskedStreams(streams, runner) {
	const registry = maskRegistry(runner === void 0 ? () => {} : (value) => command(workflowCommand("add-mask", value)));
	const redact = (text) => redactRanges(text, registry.masked());
	const stdout = new RedactingStream(streams.stdout, redact);
	/** A finished command line, queued behind the redacted writes before it. */
	function command(line) {
		stdout.write(new Verbatim(line));
	}
	return {
		stdout,
		stderr: new RedactingStream(streams.stderr, redact),
		redact,
		runner: runner === void 0 ? void 0 : {
			...runner,
			command: (name, message) => command(workflowCommand(name, redact(message)))
		},
		...registry
	};
}
/** The consola type each annotation level logs as; consola gates them by level. */
const CONSOLA_TYPE = {
	notice: "info",
	warning: "warn",
	error: "error"
};
/** The label a consola type prints under, in the action's annotation words. */
const LABEL = {
	info: {
		label: "notice",
		paint: (colors) => colors.blue
	},
	warn: {
		label: "warning",
		paint: (colors) => colors.yellow
	},
	error: {
		label: "error",
		paint: (colors) => colors.red
	},
	debug: {
		label: "debug",
		paint: (colors) => colors.dim
	}
};
/**
* How each output reads inside the --json envelope: the action's outputs are strings (a comma list, a JSON document),
* and a JSON envelope carries the value itself, never a string a reader would parse again.
*/
const JSON_OUTPUT = {
	result: (value) => value,
	"skipped-sections": (value) => value === "" ? [] : value.split(","),
	"repos-result": (value) => JSON.parse(value)
};
function cliIo(options) {
	const { streams } = options;
	const colors = pc.createColors(options.colors);
	const reporter = { log(logObj) {
		const meta = LABEL[logObj.type];
		const text = logObj.args.map(String).join(" ");
		const prefix = meta === void 0 ? "" : `${meta.paint(colors)(meta.label)}: `;
		streams.stderr.write(`${prefix}${text}\n`);
	} };
	const level = options.verbose ? LogLevels.debug : LogLevels.info;
	const consola = createConsola({
		level,
		reporters: [reporter],
		throttle: 0
	});
	const logStream = options.json ? streams.stderr : streams.stdout;
	const { runner } = streams;
	const summaryFile = options.summaryFile ?? runner?.summaryFile;
	const outputs = /* @__PURE__ */ new Map();
	return {
		io: {
			annotate: runner === void 0 ? (level, message) => consola[CONSOLA_TYPE[level]](message) : (level, message) => runner.command(level, message),
			log: (line) => logStream.write(`${line}\n`),
			debug: (line) => consola.debug(line),
			summary: (markdown) => {
				if (summaryFile !== void 0) appendFileSync(summaryFile, `${streams.redact(markdown)}\n`);
			},
			output: (name, value) => {
				outputs.set(name, value);
				if (runner?.outputFile !== void 0) appendFileSync(runner.outputFile, outputRecord(name, value));
			},
			mask: streams.mask,
			masked: streams.masked
		},
		flush: (problem) => {
			if (options.json) {
				const envelope = Object.fromEntries([...outputs].map(([name, value]) => [name, JSON_OUTPUT[name](value)]));
				streams.stdout.write(`${JSON.stringify(problem === void 0 ? envelope : {
					...envelope,
					problem
				})}\n`);
				return;
			}
			for (const [name, value] of outputs) streams.stdout.write(`${name}=${value}\n`);
		}
	};
}
//#endregion
//#region src/cli/program.ts
/**
* The command tree: check, apply, render, and snapshot mirror the action's modes with
* INPUT_DECLS as their flags; init snapshots one repository into the settings
* file; validate and permissions read a file alone. `--token`, `--json`,
* `--summary`, and `--verbose` are global. main() runs argv to its exit code
* without touching the process.
*/
const DESCRIPTION = {
	check: "Report drift between a settings file and the live repository; exits 1 on any drift",
	apply: "Apply a settings file to the repository",
	render: "Fold an ordered list of settings files into one rendered document, with no token and no API call",
	snapshot: "Write a repository's live settings as a settings file, or one file per multi-repo target under a directory",
	init: "Start managing a repository: write its live settings to the settings file (.github/settings.yml unless --settings-file says otherwise) and print the PAT grant that file needs",
	validate: "Validate a settings file against the schema; no token, no API call",
	permissions: "Print the PAT grant each section a settings file declares needs"
};
/** The subcommands that run the engine or the render, each under its mode. */
const MODE_COMMANDS = {
	check: "check",
	apply: "apply",
	render: "render",
	snapshot: "snapshot"
};
/** The production host: process.env and the real client. */
function processHost() {
	return {
		env: process.env,
		createClient: (token, io, apiVersion) => new GitHubApi({
			token,
			io,
			apiVersion
		})
	};
}
/** A terminal has no Actions artifact service, so the artifact report channel is refused at the parse. */
const CLI_CAPABILITIES = { artifactUpload: false };
/**
* The whole command tree, wired to `options`; the exit code lands in the
* returned holder. The environment's token is masked here, before any writer
* exists; the argv token is main()'s to register, before the parse.
*/
function buildProgram(options) {
	const { host, streams } = options;
	const colors = options.colors ?? pc.isColorSupported;
	const paint = pc.createColors(colors);
	const execute = options.execute ?? ((cfg, io) => executeRun(cfg, {
		io,
		createClient: (token, io, apiVersion) => host.createClient(token, io, apiVersion)
	}));
	const executeInit = options.executeInit ?? ((cfg, io) => runInit(cfg, io, host, paint.bold));
	const envToken = host.env.GITHUB_TOKEN?.trim();
	if (envToken !== void 0 && envToken !== "") streams.mask(envToken);
	let exitCode = 0;
	const program = new Command().name("github-settings-as-code").description("Apply, check, render, and validate declarative GitHub repository settings (also installed as gsac)").addOption(new Option("--token <value>", `${INPUT_DECLS.token.description} Falls back to GITHUB_TOKEN.`).argParser(once("token"))).option("--json", "Print the outputs as one JSON object on stdout; log lines move to stderr").addOption(new Option("--summary <file>", "Append the run's markdown summary to this file (under GitHub Actions, the step summary when absent)").argParser(once("summary"))).option("--verbose", "Show the debug trace on stderr").exitOverride().configureOutput({
		writeOut: (text) => streams.stdout.write(text),
		writeErr: (text) => streams.stderr.write(text)
	});
	const openIo = (globals) => cliIo({
		streams,
		json: globals.json === true,
		verbose: globals.verbose === true,
		summaryFile: globals.summary,
		colors
	});
	/** Print a file-only command's result the way `--json` asks. */
	const present = (rendered, globals) => {
		if (globals.json === true) {
			streams.stdout.write(`${JSON.stringify(rendered.json)}\n`);
			return;
		}
		for (const line of rendered.lines) streams.stdout.write(`${line}\n`);
	};
	for (const [name, mode] of Object.entries(MODE_COMMANDS)) {
		const command = program.command(name).description(DESCRIPTION[name]);
		const subcommand = modeSubcommand(mode);
		for (const input of subcommand.flags) command.addOption(inputOption(input, subcommand));
		command.action(async function() {
			const values = this.optsWithGlobals();
			const { io, flush } = openIo(values);
			const read = argvReader(mode, values);
			let fatal;
			exitCode = await parseConfig(read, host.env, CLI_CAPABILITIES).match(async (cfg) => {
				const end = await execute(cfg, io);
				fatal = end.fatal === void 0 ? void 0 : describeProblem(end.fatal);
				return end.exitCode;
			}, async (problem) => {
				fatal = describeProblem(problem);
				return failRun(io, problem);
			});
			flush(fatal);
		});
	}
	const init = program.command("init").description(DESCRIPTION.init);
	for (const input of INIT_INPUTS) init.addOption(input === "settings-file" ? inputOption(input, INIT_SUBCOMMAND, INIT_SETTINGS_FILE_DESCRIPTION) : inputOption(input, INIT_SUBCOMMAND));
	init.option("--force", "Replace the settings file when it already exists; without it, init refuses").action(async function() {
		const values = this.optsWithGlobals();
		const { io } = openIo(values);
		const read = argvReader("snapshot", values);
		const rendered = await parseInitConfig(read, values.force === true, host.env).match((cfg) => executeInit(cfg, io), async (problem) => failInit(io, problem, snapshotFileDestination(read)));
		present(rendered, values);
		exitCode = rendered.code;
	});
	program.command("validate").description(DESCRIPTION.validate).argument("<file>", "the settings file to validate").action(function(file) {
		const globals = this.optsWithGlobals();
		const { io } = openIo(globals);
		const rendered = validateFile(file, io);
		present(rendered, globals);
		exitCode = rendered.code;
	});
	program.command("permissions").description(DESCRIPTION.permissions).argument("<file>", "the settings file whose sections decide the grant").action(function(file) {
		const globals = this.optsWithGlobals();
		const { io } = openIo(globals);
		const rendered = permissionsFor(file, io, paint.bold);
		present(rendered, globals);
		exitCode = rendered.code;
	});
	return {
		program,
		exitCode: () => exitCode
	};
}
/**
* Run `argv` (the full process.argv shape) to its exit code; every line, a crash's included, is masked. Under --json a
* failure the parser or a crash ends in prints the same failed envelope a run prints, so stdout is always one object.
* Whether the run reports to a GitHub Actions runner is decided here, once, from the host's environment.
*/
async function main(argv, options) {
	const streams = maskedStreams(options.streams, actionsRunner(options.host.env));
	for (const token of tokenValues(argv)) streams.mask(token);
	const { program, exitCode } = buildProgram({
		...options,
		streams
	});
	const terminator = argv.indexOf("--");
	const optionTokens = argv.slice(0, terminator === -1 ? argv.length : terminator);
	const failedJson = (message) => {
		if (program.opts().json === true || optionTokens.includes("--json")) streams.stdout.write(`${JSON.stringify(failedEnvelope(message))}\n`);
	};
	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (error instanceof CommanderError) {
			if (error.exitCode !== 0) failedJson(error.code === "commander.help" ? "no subcommand was given; the usage above lists them" : error.message.replace(/^error: /, ""));
			return error.exitCode;
		}
		const globals = program.opts();
		const verbose = globals.verbose === true;
		const message = `github-settings-as-code stopped unexpectedly: ${verbose && error instanceof Error && error.stack ? error.stack : String(error)}. ${verbose ? "The stack above is the report: if it recurs, file a bug with it attached" : "Re-run with --verbose for the stack; if it recurs, file a bug with that output attached"}`;
		cliIo({
			streams,
			json: globals.json === true,
			verbose,
			colors: options.colors ?? pc.isColorSupported
		}).io.annotate("error", message);
		failedJson(message);
		return 1;
	}
	return exitCode();
}
//#endregion
//#region src/cli.ts
/**
* The bin entry (lib/pkg/cli.js is built from this file, shebang kept):
* run the command line and map its return code to the process exit code.
* Everything else lives in src/cli/.
*/
const streams = {
	stdout: process.stdout,
	stderr: process.stderr
};
process.exitCode = await main(process.argv, {
	host: processHost(),
	streams
});
//#endregion
export {};
