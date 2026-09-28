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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT_DIR } from "../src/providers.mjs";

export const HISTORY_DIR = join(ROOT_DIR, "audit-history");
export const STABLE_PATH = join(ROOT_DIR, "audit-stable.json");

/** How many recent runs the stability rule looks at. */
export const WINDOW = 3;

/** How many of those runs a model must pass to count as stable. */
export const NEEDED = 2;

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
			const passes = observations.filter((o) => PASS_STATES.has(o.state)).length;
			const terminal = observations.find((o) => TERMINAL_STATES.has(o.state));
			const inNewest = newestIds.has(id);

			let status;
			let reason;
			if (terminal) {
				status = "retired";
				reason = `${terminal.state}: ${terminal.detail ?? ""}`.trim();
			} else if (!inNewest) {
				status = "retired";
				reason = "absent from the most recent successful catalog";
			} else if (observations.length < needed) {
				// Not enough history to judge. Not a rejection.
				status = "new";
				reason = `only ${observations.length} run(s) of history, needs ${needed}`;
			} else if (passes === 0) {
				// Never passed. Different from `unstable`, which means it
				// sometimes works and is worth retrying later.
				status = "rejected";
				const last = observations[observations.length - 1];
				reason = `never passed in ${observations.length} run(s); last: ${last.state}${last.status ? ` (HTTP ${last.status})` : ""}`;
			} else if (passes >= needed) {
				status = "stable";
				reason = `passed ${passes}/${observations.length} recent runs`;
			} else {
				status = "unstable";
				reason = `passed ${passes}/${observations.length} recent runs, needs ${needed}`;
			}
			models.push({ id, status, reason, passes, observations: observations.length });
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
		rule: `a model is stable when it passes at least ${needed} of the last ${recent.length} runs`,
		window: recent.length,
		needed,
		runsConsidered: recent.map((r) => r.generatedAt),
		providers: out,
	};
}

/** Only the models eligible for a `verified-*` provider. */
export function stableIds(stable) {
	const ids = new Set();
	for (const provider of stable.providers ?? []) {
		for (const model of provider.models ?? []) {
			if (model.status === "stable") ids.add(`${provider.id}/${model.id}`);
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
			`  ${provider.id}: ${t.stable ?? 0} stable, ${t.new ?? 0} new, ${t.unstable ?? 0} unstable, ${t.retired ?? 0} retired` +
				`  (from ${provider.window} run(s), needs ${provider.needed})`,
		);
		for (const model of provider.models ?? []) {
			if (model.status === "stable") continue;
			lines.push(`    ${model.status.padEnd(9)} ${model.id}: ${model.reason}`);
		}
	}
	return lines.join("\n");
}
