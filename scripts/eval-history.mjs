#!/usr/bin/env node
/**
 * Append-only history for quality evaluations, and a summary that survives the
 * noise.
 *
 * The audit and the eval answer different questions and must not be confused:
 *
 *   audit — does the model work? chat, tool calls, repeatable. Gates which
 *           models earn a `verified-` provider. See audit-history.mjs.
 *   eval  — is the model good? code/debug/tools/spec/ops at three complexities.
 *           Ranks models. Never gates registration.
 *
 * A single eval run is close to meaningless on its own. The same model scored
 * 64, 83 and 60 on three identical runs of the same suite, so the ranking from
 * one pass is largely a measure of when you happened to run it. The median of
 * the last N runs is the honest number, and the spread matters as much as the
 * median: a model averaging 80 with a 30-point spread is a different tool from
 * one averaging 80 with a 2-point spread.
 *
 * Layout:
 *   eval-history/<provider>/<timestamp>.json   one run, never rewritten
 *   eval-summary.json                          derived medians and spread
 *
 * As with the audit, the history is local and git-ignored. Losing it silently
 * returns every model to "no data", so back it up.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT_DIR } from "../src/providers.mjs";

export const EVAL_HISTORY_DIR = join(ROOT_DIR, "eval-history");
export const SUMMARY_PATH = join(ROOT_DIR, "eval-summary.json");

/** How many recent runs the summary considers. */
export const WINDOW = 3;

/**
 * How many runs are kept on disk.
 *
 * History is evidence, but not unbounded evidence: a run is a few KB and the
 * per-run detail stops being useful long before the file count becomes a
 * problem. Ten is comfortably more than the three-run window, so pruning can
 * never remove a run the current verdict depends on.
 */
export const KEEP = 10;

const TIERS = ["A", "B", "C"];
const CATEGORIES = ["code", "debug", "tools", "spec", "ops"];

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Append one run. Never overwrites: the filename is the run timestamp. */
export function appendRun(providerId, run) {
	const dir = join(EVAL_HISTORY_DIR, providerId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const stamp = (run.generatedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
	let path = join(dir, `${stamp}.json`);
	let n = 0;
	while (existsSync(path)) {
		n += 1;
		path = join(dir, `${stamp}-${n}.json`);
	}
	writeFileSync(path, JSON.stringify(run, null, 2));
	return path;
}

/** Every stored run for a provider, oldest first. Unreadable files are skipped. */
/**
 * Keep only the most recent `keep` runs, oldest pruned.
 *
 * Pruning is a real deletion, so it is logged rather than silent, and the limit
 * is asserted to exceed the window. If they ever collided, pruning could remove
 * a run a live verdict still depends on.
 */
export function prune(providerId, { keep = KEEP, window = WINDOW } = {}) {
	if (keep < window) {
		throw new Error(`KEEP (${keep}) must be >= WINDOW (${window}); pruning would delete runs the verdict uses`);
	}
	const dir = join(EVAL_HISTORY_DIR, providerId);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	const excess = files.slice(0, Math.max(0, files.length - keep));
	for (const file of excess) rmSync(join(dir, file));
	return excess;
}

export function readHistory(providerId) {
	const dir = join(EVAL_HISTORY_DIR, providerId);
	if (!existsSync(dir)) return [];
	const runs = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
		try {
			runs.push(JSON.parse(readFileSync(join(dir, file), "utf-8")));
		} catch {
			// A truncated run must not hide the ones around it.
		}
	}
	return runs;
}

export function listProviders() {
	if (!existsSync(EVAL_HISTORY_DIR)) return [];
	return readdirSync(EVAL_HISTORY_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/**
 * Reduce the last `window` runs to a per-model verdict.
 *
 * The headline number is the **mean** of the recent runs, not the median. With
 * three samples the median is just the middle value and discards the other two
 * entirely, which throws away real evidence; the mean uses everything observed.
 *
 * Its weakness — an outlier pulls it — is handled by reporting the spread
 * alongside it rather than by hiding it. The two answers different questions:
 * the mean says what the model typically scores, the spread says whether that
 * number is worth acting on. A model averaging 69 with a 23-point spread has
 * not been measured, it has been sampled.
 */
export function summarise(runs, { window = WINDOW } = {}) {
	const recent = runs.slice(-window);
	const byModel = new Map();

	for (const run of recent) {
		for (const row of run.rows ?? []) {
			if (!byModel.has(row.model)) byModel.set(row.model, []);
			byModel.get(row.model).push(row);
		}
	}

	const models = [];
	for (const [model, observations] of byModel) {
		const totals = observations.map((r) => r.total).filter((t) => typeof t === "number");
		if (totals.length === 0) continue;

		const categories = {};
		for (const category of CATEGORIES) {
			const tiers = {};
			for (const tier of TIERS) {
				const values = observations
					.map((r) => r.results?.[category]?.tiers?.[tier]?.pass)
					.filter((v) => typeof v === "number")
					.map((v) => Math.round(v * 100));
				if (values.length > 0) tiers[tier] = median(values);
			}
			categories[category] = tiers;
		}

		const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
		const spread = Math.max(...totals) - Math.min(...totals);
		models.push({
			model,
			provider: observations[0].provider ?? null,
			runs: observations.length,
			mean: Math.round(mean),
			median: Math.round(median(totals)),
			min: Math.min(...totals),
			max: Math.max(...totals),
			spread,
			// How much the mean can be trusted. One run is an anecdote; three
			// agreeing runs are a measurement.
			confidence:
				observations.length < 2 ? "single run — not yet measured" : spread > 15 ? "noisy — ranking unreliable" : "steady",
			categories,
		});
	}

	// Highest mean first, then most consistent. Two models averaging the same
	// are not equally useful: the one that scores the same every time is.
	models.sort((a, b) => b.mean - a.mean || a.spread - b.spread);

	return {
		generatedAt: new Date().toISOString(),
		rule:
			`mean of the last ${recent.length} eval run(s); spread is max-min over them. ` +
			`A single run is an anecdote, and a wide spread means the ranking is not yet trustworthy.`,
		window: recent.length,
		runsConsidered: recent.map((r) => r.generatedAt),
		models,
	};
}

export function writeSummary(summary) {
	writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
	return SUMMARY_PATH;
}

const TIER_NAME = { A: "easy", B: "medium", C: "complex" };

export function format(summary) {
	const lines = [];
	lines.push(summary.rule);
	lines.push("");
	lines.push(
		`${"model".padEnd(40)}${"mean".padStart(6)}${"med".padStart(5)}${"low".padStart(5)}${"hi".padStart(5)}` +
			`${"spread".padStart(8)}  confidence`,
	);
	lines.push("-".repeat(88));
	for (const m of summary.models) {
		lines.push(
			`${m.model.slice(0, 39).padEnd(40)}${String(m.mean).padStart(6)}${String(m.median).padStart(5)}` +
				`${String(m.min).padStart(5)}${String(m.max).padStart(5)}${String(m.spread).padStart(8)}  ${m.confidence}`,
		);
	}
	lines.push("");
	lines.push("per category, by complexity (A=easy B=medium C=complex):");
	for (const m of summary.models) {
		lines.push(`  ${m.model}`);
		lines.push(`    ${CATEGORIES.map((c) => {
			const t = m.categories[c] ?? {};
			return `${c}[${TIERS.map((tier) => (typeof t[tier] === "number" ? `${tier}${t[tier]}` : `${tier}-`)).join(" ")}]`;
		}).join("  ")}`);
	}
	return lines.join("\n");
}
