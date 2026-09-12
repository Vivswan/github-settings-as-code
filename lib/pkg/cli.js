#!/usr/bin/env node
import { C as concludeMerge, H as describeProblem, T as failRun, Tt as GithubApi, _ as runMulti, d as INPUT_DECLS, et as SECTIONS, f as MERGE_INPUTS, h as parseConfig, j as PRIVATE_REPORT_CHANNELS, jt as redactRanges, kt as maskRegistry, n as runMerge, o as validateSettings, ot as sectionGrant, t as runSingle, w as concludeRun, y as readSettingsFile } from "./src-B7PQ0zSZ.js";
import { appendFileSync } from "node:fs";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { Writable } from "node:stream";
import { LogLevels, createConsola } from "consola";
//#region src/cli/commands.ts
/**
* What each subcommand does once its inputs are parsed: the engine and merge
* runs end exactly where the action's do (concludeRun, concludeMerge,
* failRun), so the exit codes and the outputs are the action's; the two
* file-only commands render a result for the program to print.
*/
/** Run a parsed config to its conclusion; the CLI has no artifact uploader, so that channel fails loudly. */
async function runConfig(cfg, io, host) {
	if (cfg.kind === "merge") return runMerge(cfg, io).match((merged) => concludeMerge(io, merged), (problem) => failRun(io, problem));
	const api = host.createClient(cfg.token, io, cfg.apiVersion);
	if (cfg.kind === "multi") return runMulti(api, cfg, io).match((targets) => concludeRun(io, {
		kind: "multi",
		mode: cfg.mode,
		targets
	}), (problem) => failRun(io, problem));
	return runSingle(api, cfg, io).match((target) => concludeRun(io, {
		kind: "single",
		mode: cfg.mode,
		target
	}), (problem) => failRun(io, problem));
}
/** The section modules a validated document declares, in execution order. */
function declaredSections(settings) {
	return SECTIONS.filter((section) => settings[section.key] !== void 0);
}
/** Read and validate one settings file; the warnings go to `io`, the problem is the error. */
function readValidated(file, io) {
	return readSettingsFile(file, "settings-file").andThen((doc) => validateSettings(doc, { source: file })).map(({ settings, warnings }) => {
		for (const warning of warnings) io.annotate("warning", warning);
		return settings;
	});
}
/** `validate <file>`: the schema verdict alone, no token and no API call. */
function validateFile(file, io) {
	return readValidated(file, io).match((settings) => {
		const sections = declaredSections(settings).map((section) => section.key);
		return {
			code: 0,
			lines: [`${file} is valid: ${sections.length} section(s) declared (${sections.join(", ")})`],
			json: {
				file,
				valid: true,
				sections
			}
		};
	}, (problem) => {
		const message = describeProblem(problem);
		io.annotate("error", message);
		return {
			code: 1,
			lines: [],
			json: {
				file,
				valid: false,
				problem: message
			}
		};
	});
}
/** `permissions <file>`: the PAT grant each declared section needs, from the section declarations. */
function permissionsFor(file, io, bold) {
	return readValidated(file, io).match((settings) => {
		const grants = declaredSections(settings).map((section) => [section.key, sectionGrant(section)]);
		return {
			code: 0,
			lines: grants.map(([key, grant]) => `${bold(key)}: ${grant}`),
			json: Object.fromEntries(grants)
		};
	}, (problem) => {
		const message = describeProblem(problem);
		io.annotate("error", message);
		return {
			code: 1,
			lines: [],
			json: {
				file,
				valid: false,
				problem: message
			}
		};
	});
}
/**
* The action's wording for a problem, except where the remedy names the
* workflow step: from a terminal the fix is a flag or an environment variable.
*/
function describeCliProblem(problem) {
	switch (problem.code) {
		case "input-token-missing": return "cannot call the GitHub API: no token was provided. Pass --token, or export GITHUB_TOKEN";
		case "input-repository-not-slug": return `cannot target a repository: "${problem.value}" is not an owner/name slug. Pass --repository owner/name (inside GitHub Actions, GITHUB_REPOSITORY supplies it)`;
		default: return describeProblem(problem);
	}
}
/**
* The one report channel a terminal cannot serve: the artifact upload needs
* the Actions runner. Worded as the unsupported value it is from here.
*/
const ARTIFACT_REFUSED = {
	code: "input-unsupported-value",
	input: "private-report",
	value: "artifact",
	noun: "private-report channel from the command line (the artifact upload needs the Actions runner)",
	allowed: PRIVATE_REPORT_CHANNELS.filter((channel) => channel !== "artifact"),
	fallback: INPUT_DECLS["private-report"].default
};
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
/**
* The flags a mode's subcommand takes: the inputs its mode reads. `settings-file`
* is the one input both the merge and the engine modes read.
*/
function inputsForMode(mode) {
	const mergeReads = (name) => MERGE_INPUTS.includes(name);
	const hidden = [...PROGRAM_INPUTS, ...CLI_UNSUPPORTED_INPUTS];
	return INPUT_NAMES.filter((name) => !hidden.includes(name) && (mode === "merge" ? mergeReads(name) : !mergeReads(name) || name === "settings-file"));
}
/** The sentence the action's `repository` description spends on a default a terminal never has. */
const ACTIONS_DEFAULT_SENTENCE = "Defaults to the current repository.";
const CLI_REPOSITORY_SENTENCE = "Required unless repos or repos-dir is set (inside GitHub Actions, GITHUB_REPOSITORY supplies it).";
if (!INPUT_DECLS.repository.description.includes(ACTIONS_DEFAULT_SENTENCE)) throw new Error(`BUG: the repository input's description no longer says "${ACTIONS_DEFAULT_SENTENCE}"; reword the CLI's replacement with it`);
/** The flag's help text: the declaration's, reworded where it assumes the Actions runner. */
function inputDescription(name) {
	const description = INPUT_DECLS[name].description;
	return name === "repository" ? description.replace(ACTIONS_DEFAULT_SENTENCE, CLI_REPOSITORY_SENTENCE) : description;
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
/** The commander option for one input: `--<name> <value>`, repeatable when the declaration is a list. */
function inputOption(name) {
	const parse = isList(name) ? accumulate : once(name);
	return new Option(`--${name} <value>`, inputDescription(name)).argParser(parse);
}
/** Commander's attribute for each flag (camelCase of the name), read from commander itself. */
const ATTRIBUTE = Object.fromEntries(INPUT_NAMES.map((name) => [name, inputOption(name).attributeName()]));
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
* every writer, the parser included, goes through maskedStreams().
*/
/** A stream that redacts each chunk before handing it to `target`. */
var RedactingStream = class extends Writable {
	target;
	redact;
	constructor(target, redact) {
		super({ decodeStrings: false });
		this.target = target;
		this.redact = redact;
	}
	_write(chunk, _encoding, callback) {
		if (this.target.write(this.redact(String(chunk)))) callback();
		else this.target.once("drain", callback);
	}
};
/**
* Every write to the returned streams is redacted; register a value before
* anything can print it. One registry serves the parser, the Io, and the
* file-only commands alike, so no writer can bypass it.
*/
function maskedStreams(streams) {
	const registry = maskRegistry(() => {});
	const redact = (text) => redactRanges(text, registry.masked());
	return {
		stdout: new RedactingStream(streams.stdout, redact),
		stderr: new RedactingStream(streams.stderr, redact),
		redact,
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
	const outputs = /* @__PURE__ */ new Map();
	return {
		io: {
			annotate: (annotation, message) => consola[CONSOLA_TYPE[annotation]](message),
			log: (line) => logStream.write(`${line}\n`),
			debug: (line) => consola.debug(line),
			summary: (markdown) => {
				if (options.summaryFile !== void 0) appendFileSync(options.summaryFile, `${streams.redact(markdown)}\n`);
			},
			output: (name, value) => {
				outputs.set(name, value);
			},
			mask: streams.mask,
			masked: streams.masked
		},
		flush: () => {
			if (options.json) {
				streams.stdout.write(`${JSON.stringify(Object.fromEntries(outputs))}\n`);
				return;
			}
			for (const [name, value] of outputs) streams.stdout.write(`${name}=${value}\n`);
		}
	};
}
//#endregion
//#region src/cli/program.ts
/**
* The command tree: check, apply, and merge mirror the action's modes with
* INPUT_DECLS as their flags; validate and permissions read a file alone.
* `--token`, `--json`, `--summary`, and `--verbose` are global. main() runs
* argv to its exit code without touching the process.
*/
const DESCRIPTION = {
	check: "Report drift between a settings file and the live repository; exits 1 on any drift",
	apply: "Apply a settings file to the repository",
	merge: "Fold an ordered list of settings files into one document, with no token and no API call",
	validate: "Validate a settings file against the schema; no token, no API call",
	permissions: "Print the PAT grant each section a settings file declares needs"
};
/** The subcommands that run the engine or the merge, each under its mode. */
const MODE_COMMANDS = {
	check: "check",
	apply: "apply",
	merge: "merge"
};
/** The production host: process.env and the real client. */
function processHost() {
	return {
		env: process.env,
		createClient: (token, io, apiVersion) => new GithubApi({
			token,
			io,
			apiVersion
		})
	};
}
/**
* The whole command tree, wired to `options`; the exit code lands in the
* returned holder. The environment's token is masked here, before any writer
* exists; the argv token is main()'s to register, before the parse.
*/
function buildProgram(options) {
	const { host, streams } = options;
	const colors = options.colors ?? pc.isColorSupported;
	const paint = pc.createColors(colors);
	const execute = options.execute ?? ((cfg, io) => runConfig(cfg, io, host));
	const envToken = host.env.GITHUB_TOKEN?.trim();
	if (envToken !== void 0 && envToken !== "") streams.mask(envToken);
	let exitCode = 0;
	const program = new Command().name("github-settings-as-code").description("Apply, check, merge, and validate declarative GitHub repository settings (also installed as gsac)").addOption(new Option("--token <value>", `${INPUT_DECLS.token.description} Falls back to GITHUB_TOKEN.`).argParser(once("token"))).option("--json", "Print the outputs as one JSON object on stdout; log lines move to stderr").addOption(new Option("--summary <file>", "Append the run's markdown summary to this file").argParser(once("summary"))).option("--verbose", "Show the debug trace on stderr").exitOverride().configureOutput({
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
		for (const input of inputsForMode(mode)) command.addOption(inputOption(input));
		command.action(async function() {
			const values = this.optsWithGlobals();
			const { io, flush } = openIo(values);
			const read = argvReader(mode, values);
			exitCode = read("private-report") === "artifact" ? failRun(io, ARTIFACT_REFUSED, describeCliProblem) : await parseConfig(read, host.env).match((cfg) => execute(cfg, io), async (problem) => failRun(io, problem, describeCliProblem));
			flush();
		});
	}
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
/** Run `argv` (the full process.argv shape) to its exit code; every line, a crash's included, is masked. */
async function main(argv, options) {
	const streams = maskedStreams(options.streams);
	for (const token of tokenValues(argv)) streams.mask(token);
	const { program, exitCode } = buildProgram({
		...options,
		streams
	});
	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode;
		const verbose = program.opts().verbose === true;
		const detail = verbose && error instanceof Error && error.stack ? error.stack : String(error);
		const remedy = verbose ? "The stack above is the report: if it recurs, file a bug with it attached" : "Re-run with --verbose for the stack; if it recurs, file a bug with that output attached";
		streams.stderr.write(`error: github-settings-as-code stopped unexpectedly: ${detail}. ${remedy}\n`);
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
