#!/usr/bin/env node
/**
 * Audit free models across every enabled provider.
 *
 * For each provider: fetch the free-model list, then probe every model for
 * chat and tool-calling support, serially and spaced out. Writes audit.json and
 * regenerates the opencode provider blocks.
 *
 * Why serial: parallel probes trigger provider rate limits, and a 429 caused by
 * our own concurrency is indistinguishable from a genuinely throttled model.
 * We would then record confident wrong verdicts on a schedule.
 *
 * Why the token floor: reasoning models spend 100-900 tokens before answering.
 * Probing with a small budget returns `finish_reason: "length"` and no content,
 * which looks identical to a broken model.
 *
 * Usage:
 *   node scripts/audit-models.mjs                     # all enabled providers
 *   node scripts/audit-models.mjs --provider kilo      # one provider
 *   node scripts/audit-models.mjs --no-opencode       # skip opencode export
 *   node scripts/audit-models.mjs --delay 2000        # ms between models, all providers
 *   node scripts/audit-models.mjs --delay kilo=9000   # ms for one provider only
 *
 * Each provider also carries its own `delayMs` in providers.json, which sets
 * the default: providers rate-limit very differently, and a 429 we caused
 * ourselves is indistinguishable from a real one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	AUDIT_PATH,
	ROOT_DIR,
	fetchFreeModels,
	loadDotEnv,
	loadProviders,
	probeModel,
	resolveKey,
} from "../src/providers.mjs";
import {
	appendRun,
	computeStable,
	prune,
	readHistory,
	stableIds,
	summarise,
	writeStable,
} from "./audit-history.mjs";

const argv = process.argv.slice(2);
let only = null;
let writeOpencode = true;
/**
 * Fallback pace when neither the CLI nor providers.json says otherwise.
 * Kept as a named constant because the CLI value must be nullable to tell
 * "the user passed --delay" from "nobody did" — otherwise providers.json
 * silently wins over an explicit flag on the command line.
 */
const DEFAULT_DELAY_MS = 1200;
/** Set only by a bare `--delay <ms>`. */
let globalDelay = null;
let skipUnkeyed = false;
/** Per-provider pacing overrides from `--delay <provider>=<ms>`. */
const delayOverrides = new Map();

for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === "--provider") only = argv[++i];
	else if (argv[i] === "--no-opencode") writeOpencode = false;
	else if (argv[i] === "--delay") {
		// Accept either a global `--delay 4000` or a per-provider
		// `--delay kilo=6000`, so pacing can be raised for one rate-limited
		// upstream without slowing the others.
		const value = argv[++i];
		const per = /^([a-z]+)=(\d+)$/.exec(String(value));
		if (per) delayOverrides.set(per[1], Number(per[2]));
		else globalDelay = Number(value);
	}
	else if (argv[i] === "--include-unkeyed") skipUnkeyed = false;
	else if (argv[i] === "--help" || argv[i] === "-h") {
		console.log(
			[
				"audit-models — probe free models across configured providers",
				"",
				"  node scripts/audit-models.mjs",
				"  node scripts/audit-models.mjs --provider kilo",
				"  node scripts/audit-models.mjs --delay 2000 --no-opencode",
			"  node scripts/audit-models.mjs --delay kilo=9000   # one provider, louder",
				"",
				"Keys are read from .env (git-ignored):",
				"  HERMES_PROXY_KEY  CLINE_API_KEY  KILO_API_KEY",
			].join("\n"),
		);
		process.exit(0);
	}
}

loadDotEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = loadProviders().filter((p) => p.enabled !== false);
const providers = only ? all.filter((p) => p.id === only) : all;

if (providers.length === 0) {
	console.error(only ? `no enabled provider named ${only}` : "no enabled providers in providers.json");
	process.exit(1);
}

const report = { generatedAt: new Date().toISOString(), defaultDelayMs: DEFAULT_DELAY_MS, providers: [] };

for (const def of providers) {
	// providers.json carries each upstream's own pace; a global --delay and an
	// explicit --delay kilo=... both override it. Providers rate-limit very
	// differently — at 2.5s Kilo returned 429 for five models in one run while
	// Hermes and Cline were clean — and a throttle we caused ourselves is
	// indistinguishable from a real one, so the pace belongs with the provider.
	// Precedence: --delay <id>=<ms> beats a bare --delay <ms>, which beats
	// providers.json, which beats the built-in default. An explicit flag must
	// win over a config file, or `--delay 9000` would do nothing.
	const pace =
		delayOverrides.get(def.id) ??
		globalDelay ??
		(Number.isFinite(def.delayMs) ? def.delayMs : DEFAULT_DELAY_MS);
	const key = resolveKey(def);
	if (!key && skipUnkeyed) continue;

	console.log(`\n=== ${def.label} (${def.id}) — ${pace}ms between probes ===`);
	if (!key) console.log("  no API key configured — probing unauthenticated");

	let catalog;
	try {
		catalog = await fetchFreeModels(def);
	} catch (error) {
		console.error(`  catalog fetch failed: ${error.message}`);
		report.providers.push({ id: def.id, label: def.label, error: `catalog: ${error.message}`, models: [] });
		continue;
	}

	console.log(`  free models: ${catalog.models.length} (catalog total ${catalog.catalogTotal}, via ${catalog.source})`);
	if (catalog.models.length === 0) {
		report.providers.push({ id: def.id, label: def.label, catalogTotal: catalog.catalogTotal, models: [] });
		continue;
	}

	const results = [];

	// First pass. A 429 here may be our own pacing rather than the provider, so
	// throttled and timed-out models are re-probed once after a longer pause
	// before any verdict is recorded.
	for (const model of catalog.models) {
		process.stdout.write(`    ${model.id} ...`);
		const verdict = await probeModel(def, model.id);
		results.push({ ...verdict, name: model.name, context: model.context_length ?? null, wire: model });
		const mark =
			verdict.state === "ok" ? "ok" : verdict.state === "partial" ? "chat" : verdict.state;
		console.log(` ${mark} ${verdict.status ?? ""} ${verdict.detail}`.trimEnd());
		await sleep(pace);
	}

	// Retry pass. Inconclusive outcomes are not verdicts: a model that was
	// throttled or timed out has not been shown to be broken, and recording it
	// as such is how a good model quietly disappears from the picker.
	const inconclusive = results.filter(
		(m) => m.state === "throttled" || m.state === "timeout" || m.state === "error",
	);
	if (inconclusive.length > 0) {
		console.log(`  -- retrying ${inconclusive.length} inconclusive after 20s --`);
		await sleep(20_000);
		for (const prior of inconclusive) {
			process.stdout.write(`    ${prior.id} (retry) ...`);
			const retry = await probeModel(def, prior.id);
			Object.assign(prior, retry, { name: prior.name, context: prior.context, wire: prior.wire });
			console.log(
				` ${retry.state} ${retry.status ?? ""} ${retry.detail}`.trimEnd(),
			);
			await sleep(pace * 2);
		}
	}

	const tally = results.reduce((acc, r) => {
		acc[r.state] = (acc[r.state] ?? 0) + 1;
		return acc;
	}, {});
	console.log(`  -> ${tally.ok ?? 0} ok, ${tally.partial ?? 0} chat-only, ${tally.limited ?? 0} budget-limited, ` +
		`${tally.throttled ?? 0} throttled, ${tally.paid ?? 0} paid, ${tally.dead ?? 0} dead, ` +
		`${tally.end_of_life ?? 0} end-of-life, ${tally.auth_error ?? 0} auth, ${tally.error ?? 0} error`);

	report.providers.push({
		id: def.id,
		label: def.label,
		baseUrl: def.baseUrl,
		freeSource: def.freeSource,
		// Recorded in the evidence, because a throttled model is ambiguous
		// without knowing how hard we were pushing.
		delayMs: pace,
		catalogTotal: catalog.catalogTotal,
		freeTotal: catalog.models.length,
		tally,
		models: results,
	});
}

// ---------------------------------------------------------------------------

writeFileSync(AUDIT_PATH, JSON.stringify(report, null, 2));
console.log(`\nwrote ${AUDIT_PATH}`);

// Append, never overwrite. The history is what makes a stability verdict
// possible; a single overwritten file cannot distinguish a broken model from an
// unlucky attempt.
const historyPath = appendRun(report);
console.log(`appended run to ${historyPath}`);

// Bounded history: keep the newest KEEP runs, oldest pruned. Logged because it
// is a deletion.
const pruned = prune();
if (pruned.length > 0) {
	console.log(`pruned ${pruned.length} old run(s) beyond the retention limit: ${pruned.join(", ")}`);
}

const history = readHistory();
const stable = computeStable(history);
const stablePath = writeStable(stable);
console.log(`\nwrote ${stablePath}`);
console.log(`\n${stable.rule}`);
console.log(summarise(stable));

if (writeOpencode) {
	// The export is rendered from the stability verdict, not from this run
	// alone, so a one-off pass cannot add a model that has never repeated.
	const { renderOpencode } = await import("./render-opencode.mjs");
	const target = join(ROOT_DIR, "opencode.providers.json");
	writeFileSync(target, renderOpencode(report, { stable, ids: stableIds(stable) }));
	console.log(`wrote ${target}`);
}
