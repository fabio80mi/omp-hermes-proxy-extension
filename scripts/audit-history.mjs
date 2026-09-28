#!/usr/bin/env node
/**
 * Append-only audit history, and the stability rule derived from it.
 *
 * Why a history rather than one file that gets overwritten: a single snapshot
 * cannot tell "this model is broken" from "this attempt was unlucky". Our own
 * eval showed one model scoring 100, 33 and 0 on three consecutive runs of an
 * identical test, and providers are at least as noisy. Every audit is kept, and
 * `verified-*` membership is decided by how a model behaves across the last N
 * runs, not by one pass.
 *
 * Layout:
 *   audit-history/<timestamp>.json   one immutable run, never rewritten
 *   audit.json                       latest run, for compatibility
 *   audit-stable.json                derived: which models are stable now
 *
 * A run is written even when it is partial, and a provider whose catalog fetch
 * failed is recorded as such. A gap in the history has to be visible, because a
 * missing run and a model that stopped being offered look identical otherwise.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT_DIR } from "../src/providers.mjs";

export const HISTORY_DIR = join(ROOT_DIR, "audit-history");
export const STABLE_PATH = join(ROOT_DIR, "audit-stable.json");

/** How many recent runs the stability rule looks at. */
export const WINDOW = 3;

/** How many of those runs a model must pass to count as stable. */
export const NEEDED = 2;

/**
 * How many runs are kept on disk.
 *
 * A run is a few KB and its per-model detail stops being useful well before the
 * file count matters, so the history is bounded rather than append-forever.
 * Ten is well above the three-run window, so pruning can never remove a run a
 * live verdict depends on.
 */
export const KEEP = 10;

/**
 * States that count as a pass.
 *
 * `partial` is excluded deliberately: it answers chat but cannot emit a tool
 * call, so it is not usable as an agent model, and the `verified-` name promises
 * otherwise. `throttled` and `timeout` are attempts, not verdicts.
 */
const PASS_STATES = new Set(["ok"]);

/** States that mean the model is gone for good, whichever run saw it. */
const TERMINAL_STATES = new Set(["end_of_life", "dead", "paid"]);

/**
 * States where the request never really tested the model.
 *
 * These describe the moment, not the model: the provider was busy, the socket
 * stalled, or the model spent its whole budget thinking. Treating any of them
 * as evidence against a model invents a failure that never happened, so they
 * are excluded from the pass/fail tally and never remove a model from the
 * picker.
 */
const INCONCLUSIVE_STATES = new Set(["throttled", "timeout", "error", "limited"]);

/**
 * Statuses that earn a place in the picker.
 *
 * `stable` is proven; `known-good` and `unstable` are provisional but have
 * worked and have not been permanently broken. Anything the owner depends on
 * should stay put unless it is genuinely gone.
 */
const PICKER_STATUSES = new Set(["stable", "known-good", "unstable"]);

function ensureDir() {
	if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

/**
 * Append one run to the history.
 *
 * The filename is the run timestamp with colons replaced, so a run is a single
 * file that is written once. Overwriting a timestamp would silently destroy
 * evidence, which is the one thing this store exists to prevent.
 */
export function appendRun(report) {
	ensureDir();
	const stamp = (report.generatedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
	const path = join(HISTORY_DIR, `${stamp}.json`);
	let n = 0;
	while (existsSync(path)) {
		n += 1;
		// Two runs in the same millisecond is rare but not impossible.
		const alt = join(HISTORY_DIR, `${stamp}-${n}.json`);
		if (!existsSync(alt)) {
			writeFileSync(alt, JSON.stringify(report, null, 2));
			return alt;
		}
	}
	writeFileSync(path, JSON.stringify(report, null, 2));
	return path;
}

/**
 * Keep only the most recent `keep` runs.
 *
 * This deletes evidence, so it is logged rather than silent, and the limit is
 * asserted to exceed the window: pruning below the window could remove a run
 * that `verified-*` membership currently rests on.
 */
export function prune({ keep = KEEP, window = WINDOW } = {}) {
	if (keep < window) {
		throw new Error(`KEEP (${keep}) must be >= WINDOW (${window}); pruning would delete runs the verdict uses`);
	}
	if (!existsSync(HISTORY_DIR)) return [];
	const files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort();
	const excess = files.slice(0, Math.max(0, files.length - keep));
	for (const file of excess) rmSync(join(HISTORY_DIR, file));
	return excess;
}

/** Every stored run, oldest first. Unreadable files are skipped, not fatal. */
export function readHistory() {
	if (!existsSync(HISTORY_DIR)) return [];
	const files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort();
	const runs = [];
	for (const file of files) {
		try {
			runs.push(JSON.parse(readFileSync(join(HISTORY_DIR, file), "utf-8")));
		} catch {
			// A truncated file must not hide the runs around it.
		}
	}
	return runs;
}

/**
 * Decide which models are stable, from the last `window` runs.
 *
 * Per provider, per model:
 *   stable    — passed in at least `needed` of the runs that saw it
 *   unstable  — passed sometimes, not often enough; worth retrying later
 *   rejected  — never passed; not a transient
 *   retired   — previously present, absent from the newest successful catalog,
 *               or reported end-of-life by the provider
 *   new       — present now, with too little history to judge
 *
 * Absence is only retirement when the run that lacked it actually succeeded.
 * A provider whose catalog fetch failed tells us nothing about its models, and
 * treating that as retirement would empty the picker after one bad request.
 */
export function computeStable(runs, { window = WINDOW, needed = NEEDED } = {}) {
	const recent = runs.slice(-window);
	const byProvider = new Map();

	for (const run of recent) {
		for (const provider of run.providers ?? []) {
			if (!byProvider.has(provider.id)) {
				byProvider.set(provider.id, {
					id: provider.id,
					label: provider.label,
					baseUrl: provider.baseUrl,
					seen: new Map(),
					absentRuns: 0,
					successfulRuns: 0,
					catalogOk: 0,
				});
			}
			const entry = byProvider.get(provider.id);
			// A run that failed to fetch the catalog says nothing about models.
			if (provider.error || !provider.models || provider.models.length === 0) {
				entry.absentRuns += 1;
				continue;
			}
			entry.successfulRuns += 1;
			entry.catalogOk += 1;
			for (const model of provider.models) {
				if (!entry.seen.has(model.id)) entry.seen.set(model.id, []);
				entry.seen.get(model.id).push({ run: run.generatedAt, state: model.state, status: model.status, detail: model.detail });
			}
		}
	}

	const out = [];
	for (const [, entry] of byProvider) {
		const newest = recent.filter((r) => (r.providers ?? []).some((p) => p.id === entry.id && !p.error && p.models?.length)).pop();
		const newestIds = new Set(
			(newest?.providers ?? []).find((p) => p.id === entry.id)?.models?.map((m) => m.id) ?? [],
		);

		const models = [];
		for (const [id, observations] of entry.seen) {
			// Throttling, timeouts and reasoning-budget exhaustion are properties
			// of the provider at that moment, not of the model. All five throttled
			// models in one run were throttled simultaneously, so a 429 says
			// "the provider was busy", not "these models are bad".
			//
			// Counting them as failures both invented evidence against models
			// that demonstrably work and made the picker churn on busy
			// afternoons. They are missing data, not verdicts: excluded from the
			// denominator, and never grounds for removal.
			const usable = observations.filter((o) => !INCONCLUSIVE_STATES.has(o.state));
			const passes = usable.filter((o) => PASS_STATES.has(o.state)).length;
			const terminal = observations.find((o) => TERMINAL_STATES.has(o.state));
			const inNewest = newestIds.has(id);

			let status;
			let reason;
			if (terminal) {
				// The only conditions that remove a model. Both are permanent:
				// a provider that retired or de-listed a model does not bring it
				// back, so this is not churn.
				status = "retired";
				reason = `${terminal.state}: ${terminal.detail ?? ""}`.trim();
			} else if (!inNewest) {
				status = "retired";
				reason = "absent from the most recent successful catalog";
			} else if (passes === 0) {
				// Judged and found wanting on every attempt we actually got to
				// make. If those attempts were all throttles there is nothing to
				// judge, so this stays a lack of evidence rather than a verdict.
				status = usable.length === 0 ? "unknown" : "rejected";
				const last = observations[observations.length - 1];
				reason =
					usable.length === 0
						? `no usable observation in ${observations.length} run(s); all inconclusive (${[...new Set(observations.map((o) => o.state))].join(", ")})`
						: `never passed in ${usable.length} usable run(s); last: ${last.state}${last.status ? ` (HTTP ${last.status})` : ""}`;
			} else if (usable.length < needed) {
				// Worked, but not enough comparable evidence to call it steady.
				status = "known-good";
				reason = `passed ${passes}/${usable.length} usable run(s), needs ${needed} to be stable`;
			} else if (passes >= needed) {
				status = "stable";
				reason = `passed ${passes}/${usable.length} usable runs`;
			} else {
				status = "unstable";
				reason = `passed ${passes}/${usable.length} usable runs, needs ${needed}`;
			}
			models.push({
				id,
				status,
				reason,
				passes,
				observations: observations.length,
				usable: usable.length,
				// In the picker, but not because it is proven — it has worked at
				// least once and nothing permanent has happened to it.
				provisional: status === "known-good" || status === "unstable",
			});
		}

		out.push({
			id: entry.id,
			label: entry.label,
			baseUrl: entry.baseUrl,
			window: recent.length,
			needed,
			tally: models.reduce((acc, m) => ((acc[m.status] = (acc[m.status] ?? 0) + 1), acc), {}),
			models: models.sort((a, b) => a.id.localeCompare(b.id)),
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		rule:
			`a model is stable when it passes at least ${needed} of its last ${recent.length} runs, ` +
			`counting only runs that actually reached the model. Throttled, timed-out and ` +
			`budget-limited runs are inconclusive and never count against a model. A model is ` +
			`removed only on a permanent condition (dead, end-of-life, paid, absent from the catalogue).`,
		window: recent.length,
		needed,
		runsConsidered: recent.map((r) => r.generatedAt),
		providers: out,
	};
}

/** Only the models eligible for a `verified-*` provider. */
/**
 * Model IDs that belong in the picker.
 *
 * `stable` is the proven tier. `known-good` and `unstable` are provisional: the
 * model has worked at least once and nothing permanent has happened to it, so
 * leaving it out would only churn the user's configuration on a busy afternoon
 * for no gain. The alternative — exposing them under a distinct name — would
 * force every consumer to carry two lists, and OMP's model picker has no
 * concept of a tier anyway.
 *
 * `rejected`, `retired` and `unknown` are excluded: a model that has never
 * worked, or that is permanently gone, has no claim on a slot.
 */
export function stableIds(stable) {
	const ids = new Set();
	for (const provider of stable.providers ?? []) {
		for (const model of provider.models ?? []) {
			if (PICKER_STATUSES.has(model.status)) ids.add(`${provider.id}/${model.id}`);
		}
	}
	return ids;
}

export function writeStable(stable) {
	writeFileSync(STABLE_PATH, JSON.stringify(stable, null, 2));
	return STABLE_PATH;
}

export function summarise(stable) {
	const lines = [];
	for (const provider of stable.providers ?? []) {
		const t = provider.tally;
		lines.push(
			`  ${provider.id}: ${t.stable ?? 0} stable, ${t["known-good"] ?? 0} known-good, ${t.unstable ?? 0} unstable, ` +
				`${t.rejected ?? 0} rejected, ${t.retired ?? 0} retired, ${t.new ?? 0} new` +
				`  (from ${provider.window} run(s), needs ${provider.needed})`,
		);
		for (const model of provider.models ?? []) {
			if (model.status === "stable") continue;
			lines.push(`    ${model.status.padEnd(9)} ${model.id}: ${model.reason}`);
		}
	}
	return lines.join("\n");
}
