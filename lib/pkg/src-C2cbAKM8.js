import { D as writeReplacing, E as renameEntry, M as concludeMerge, N as concludeRun, O as foldLayers, P as failRun, S as runMulti, T as readEntries, Wt as collectingIo, _ as renderSnapshotYaml, et as runForRepo, g as runSnapshot, h as concludeSnapshot, k as readLayerFiles, m as SNAPSHOT_SCHEMA_URL, nt as validateSettingsDoc, ot as describeOptOut, rt as SectionSelection, v as snapshotRepository$1, y as runSingle } from "./inputs-C8XeppNt.js";
import { err, ok } from "neverthrow";
//#region src/flows/merge.ts
/**
* The mode: merge run flow. The written document is exactly what a later apply or check runs from that path; nothing
* here touches GitHub, so the flow takes no client and needs no token.
*/
const MERGED_LABEL = "the merged settings document";
/**
* An input layer is never the destination, under any name the read follows or the rename reaches: the entry the
* rename replaces (the leaf under its resolved parent, a link there unfollowed) against every entry each layer's read
* follows (each component, every link hop, the final file), compared by identity, so spellings, directory links, case
* aliases, and link chains all meet. `out.yml -> layer.yml` as the destination with `layer.yml` as the layer is
* admitted: the write replaces the link and leaves the layer intact. Guarded beside the write: the next run would
* fold the merged document as if it were a layer.
*/
function mergedFileCollision(cfg) {
	const replaced = renameEntry(cfg.mergedFile);
	if (replaced === null) return ok();
	const index = cfg.settingsFiles.findIndex((layer) => readEntries(layer).has(replaced));
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
		return writeReplacing(cfg.mergedFile, folded.yaml).mapErr((reason) => ({
			code: "merged-file-unwritable",
			path: cfg.mergedFile,
			reason
		})).map(() => ({
			layers: cfg.settingsFiles,
			mergedFile: cfg.mergedFile
		}));
	});
}
//#endregion
//#region src/flows/execute.ts
function executeRun(cfg, deps) {
	const { io } = deps;
	const fail = (problem) => ({
		exitCode: failRun(io, problem),
		fatal: problem
	});
	const end = (exitCode) => ({ exitCode });
	if (cfg.kind === "merge") return Promise.resolve(runMerge(cfg, io).match((merged) => end(concludeMerge(io, merged)), fail));
	const api = deps.createClient(cfg.token, io, cfg.apiVersion);
	switch (cfg.kind) {
		case "snapshot": return runSnapshot(api, cfg, io).match((finished) => end(concludeSnapshot(io, finished)), fail);
		case "multi": return runMulti(api, cfg, io, deps.uploader).match((targets) => end(concludeRun(io, {
			kind: "multi",
			mode: cfg.mode,
			targets
		})), fail);
		case "single": return runSingle(api, cfg, io, deps.uploader).match((target) => end(concludeRun(io, {
			kind: "single",
			mode: cfg.mode,
			target
		})), fail);
	}
}
//#endregion
//#region src/flows/library.ts
const UNNAMED_SOURCE = "the settings document";
const MERGED_SOURCE = "the merged settings document";
/** The Io a verb prints through, and the lines the report carries: the caller's own Io leaves the log empty. */
function sink(io) {
	if (io !== void 0) return {
		io,
		log: () => []
	};
	const collected = collectingIo();
	return {
		io: collected.io,
		log: () => collected.lines
	};
}
/** Validate a parsed document into the branded settings every other verb takes. */
function validateSettings(doc, options = {}) {
	const out = sink(options.io);
	return validateSettingsDoc(doc, options.source ?? UNNAMED_SOURCE, options.sections ?? SectionSelection.ALL, out.io).map((settings) => ({
		settings,
		log: out.log()
	}));
}
/** Fold an ordered list of layers into one validated document, as mode: merge does. */
function mergeSettings(layers, options = {}) {
	const out = sink(options.io);
	return foldLayers(layers, options.source ?? MERGED_SOURCE, options.layering ?? "merge", out.io).map((folded) => ({
		...folded,
		log: out.log()
	}));
}
async function runMode(client, repo, settings, mode, options) {
	const out = sink(options.io);
	return {
		...await runForRepo(client, {
			repo,
			settings,
			mode,
			onMissingPermission: options.onMissingPermission ?? "fail",
			sections: options.sections ?? SectionSelection.ALL,
			secretSource: options.secretSource,
			secretEnv: options.secretEnv
		}, out.io),
		log: out.log()
	};
}
/** Plan and diff every active section without writing. */
function checkRepository(client, repo, settings, options = {}) {
	return runMode(client, repo, settings, "check", options);
}
/** Execute the plan: the repository converges on the document. */
function applyRepository(client, repo, settings, options = {}) {
	return runMode(client, repo, settings, "apply", options);
}
/** Read one repository's supported sections back as a settings document and its rendered file. */
async function snapshotRepository(client, repo, options = {}) {
	const out = sink(options.io);
	const takenAt = (/* @__PURE__ */ new Date()).toISOString();
	const result = await snapshotRepository$1(client, {
		repo,
		sections: options.sections ?? SectionSelection.ALL,
		onMissingPermission: options.onMissingPermission ?? "fail"
	}, out.io);
	const log = out.log();
	if (result.result === "failed") return {
		...result,
		takenAt,
		log
	};
	const yaml = renderSnapshotYaml(result, SNAPSHOT_SCHEMA_URL);
	return {
		...result,
		yaml,
		takenAt,
		log
	};
}
/** Snapshot several repositories in order, one report each; a failed target never stops the rest. */
async function snapshotRepositories(client, repos, options = {}) {
	const reports = [];
	for (const repo of repos) reports.push(await snapshotRepository(client, repo, options));
	return reports;
}
//#endregion
export { snapshotRepository as a, runMerge as c, snapshotRepositories as i, checkRepository as n, validateSettings as o, mergeSettings as r, executeRun as s, applyRepository as t };
