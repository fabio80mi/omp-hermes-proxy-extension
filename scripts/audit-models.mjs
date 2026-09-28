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
 *   node scripts/audit-models.mjs --delay 2000        # ms between models
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

const argv = process.argv.slice(2);
let only = null;
let writeOpencode = true;
let delayMs = 1200;
let skipUnkeyed = false;

for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === "--provider") only = argv[++i];
	else if (argv[i] === "--no-opencode") writeOpencode = false;
	else if (argv[i] === "--delay") delayMs = Number(argv[++i]);
	else if (argv[i] === "--include-unkeyed") skipUnkeyed = false;
	else if (argv[i] === "--help" || argv[i] === "-h") {
		console.log(
			[
				"audit-models — probe free models across configured providers",
				"",
				"  node scripts/audit-models.mjs",
				"  node scripts/audit-models.mjs --provider kilo",
				"  node scripts/audit-models.mjs --delay 2000 --no-opencode",
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

const report = { generatedAt: new Date().toISOString(), delayMs, providers: [] };

for (const def of providers) {
	const key = resolveKey(def);
	if (!key && skipUnkeyed) continue;

	console.log(`\n=== ${def.label} (${def.id}) ===`);
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
		await sleep(delayMs);
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
			await sleep(delayMs * 2);
		}
	}

	const tally = results.reduce((acc, r) => {
		acc[r.state] = (acc[r.state] ?? 0) + 1;
		return acc;
	}, {});
	console.log(`  -> ${tally.ok ?? 0} ok, ${tally.partial ?? 0} chat-only, ${tally.limited ?? 0} budget-limited, ` +
		`${tally.throttled ?? 0} throttled, ${tally.paid ?? 0} paid, ${tally.dead ?? 0} dead, ${tally.error ?? 0} error`);

	report.providers.push({
		id: def.id,
		label: def.label,
		baseUrl: def.baseUrl,
		freeSource: def.freeSource,
		catalogTotal: catalog.catalogTotal,
		freeTotal: catalog.models.length,
		tally,
		models: results,
	});
}

// ---------------------------------------------------------------------------

writeFileSync(AUDIT_PATH, JSON.stringify(report, null, 2));
console.log(`\nwrote ${AUDIT_PATH}`);

if (writeOpencode) {
	const { renderOpencode } = await import("./render-opencode.mjs");
	const target = join(ROOT_DIR, "opencode.providers.json");
	writeFileSync(target, renderOpencode(report));
	console.log(`wrote ${target}`);
}
