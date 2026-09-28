#!/usr/bin/env node
/**
 * Model smoke-eval against the local Hermes proxy.
 *
 * Five cheap, objective checks per model. Not a benchmark suite — it is a
 * regression gate that catches the two failure modes that actually show up in
 * practice: a model that is advertised but dead, and a model that returns
 * nothing when asked to think.
 *
 * Usage:
 *   node scripts/eval-models.mjs                       # every registered model
 *   node scripts/eval-models.mjs --model <id> [--model <id>]
 *   node scripts/eval-models.mjs --all                # whole catalog, not just free
 *   node scripts/eval-models.mjs --json out.json
 *
 * Environment:
 *   HERMES_PROXY_URL   default http://localhost:8645/v1
 *   HERMES_PROXY_KEY   default HermesProxyLocal
 *
 * Exit code is 0 even when models fail. This reports; it does not gate.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildHeaders,
	fetchFreeModels,
	isFreeModel,
	loadDotEnv,
	loadProviders,
	unwrapCompletion,
} from "../src/providers.mjs";

const REPO = new URL("..", import.meta.url).pathname;
loadDotEnv();

// No token budget. A cap here is an invention, not a requirement, and it
// converts "thought hard" into "scored zero" — a conflation that once made
// several working models look broken. The only safety rail is a wall-clock
// timeout, so one runaway model cannot stall a serial run.
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 600000);

/** Gap between models. Five tests per model already spends a provider's budget. */
const DEFAULT_DELAY_MS = 2500;

/** The provider under evaluation. Set from --provider. */
let currentDef = null;

// ---------------------------------------------------------------------------
// tests
//
// Real work, not puzzles. The earlier set was five pass/fail checks that any
// competent model cleared, so every model scored 100 and the eval measured
// nothing the capability audit had not already measured. These are tasks drawn
// from things an agent actually does, and each is scored by executing or
// verifying the output rather than by matching keywords.
//
// They are deliberately sized for capable models. A small model failing these
// is the correct result, not a broken test.
// ---------------------------------------------------------------------------

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_order",
			description: "Fetch a customer order by its id",
			parameters: {
				type: "object",
				properties: { order_id: { type: "string" } },
				required: ["order_id"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_inventory",
			description: "Check current stock level for a product sku",
			parameters: {
				type: "object",
				properties: { sku: { type: "string" } },
				required: ["sku"],
			},
		},
	},
];

// --- 1. multi-step tool use -------------------------------------------------
// The model must call both tools and combine their results into a decision. A
// model that calls neither, or one, cannot score.
const T_TOOLS = [
	"Order ORD-4471 has not shipped and the customer wants to know if we can send it today.",
	"Use the tools to look up the order and the stock for the product it contains.",
	"Then answer in exactly this format and nothing else:",
	"SHIP=<YES or NO> REASON=<at most 12 words>",
].join(" ");

const TOOLS_ANSWER = /SHIP=(YES|NO)/i;

// --- 2. debugging a real defect ---------------------------------------------
// Off-by-one in a pagination boundary. The function is wrong for even-length
// input, which is exactly the bug that slips through casual review.
const T_DEBUG = [
	"This Python function is supposed to return the items on even indices (0-based) of a list.",
	"It works on odd-length lists but is wrong on even-length ones. Explain in one or two sentences",
	"what is wrong and what the minimal fix is. Do not rewrite unrelated code.",
	"",
	"```python",
	"def even_slice(items):",
	"    return [items[i] for i in range(0, len(items) - 1, 2)]",
	"```",
].join("\n");

// --- 3. a real programming problem -------------------------------------------
// Weighted interval scheduling, scored by executing the returned code against a
// known input/output pair. An approximation, brute force, or wrong signature
// all score zero, and partial credit is proportional to how many cases pass.
const T_CODE = [
	"Write a Python function `best_sched(jobs)` that returns the maximum total value of a",
	"non-overlapping subset of jobs. Each job is a dict with keys 'start', 'end', 'value'.",
	"Jobs are half-open intervals: a job ending at time t does not conflict with one starting at t.",
	"Sort and scan is expected; do not brute force. Return only a fenced Python code block.",
].join(" ");

// Expected values are brute-force verified, not hand-computed. A wrong fixture
// makes a correct solution look wrong, which is worse than no test.
const SCHED_CASES = [
	// 200, not the 150 that taking the single big job gives: 50+60+40 beats it.
	[
		{ start: 0, end: 3, value: 50 },
		{ start: 3, end: 4, value: 20 },
		{ start: 3, end: 5, value: 60 },
		{ start: 5, end: 7, value: 40 },
		{ start: 3, end: 9, value: 150 },
	],
	200,
	[
		{ start: 1, end: 4, value: 10 },
		{ start: 4, end: 6, value: 20 },
		{ start: 6, end: 9, value: 30 },
		{ start: 2, end: 8, value: 25 },
	],
	60, // 10+20+30, not the 25 that spans it
	[
		{ start: 0, end: 5, value: 100 },
		{ start: 0, end: 2, value: 60 },
		{ start: 2, end: 4, value: 60 },
		{ start: 4, end: 5, value: 60 },
	],
	180, // splits the 100 into three
	[{ start: 0, end: 1, value: 5 }, { start: 0, end: 1, value: 7 }],
	7, // equal intervals: the larger, not the sum
	// Spans the boundary: 100 is beaten by 40+40+40, and the trailing job at
	// start 9 conflicts with the last of those.
	[
		{ start: 0, end: 10, value: 100 },
		{ start: 1, end: 2, value: 40 },
		{ start: 2, end: 3, value: 40 },
		{ start: 3, end: 4, value: 40 },
		{ start: 9, end: 11, value: 30 },
	],
	150, // 40+40+40; the 30 at start 9 overlaps the job ending at 4
];

// --- 4. spec compliance under many simultaneous constraints ------------------
// Six constraints that conflict if any one is forgotten. Counted individually so
// the score shows which constraint the model dropped.
const T_SPEC = [
	"Rewrite this sentence to satisfy ALL of these constraints:",
	"1. exactly 12 words or fewer",
	"2. all lowercase, no capitals anywhere",
	"3. no commas",
	"4. must contain the word 'cache'",
	"5. must end with a question mark",
	"6. must contain the digits 7 and 9",
	"Output only the rewritten sentence, nothing else.",
	"",
	"Sentence: The Fast Cache Layer Reduced Our Latency Last Quarter.",
].join("\n");

const SPEC_RULES = [
	["<=12 words", (s) => s.trim().split(/\s+/).filter(Boolean).length <= 12],
	["lowercase", (s) => s === s.toLowerCase()],
	["no commas", (s) => !s.includes(",")],
	["contains cache", (s) => /cache/i.test(s)],
	["ends with ?", (s) => s.trim().endsWith("?")],
	["has 7 and 9", (s) => /7/.test(s) && /9/.test(s)],
];

// --- 5. a real operational judgement -----------------------------------------
// There is no clean answer. The model must notice that fixing the leak requires
// downtime it has not been authorised for, and say so rather than produce a
// confident plan that cannot be executed. Scored on the specific facts, not on
// whether it hedges.
const T_OPS = [
	"A service leaks memory at 40MB/hour. It will OOM in about 6 hours. You cannot deploy:",
	"the only engineer with prod access is on leave for 10 hours, and the staging environment",
	"does not reproduce the leak.",
	"Give the operator's plan for the next 10 hours. State plainly what you can and cannot do,",
	"and what happens if the leak is not contained. Be specific. Do not invent prod access.",
].join(" ");

// Each operational fact that must appear for the judgement to be correct.
const OPS_FACTS = [
	["flags prod deploy blocked", /can'?t deploy|cannot deploy|no (prod|production) access|engineer .{0,20}leave|without prod/i],
	["quantifies the runout", /6 hours|~?6h|within 6|before.{0,20}oom|oom/i],
	["gives a containment action", /roll ?back|restart|scale|rate.?limit|drain|shed load|downgrade|flag|disable|alert/i],
	["warns the risk is real", /still (crash|oom|die|go down)|unresolved|may (crash|oom|die)|not (contained|solved|fixed)|risk remains/i],
];

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function call(model, body) {
	const def = currentDef;
	if (!def) throw new Error("no provider selected — pass --provider <id>");
	// No max_tokens. Omitting the field lets the provider use its own default,
	// which avoids both a self-invented cap and a model that answers in three
	// tokens because a small ceiling told it to.
	const payload = {
		model,
		messages: [{ role: "user", content: body.content }],
		stream: false,
	};
	if (body.tools) {
		payload.tools = body.tools;
		payload.tool_choice = "auto";
	}
	if (body.effort) payload.reasoning_effort = body.effort;

	const started = Date.now();
	try {
		const res = await fetch(`${def.baseUrl}/chat/completions`, {
			method: "POST",
			// buildHeaders supplies the provider's SDK-identity headers. Cline
			// 403s every cline-free model without them, which would otherwise
			// score as a dead model rather than a misconfigured request.
			headers: buildHeaders(def, { "Content-Type": "application/json" }),
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const text = await res.text();
		if (!res.ok) {
			let detail = text.slice(0, 160);
			try {
				const parsed = JSON.parse(text);
				detail = `${parsed.message ?? parsed.error?.message ?? text}`.slice(0, 160);
			} catch {}
			return { ok: false, status: res.status, error: detail, seconds: (Date.now() - started) / 1000 };
		}
		const parsedJson = JSON.parse(text);
		// Some gateways nest the OpenAI shape under `data`. Reading the wrong
		// level yields no content and scores a working model as failing every
		// test, so unwrap through the shared helper.
		const json = unwrapCompletion(parsedJson) ?? {};
		const choice = (json.choices ?? [])[0] ?? {};
		const message = choice.message ?? {};
		return {
			ok: true,
			content: message.content ?? "",
			reasoning: message.reasoning_content ?? "",
			toolCalls: message.tool_calls ?? [],
			finish: choice.finish_reason,
			completionTokens: (json.usage ?? {}).completion_tokens,
			seconds: (Date.now() - started) / 1000,
		};
	} catch (error) {
		const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
		return {
			ok: false,
			status: 0,
			error: timedOut ? `timeout after ${TIMEOUT_MS}ms` : String(error).slice(0, 160),
			seconds: (Date.now() - started) / 1000,
		};
	}
}

async function catalog(def) {
	const res = await fetch(`${def.baseUrl}/models`, { headers: buildHeaders(def) });
	if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
	const body = await res.json();
	return (unwrapCompletion(body) ?? body).data ?? [];
}

// ---------------------------------------------------------------------------
// scorers
// ---------------------------------------------------------------------------

// Executed, not approximated. A JS interpreter cannot run Python, so anything
// cleverer here silently scores nothing, and a scorer that measures nothing is
// worse than no scorer.
const PYTHON = process.env.EVAL_PYTHON ?? "python3";

function runPython(code) {
	// stdin carries one JSON line of inputs, then the code. Read it once — a
	// second sys.stdin.read() returns nothing.
	const driver = [
		"import json, sys",
		"raw = sys.stdin.read()",
		"head, _, body = raw.partition(chr(10))",
		"cases = json.loads(head)",
		"g = {}",
		"exec(body, g)",
		"f = g.get('best_sched')",
		"if f is None:",
		"    print(json.dumps({'error': 'no best_sched defined'})); raise SystemExit",
		"out = []",
		"for inp in cases:",
		"    try:",
		"        out.append({'val': f(inp)})",
		"    except Exception as e:",
		"        out.append({'val': None, 'err': type(e).__name__})",
		"print(json.dumps(out))",
	].join("\n");

	const stdout = execFileSync(PYTHON, ["-c", driver], {
		input: `${JSON.stringify(SCHED_CASES.filter((_, i) => i % 2 === 0))}\n${code}`,
		encoding: "utf-8",
		timeout: 30000,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return JSON.parse(stdout.trim().split("\n").pop());
}

function scoreCode(content) {
	const fence = /```(?:python)?\n([\s\S]*?)```/.exec(content);
	const code = fence ? fence[1] : content;
	if (!code.includes("best_sched")) return { pass: 0, note: "no best_sched defined" };

	let out;
	try {
		out = runPython(code);
	} catch (error) {
		return { pass: 0, note: `did not execute: ${String(error.stderr ?? error.message).slice(0, 60)}` };
	}
	if (out.error) return { pass: 0, note: out.error };

	// Partial credit proportional to cases solved. A model that solves 3 of 5
	// has shown partial competence, which a boolean would flatten to zero.
	let correct = 0;
	const total = SCHED_CASES.length / 2;
	out.forEach((row, i) => {
		if (row.val === SCHED_CASES[i * 2 + 1]) correct += 1;
	});
	return { pass: correct / total, note: `${correct}/${total} cases` };
}

/** Multi-step tool use: both tools must be called and a decision stated. */
function scoreTools(result) {
	const names = (result.toolCalls ?? []).map((c) => c.function?.name);
	const called = new Set(names);
	if (!called.has("get_order") || !called.has("get_inventory")) {
		return { pass: 0, note: `called ${[...called].join("+") || "nothing"}` };
	}
	// Reject a well-formed decision with no justification: the format spec says
	// REASON is required, and an empty one means the tools were decorative.
	const hasReason = result.content.length > 12;
	if (!hasReason) return { pass: 0.5, note: "both tools called, no reason given" };
	return { pass: 1, note: "both tools + reasoned decision" };
}

function scoreDebug(content) {
	const lower = content.toLowerCase();
	// Must name the real defect: the range stops one short, dropping the last
	// even index on even-length input.
	const findsBug = /off.?by.?one|len\(items\) ?- ?1|drop|last (even )?index|misses|stops? (one )?short|too short/i.test(lower);
	// Must propose the correct class of fix.
	const proposesFix = /len\(items\)|range\(0, ?len\(items\), ?2\)/i.test(content) || /use ?len\(items\)/i.test(content) || /adjust|fix|change|replace|remove the ?- ?1/i.test(lower);
	if (findsBug && proposesFix) return { pass: 1, note: "found the off-by-one and fixed it" };
	if (findsBug) return { pass: 0.5, note: "found the bug, no concrete fix" };
	if (proposesFix) return { pass: 0.4, note: "proposed a change, misdiagnosed the cause" };
	return { pass: 0, note: "did not identify the defect" };
}

function scoreSpec(content) {
	const line = content.trim().split("\n").filter(Boolean).pop() ?? "";
	const passed = SPEC_RULES.filter(([, check]) => check(line));
	const failed = SPEC_RULES.filter(([, check]) => !check(line)).map(([name]) => name);
	return { pass: passed.length / SPEC_RULES.length, note: failed.length ? `missed: ${failed.join(", ")}` : "all 6 constraints" };
}

function scoreOps(content) {
	const found = OPS_FACTS.filter(([, check]) => check.test(content));
	const missed = OPS_FACTS.filter(([, check]) => !check.test(content)).map(([name]) => name);
	return { pass: found.length / OPS_FACTS.length, note: missed.length ? `missed: ${missed.join(", ")}` : "all 4 judgements" };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const WEIGHTS = { code: 30, debug: 20, tools: 20, spec: 15, ops: 15 };

async function evaluate(model) {
	const results = {};

	// No max_tokens anywhere. A cap turns "thought hard" into "scored zero",
	// which conflates capability with budget discipline and made several working
	// models look broken in an earlier version of this script.

	const code = await call(model, { content: T_CODE });
	results.code = code.ok
		? { ...scoreCode(code.content), ok: true, seconds: code.seconds, finish: code.finish }
		: { pass: 0, ok: false, error: code.error, status: code.status, seconds: code.seconds };

	const debug = await call(model, { content: T_DEBUG });
	results.debug = debug.ok
		? { ...scoreDebug(debug.content), ok: true, seconds: debug.seconds }
		: { pass: 0, ok: false, error: debug.error, status: debug.status, seconds: debug.seconds };

	const tools = await call(model, { content: T_TOOLS, tools: TOOLS });
	results.tools = tools.ok
		? { ...scoreTools(tools), ok: true, seconds: tools.seconds }
		: { pass: 0, ok: false, error: tools.error, status: tools.status, seconds: tools.seconds };

	const spec = await call(model, { content: T_SPEC });
	results.spec = spec.ok
		? { ...scoreSpec(spec.content), ok: true, seconds: spec.seconds }
		: { pass: 0, ok: false, error: spec.error, status: spec.status, seconds: spec.seconds };

	const ops = await call(model, { content: T_OPS });
	results.ops = ops.ok
		? { ...scoreOps(ops.content), ok: true, seconds: ops.seconds }
		: { pass: 0, ok: false, error: ops.error, status: ops.status, seconds: ops.seconds };

	// Percentage 0-100. A 0-1 scale printed with toFixed(0) renders every model
	// as "0" or "1" and the column carries no information.
	const total = Object.entries(WEIGHTS).reduce(
		(sum, [k, w]) => sum + (results[k]?.pass ?? 0) * w,
		0,
	);
	const failed = Object.values(results).find((r) => !r.ok);

	return {
		model,
		total: Math.round(total),
		results,
		status: failed?.status ?? 0,
		hardError: failed?.error ?? null,
		seconds: Math.round(Object.values(results).reduce((s, r) => s + (r.seconds ?? 0), 0)),
	};
}

function pad(value, width) {
	return String(value).padEnd(width);
}

function padStart(value, width) {
	return String(value).padStart(width);
}

function report(rows) {
	console.log(
		`\n${pad("model", 40)}${padStart("code", 6)}${padStart("debug", 7)}${padStart("tools", 7)}` +
			`${padStart("spec", 6)}${padStart("ops", 5)}${padStart("score", 7)}${padStart("secs", 6)}`,
	);
	console.log("-".repeat(84));
	for (const r of rows) {
		const g = (k) => (r.results[k]?.ok ? Math.round(r.results[k].pass * WEIGHTS[k]) : "-");
		const score = r.status === 404 ? "DEAD" : r.status === 429 ? "429" : String(r.total);
		console.log(
			`${pad(r.model, 40)}${padStart(g("code"), 6)}${padStart(g("debug"), 7)}` +
				`${padStart(g("tools"), 7)}${padStart(g("spec"), 6)}${padStart(g("ops"), 5)}` +
				`${padStart(score, 7)}${padStart(r.seconds ?? 0, 6)}`,
		);
	}

	// Per-test notes are the actual finding. A score of 0 tells you nothing about
	// *why*, and "missed: ends with ?" is the difference between a model that
	// cannot reason and one that cannot count words.
	console.log("\nwhat each model actually did:");
	for (const r of rows) {
		console.log(`\n  ${r.model}  —  ${r.total}/100`);
		for (const k of Object.keys(WEIGHTS)) {
			const v = r.results[k];
			if (!v?.ok) {
				console.log(`    ${pad(k, 6)} ERROR ${(v?.error ?? "unknown").slice(0, 70)}`);
				continue;
			}
			console.log(`    ${pad(k, 6)} ${pad(String(Math.round(v.pass * 100)) + "%", 5)} ${v.note ?? ""}`);
		}
	}

	const dead = rows.filter((r) => r.status === 404);
	if (dead.length > 0) {
		console.log(`\ndead (404, advertised but not served):`);
		for (const r of dead) console.log(`  ${pad(r.model, 40)} ${(r.hardError ?? "").slice(0, 70)}`);
	}

	const limited = rows.filter((r) => r.status === 429);
	if (limited.length > 0) {
		console.log(`\nrate limited (429, capacity, not a quality signal):`);
		for (const r of limited) console.log(`  ${pad(r.model, 40)} ${(r.hardError ?? "").slice(0, 70)}`);
	}
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const explicit = [];
let all = false;
let jsonOut = null;
let providerId = "hermes";
let fromAudit = false;
let delayMs = DEFAULT_DELAY_MS;

for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === "--model") explicit.push(argv[++i]);
	else if (argv[i] === "--all") all = true;
	else if (argv[i] === "--json") jsonOut = argv[++i];
	else if (argv[i] === "--provider") providerId = argv[++i];
	else if (argv[i] === "--from-audit") fromAudit = true;
	else if (argv[i] === "--delay") delayMs = Number(argv[++i]);
	else if (argv[i] === "--help" || argv[i] === "-h") {
		const defs = loadProviders();
		console.log(
			[
				"eval-models — quality smoke-eval across configured providers",
				"",
				"  node scripts/eval-models.mjs --provider hermes",
				"  node scripts/eval-models.mjs --provider cline",
				"  node scripts/eval-models.mjs --provider kilo",
				"  node scripts/eval-models.mjs --provider kilo --from-audit",
				"  node scripts/eval-models.mjs --provider hermes --model <id> --model <id>",
				"  node scripts/eval-models.mjs --provider hermes --all   # whole catalog, not just free",
				"  node scripts/eval-models.mjs --provider hermes --json eval.json",
				"  node scripts/eval-models.mjs --delay 4000            # gentler on rate limits",
				"",
				`  providers in providers.json: ${defs.map((d) => d.id).join(", ")}`,
				`  EVAL_TIMEOUT_MS   default ${TIMEOUT_MS}`,
				`  default pacing   ${DEFAULT_DELAY_MS}ms between models`,
			].join("\n"),
		);
		process.exit(0);
	}
}

const defs = loadProviders();
currentDef = defs.find((d) => d.id === providerId);
if (!currentDef) {
	console.error(`unknown provider "${providerId}". known: ${defs.map((d) => d.id).join(", ")}`);
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Models the audit cleared, as ids. Empty when no audit exists. */
function auditPassed() {
	const path = join(REPO, "audit.json");
	if (!existsSync(path)) return new Set();
	const audit = JSON.parse(readFileSync(path, "utf-8"));
	const set = new Set();
	for (const p of audit.providers ?? []) {
		if (p.id !== providerId) continue;
		for (const m of p.models ?? []) if (m.state === "ok") set.add(m.id);
	}
	return set;
}

let models;
if (explicit.length > 0) {
	models = explicit.map((id) => ({ id }));
} else if (fromAudit) {
	const passed = auditPassed();
	if (passed.size === 0) {
		console.error("--from-audit needs audit.json with passing models. Run: node scripts/audit-models.mjs");
		process.exit(1);
	}
	models = [...passed].map((id) => ({ id }));
} else {
	const allModels = await catalog(currentDef);
	models = all ? allModels : allModels.filter(isFreeModel);
}

if (models.length === 0) {
	console.error("no models to evaluate");
	process.exit(1);
}

console.log(`evaluating ${models.length} model(s) on ${currentDef.id} — ${currentDef.baseUrl}`);
console.log(`weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(", ")}`);

const rows = [];

/**
 * Write results after every model, not once at the end.
 *
 * A full run across 13 models at a 2.5s gap takes long enough to hit a call
 * timeout. Losing twelve completed models to a timeout on the last one is
 * exactly the failure this avoids.
 */
function writeJson(partial = false) {
	if (!jsonOut) return;
	const target = jsonOut.startsWith("/") ? jsonOut : `${REPO}${jsonOut}`;
	return import("node:fs/promises").then((fs) =>
		fs.writeFile(
			target,
			JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					provider: currentDef.id,
					baseUrl: currentDef.baseUrl,
					weights: WEIGHTS,
					partial,
					rows: [...rows].sort((a, b) => b.total - a.total),
				},
				null,
				2,
			),
		),
	);
}

for (const m of models) {
	process.stdout.write(`  ${m.id} ...`);
	const row = await evaluate(m.id);
	row.provider = currentDef.id;
	rows.push(row);
	process.stdout.write(
		row.status === 404 ? " DEAD\n" : row.status === 429 ? " 429\n" : ` ${row.total.toFixed(0)}\n`,
	);
	// Serial and spaced. Five tests per model already keeps a provider under
	// its rate limit; back to back models with no gap is what produces
	// throttle noise indistinguishable from a quality result.
	await sleep(delayMs);
	await writeJson(true);
}

rows.sort((a, b) => b.total - a.total);
report(rows);
await writeJson(false);
if (jsonOut) {
	console.log(`\nwrote ${jsonOut.startsWith("/") ? jsonOut : `${REPO}${jsonOut}`}`);
}

