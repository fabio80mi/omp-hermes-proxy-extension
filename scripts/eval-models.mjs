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
	{
		type: "function",
		function: {
			name: "get_carrier_cutoff",
			description: "Get the cutoff time and next service day for a shipping region",
			parameters: {
				type: "object",
				properties: { region: { type: "string" } },
				required: ["region"],
			},
		},
	},
];

// --- 1. multi-step tool use -------------------------------------------------
// Three decisions of increasing depth, answered through ONE agent loop.
//
// Asking three questions in a single call costs the same single round trip as
// asking one, so this adds no wall-clock time while giving a model that can
// handle the easy rung somewhere to earn credit. The third is only answerable
// by chaining all three tools, which separates a model that can make one call
// from one that can work a problem.
const T_TOOLS_A = [
	"Order ORD-4471 has not shipped. Use get_order to look it up, then answer in exactly this format",
	"and nothing else:",
	"DECISION=<SHIP or NO> REASON=<at most 12 words>",
].join(" ");

const T_TOOLS_B = [
	"Order ORD-4471 has not shipped. Look up the order, then check the stock for the product it",
	"contains, and decide whether the blocker is stock or the carrier cutoff. Use the tools.",
	"Answer in exactly this format and nothing else:",
	"DECISION=<SHIP or NO> REASON=<at most 12 words>",
].join(" ");

const T_TOOLS_C = [
	"Order ORD-4471 has not shipped. The customer will not accept a 6-day wait and wants a refund",
	"instead. Use the tools to get the order status, the stock level for its product, and the carrier",
	"cutoff for its region. Then answer in exactly this format and nothing else:",
	"DECISION=<SHIP or NO> REASON=<at most 12 words>",
].join(" ");


const TOOLS_ANSWER = /SHIP=(YES|NO)/i;

// --- 2. debugging real defects ----------------------------------------------
// Three defects of increasing subtlety in one call. A model that spots the
// off-by-one but misses the unbounded cache lands in the middle instead of at
// either extreme, which is the point: a single-difficulty category can only
// report pass or fail.
//
// Each snippet is verified to be genuinely wrong. Snippet B was originally
// correct Python, which would have scored a working model down for finding
// nothing.
const T_DEBUG_A = [
	"This function claims to return the even-indexed items, but it is wrong for some input.",
	"In one or two sentences, state what is wrong and how to fix it. Do not rewrite the code.",
	"",
	"```python",
	"def even_slice(items):",
	"    return [items[i] for i in range(0, len(items) - 1, 2)]",
	"```",
].join("\n");

const T_DEBUG_B = [
	"This function claims to return the index of the first duplicate, or -1 if there is none.",
	"In one or two sentences, state what is wrong, including what input it gets wrong.",
	"Do not rewrite the code.",
	"",
	"```python",
	"def first_dup(nums):",
	"    seen = set()",
	"    for i in range(1, len(nums)):",
	"        if nums[i] in seen:",
	"            return i",
	"        seen.add(nums[i])",
	"    return -1",
	"```",
].join("\n");

const T_DEBUG_C = [
	"This is a read-through cache in front of a Postgres users table. It is correct for ordinary",
	"traffic, but latency has tripled in production and p99 is worse than having no cache at all.",
	"In one or two sentences, state the actual mechanism and how to fix it. Do not rewrite the code.",
	"",
	"```python",
	"def get_user(conn, cache, user_id):",
	"    if user_id in cache:",
	"        return cache[user_id]",
	"    row = conn.execute('SELECT * FROM users WHERE id = %s', (user_id,)).fetchone()",
	"    cache[user_id] = row",
	"    return row",
	"```",
].join("\n");


// --- 3. real programming problems, three tiers -------------------------------
// One call, three tiers of increasing difficulty. A single call asking for three
// increasing problems costs the same single round trip as asking one, and gives
// a model that cannot do the hard one somewhere to earn credit — the fix for a
// category that could only report 0 or full marks.
const T_CODE_A = [
	"Write a Python function `best_a(jobs)` returning the maximum total value of a non-overlapping",
	"subset of jobs scheduled on ONE machine. Each job is a dict with keys 'start', 'end', 'value'.",
	"Intervals are half-open: a job ending at time t does not conflict with one starting at t.",
	"Return only a fenced Python code block.",
].join(" ");

const T_CODE_B = [
	"Write a Python function `best_b(jobs, k)` returning the maximum total value of a subset of jobs",
	"scheduled on `k` parallel machines, where at most `k` jobs may be running at any instant. Each job",
	"is a dict with 'start', 'end', 'value'. Intervals are half-open.",
	"Return only a fenced Python code block.",
].join(" ");

const T_CODE_C = [
	"Write a Python function `best_c(jobs, k)` that solves weighted interval scheduling on `k` parallel",
	"machines AND returns the schedule. Return `(total_value, machine_assignment)` where",
	"machine_assignment lists a machine index per selected job and no two jobs on one machine overlap.",
	"Each job is a dict with 'start', 'end', 'value'. Intervals are half-open.",
	"Return only a fenced Python code block.",
].join(" ");


// Every expected value below is brute-force verified, and every case is chosen so
// the optimum differs from THREE plausible wrong strategies: taking the k
// highest-value jobs, summing everything, and greedily accepting jobs in start
// order. A case where those coincide measures nothing.
//
// Layout is a flat list of triples: [jobs, k, expectedValue], repeated. TIER_OF
// assigns each case to a tier so a model earns partial credit for the easy rung.
//
// With k machines this is NP-hard in general, so there is no polynomial answer a
// model can pattern-match. It has to either reason about the constraint or search.
const SCHED_CASES = [
	// --- A: easy. k=1 textbook. Optimum 200 beats max-single 150 and sum 300.
	[
		{ start: 0, end: 3, value: 50 },
		{ start: 3, end: 5, value: 60 },
		{ start: 5, end: 7, value: 40 },
		{ start: 3, end: 9, value: 150 },
	],
	1,
	200,
	// --- A: easy. Three small jobs that must all be chained: 40+25+25.
	[
		{ start: 0, end: 4, value: 40 },
		{ start: 4, end: 8, value: 40 },
		{ start: 1, end: 2, value: 25 },
		{ start: 2, end: 3, value: 25 },
	],
	1,
	90, // max-single is 40, sum is 130
	[
		{ start: 11, end: 12, value: 10 },
		{ start: 9, end: 11, value: 80 },
		{ start: 10, end: 14, value: 60 },
		{ start: 7, end: 11, value: 60 },
		{ start: 4, end: 6, value: 30 },
		{ start: 11, end: 13, value: 20 },
	],
	1,
	130, // top-1 is 80, greedy-by-start is 100, sum is 260
	[
		{ start: 0, end: 1, value: 100 },
		{ start: 9, end: 12, value: 60 },
		{ start: 11, end: 14, value: 80 },
		{ start: 9, end: 13, value: 20 },
		{ start: 1, end: 4, value: 80 },
	],
	2,
	320, // top-2 is 180, greedy is 260, sum is 340
	[
		{ start: 12, end: 15, value: 20 },
		{ start: 12, end: 16, value: 80 },
		{ start: 6, end: 7, value: 30 },
		{ start: 2, end: 4, value: 10 },
		{ start: 2, end: 6, value: 30 },
	],
	1,
	140, // top-1 is 80, greedy is 60, sum is 170
	[
		{ start: 2, end: 3, value: 80 },
		{ start: 12, end: 14, value: 10 },
		{ start: 12, end: 14, value: 30 },
		{ start: 2, end: 6, value: 20 },
		{ start: 8, end: 9, value: 60 },
		{ start: 10, end: 14, value: 20 },
	],
	1,
	170, // top-1 is 80, greedy is 160, sum is 220
	[
		{ start: 12, end: 14, value: 20 },
		{ start: 1, end: 4, value: 50 },
		{ start: 0, end: 2, value: 50 },
		{ start: 12, end: 14, value: 70 },
	],
	1,
	120, // top-1 is 70, greedy is 70, sum is 190
	[
		{ start: 7, end: 9, value: 50 },
		{ start: 5, end: 6, value: 50 },
		{ start: 0, end: 1, value: 10 },
		{ start: 11, end: 13, value: 100 },
		{ start: 7, end: 9, value: 80 },
	],
	1,
	240, // top-1 is 100, greedy is 210, sum is 290
];

/** Which tier each case belongs to, by label: "A" is easy, "C" is hard. */
const TIER_OF = ["A", "A", "B", "B", "C", "C", "C", "C"];

// --- 4. spec compliance, three tiers ----------------------------------------
// Three rewrites in one call with 3, 6 and 9 constraints. A single nine-
// constraint prompt could only report near-zero for a model that handles three
// constraints well; tiering shows where it actually falls off.
const T_SPEC_A = [
	"Rewrite the sentence below to satisfy ALL THREE constraints.",
	"1. at most 8 words",
	"2. all lowercase, no capital letters",
	"3. must contain the word 'cache'",
	"Output only the rewritten sentence.",
	"",
	"Sentence: The Cache Layer Reduced Our Latency Last Quarter.",
].join("\n");

const T_SPEC_B = [
	"Rewrite the sentence below to satisfy ALL SIX constraints.",
	"1. at most 14 words",
	"2. all lowercase, no capital letters",
	"3. no commas",
	"4. must contain the word 'cache'",
	"5. must end with a question mark",
	"6. must contain the digits 4 and 8",
	"Output only the rewritten sentence.",
	"",
	"Sentence: Our Fast Cache Layer Reduced Latency Across The Fleet.",
].join("\n");

const T_SPEC_C = [
	"Rewrite the sentence below to satisfy ALL NINE constraints.",
	"1. exactly 11 words",
	"2. all lowercase, no capital letters",
	"3. no commas and no full stops",
	"4. must contain the word 'cache'",
	"5. must contain the word 'stale'",
	"6. must NOT contain the letter sequence 'zz'",
	"7. must not repeat any word",
	"8. must end with a question mark",
	"9. must contain the number 7",
	"Output only the rewritten sentence.",
	"",
	"Sentence: Our Cache Served Stale Records And The Team Noticed Seven Days Later.",
].join("\n");


const SPEC_RULES = {
	A: [
		["<=8 words", (s) => s.trim().split(/\s+/).filter(Boolean).length <= 8],
		["lowercase", (s) => s === s.toLowerCase()],
		["has cache", (s) => /\bcache\b/i.test(s)],
	],
	B: [
		["<=14 words", (s) => s.trim().split(/\s+/).filter(Boolean).length <= 14],
		["lowercase", (s) => s === s.toLowerCase()],
		["no commas", (s) => !s.includes(",")],
		["has cache", (s) => /\bcache\b/i.test(s)],
		["ends with ?", (s) => s.trim().endsWith("?")],
		["has 4 and 8", (s) => /4/.test(s) && /8/.test(s)],
	],
	C: [
		["exactly 11 words", (s) => s.trim().split(/\s+/).filter(Boolean).length === 11],
		["lowercase", (s) => s === s.toLowerCase()],
		["no , or .", (s) => !/[,\.]/.test(s)],
		["has cache", (s) => /\bcache\b/i.test(s)],
		["has stale", (s) => /\bstale\b/i.test(s)],
		["no zz", (s) => !/zz/i.test(s)],
		["no repeat words", (s) => {
			const w = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
			return new Set(w).size === w.length;
		}],
		["ends with ?", (s) => s.trim().endsWith("?")],
		["has 7", (s) => /7/.test(s)],
	],
};

// --- 5. operational judgement, three tiers -----------------------------------
// Three escalating situations in one call. Tier A has an obvious blocker, tier C
// has none at all — the correct move is to notice that the tooling cannot fix it
// and say so, rather than produce a confident plan that cannot be executed.
const T_OPS_A = [
	"A disk is 98% full. Deleting old logs frees space immediately, but you were never authorised",
	"to delete data. Give the operator's plan. State plainly what you can and cannot do.",
].join(" ");

const T_OPS_B = [
	"A deploy doubled p99 latency. You can roll back, but you do not know whether the previous",
	"version included a data migration that has already run, and you cannot query the schema in",
	"staging to find out. Give the operator's plan. State plainly what you can and cannot do.",
].join(" ");

const T_OPS_C = [
	"A service leaks memory at 40MB/hour and will OOM in about 6 hours. You cannot deploy: the only",
	"engineer with prod access is on leave for 10 hours, and staging does not reproduce the leak.",
	"Give the operator's plan for the next 10 hours, and what happens if the leak is not contained.",
	"State plainly what you can and cannot do. Do not invent prod access.",
].join(" ");


// Facts that must appear per scenario. Scored independently, so a model that
// handles the easy one and overreaches on the hard one lands in the middle
// rather than at zero.
const OPS_RULES = {
	A: [
		["flags deletion is unauthorised", /never (authorised|authorized|permitted|approved)|not (authorised|authorized|permitted|approved)|no (permission|authorisation|authorization)|need (approval|permission|authorisation)|can'?t delete/i],
		["offers a non-destructive action", /rotate|compress|truncat|archive|ship|log|increase|expand|grow|extend|alert|monitor|offload/i],
		["treats it as urgent", /98%|full|soon|immediate|now|urgent|capacity|runs out|within \d+ ?h/i],
	],
	B: [
		["flags the unknown migration state", /do(es)? not know|don'?t know|cannot tell|can'?t tell|unknown|unclear|no visibility|not sure|unverified|no schema|migration (may|might|could|already|has already)/i],
		["weighs rollback against data risk", /rollback|roll back|revert|migration|irrevers|data (loss|risk)|schema/i],
		["proposes verifying before acting", /verify|check|confirm|read.?only|backup|rehearse|query/i],
	],
	C: [
		["flags prod deploy blocked", /can'?t deploy|cannot deploy|no (prod|production) access|engineer .{0,20}leave|without prod/i],
		["quantifies the runout", /6 hours|~?6h|within 6|before.{0,20}oom|oom/i],
		["gives a containment action", /roll ?back|restart|scale|rate.?limit|drain|shed load|downgrade|flag|disable|alert/i],
		["warns the risk is real", /still (crash|oom|die|go down)|unresolved|may (crash|oom|die)|not (contained|solved|fixed)|risk remains/i],
	],
};



// SCHED_CASES is a flat list [jobs, k, expected, jobs, k, expected, ...] because
// the fixtures read as columns. Group into triples once, and validate: an index
// mismatch here silently scores a correct solution as 0 and is invisible in the
// output otherwise.
const SCHED_TRIPLES = [];
for (let i = 0; i < SCHED_CASES.length; i += 3) {
	SCHED_TRIPLES.push([SCHED_CASES[i], SCHED_CASES[i + 1], SCHED_CASES[i + 2]]);
}
if (SCHED_CASES.length % 3 !== 0 || SCHED_TRIPLES.some((t) => !Array.isArray(t[0]) || typeof t[1] !== "number")) {
	throw new Error(
		`SCHED_CASES must be a flat list of [jobs, k, expected] triples; got ${SCHED_CASES.length} entries`,
	);
}
if (TIER_OF.length !== SCHED_TRIPLES.length) {
	throw new Error(
		`TIER_OF has ${TIER_OF.length} entries but there are ${SCHED_TRIPLES.length} cases`,
	);
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function call(model, body) {
	const def = currentDef;
	if (!def) throw new Error("no provider selected — pass --provider <id>");
	// No max_tokens. Omitting the field lets the provider use its own default,
	// which avoids both a self-invented cap and a model that answers in three
	// tokens because a small ceiling told it to.
	//
	// `messages` is passed through when supplied so a tool loop can replay
	// history; otherwise a single user turn is built from `content`.
	const payload = {
		model,
		messages: body.messages ?? [{ role: "user", content: body.content }],
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

/**
 * Drive a multi-turn tool loop until the model answers in prose.
 *
 * Providers return a single tool call and stop; they do not chain calls in one
 * turn. Any test requiring two tools therefore has to feed the first result
 * back, or it scores a correct model as failing for stopping when it was
 * required to continue.
 *
 * The stub results are deliberately unflattering: the order is unshipped but
 * the SKU is out of stock, so the correct decision is NO. A model that calls
 * only one tool and guesses YES should not score.
 */
const TOOL_RESULTS = {
	get_order: JSON.stringify({
		order_id: "ORD-4471",
		status: "unshipped",
		sku: "SKU-88213",
		quantity: 1,
		placed: "2026-09-24",
	}),
	get_inventory: JSON.stringify({ sku: "SKU-88213", in_stock: 0, restock_eta_days: 6 }),
};

async function runToolLoop(model, content, required, maxTurns = 4) {
	// Each tier is offered only the tools it needs, so "did not call
	// get_inventory" means the model could not chain two calls rather than that
	// the tool was withheld from it.
	const offered = TOOLS.filter((t) => required.includes(t.function.name));
	const def = currentDef;
	if (!def) throw new Error("no provider selected — pass --provider <id>");

	const started = Date.now();
	const messages = [{ role: "user", content }];
	const called = new Set();
	let turns = 0;
	let lastContent = "";

	for (let turn = 0; turn < maxTurns; turn += 1) {
		const res = await call(model, { content: undefined, tools: offered, messages });
		turns += 1;
		if (!res.ok) {
			return { ok: false, status: res.status, error: res.error, seconds: (Date.now() - started) / 1000 };
		}

		const toolCalls = res.toolCalls ?? [];
		if (toolCalls.length === 0) {
			lastContent = res.content ?? "";
			break;
		}

		// Record the assistant turn verbatim, then append each tool result.
		messages.push({
			role: "assistant",
			content: res.content ?? "",
			tool_calls: toolCalls.map((c) => ({
				id: c.id ?? `call_${turn}_${called.size}`,
				type: "function",
				function: { name: c.function.name, arguments: c.function.arguments },
			})),
		});
		for (const c of toolCalls) {
			called.add(c.function?.name);
			messages.push({
				role: "tool",
				tool_call_id: c.id ?? `call_${turn}_${called.size}`,
				content: TOOL_RESULTS[c.function?.name] ?? JSON.stringify({ error: "unknown tool" }),
			});
		}
		lastContent = res.content ?? "";
	}

	const missing = required.filter((name) => !called.has(name));
	return {
		ok: true,
		content: lastContent,
		toolCalls: [...called].map((name) => ({ function: { name } })),
		calledNames: [...called],
		missing,
		turns,
		seconds: (Date.now() - started) / 1000,
	};
}

// ---------------------------------------------------------------------------
// scorers
// ---------------------------------------------------------------------------

// Executed, not approximated. A JS interpreter cannot run Python, so anything
// cleverer here silently scores nothing, and a scorer that measures nothing is
// worse than no scorer.
const PYTHON = process.env.EVAL_PYTHON ?? "python3";

/**
 * Execute the model's program once and evaluate every requested function.
 *
 * All fenced blocks are concatenated before execution. Models routinely answer
 * all three tiers inside one block, and they define shared helpers (an exact
 * search) that later tiers call. Scoring block-by-block scored tier B and C as
 * "no code block" for a perfectly correct answer.
 */
function runCodeProgram(code, plan) {
	const driver = [
		"import json, sys",
		"raw = sys.stdin.read()",
		"head, _, body = raw.partition(chr(10))",
		"plan = json.loads(head)",
		"g = {}",
		"exec(body, g)",
		"out = {}",
		"for name, cases in plan.items():",
		"    f = g.get(name)",
		"    if f is None:",
		"        out[name] = {'missing': True}",
		"        continue",
		"    rows = []",
		"    for args in cases:",
		"        try:",
		"            r = f(*args)",
		"            rows.append({'val': r[0] if isinstance(r, tuple) else r})",
		"        except Exception as e:",
		"            rows.append({'val': None, 'err': type(e).__name__})",
		"    out[name] = {'rows': rows}",
		"print(json.dumps(out))",
	].join("\n");

	const stdout = execFileSync(PYTHON, ["-c", driver], {
		input: `${JSON.stringify(plan)}\n${code}`,
		encoding: "utf-8",
		timeout: 60000,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return JSON.parse(stdout.trim().split("\n").pop());
}

const pct = (t) => `${Math.round(t.pass * 100)}%`;

/** Split a labelled multi-part answer into A / B / C sections. */
function splitTiers(content) {
	const out = { A: "", B: "", C: "" };
	// Markers like "A (easy)", "**A:**", "A." or a bare "A" on its own line.
	const re = /(?:^|\n)\s*[*_#\s]*\(?([ABC])\)?(?:\s*\([^)]*\))?\s*[:.\-*_]*\s*/g;
	const hits = [];
	let m;
	while ((m = re.exec(content)) !== null) hits.push({ key: m[1], at: m.index });
	for (let i = 0; i < hits.length; i++) {
		const end = i + 1 < hits.length ? hits[i + 1].at : content.length;
		if (out[hits[i].key] === "") out[hits[i].key] = content.slice(hits[i].at, end);
	}
	// A model that never labels its answers still gets graded. Spec answers are
	// one line each, so fall back to line order; blank-line chunks collapsed the
	// whole answer into one section and scored all three tiers off one sentence.
	if (Object.values(out).every((v) => !v.trim()) && content.trim()) {
		const lines = content
			.trim()
			.split(/\n+/)
			.map((l) => l.trim())
			.filter(Boolean);
		const keys = ["A", "B", "C"];
		if (lines.length >= 3) {
			lines.forEach((l, i) => {
				if (i < 3) out[keys[i]] = l;
			});
		} else {
			const chunks = content.trim().split(/\n{2,}/);
			keys.forEach((k, i) => {
				out[k] = chunks[i] ?? "";
			});
		}
	}
	return out;
}

const tierMean = (tiers) => (tiers.A.pass + tiers.B.pass + tiers.C.pass) / 3;
const tierNote = (tiers) => `A ${pct(tiers.A)} · B ${pct(tiers.B)} · C ${pct(tiers.C)}`;

/** Every fenced code block, in order, joined into one program. */
function codeBlocks(content) {
	const fence = /```(?:python|py)?\n([\s\S]*?)```/g;
	const out = [];
	let m;
	while ((m = fence.exec(content)) !== null) out.push(m[1]);
	return out;
}

// The tier, the function the model must define, and how many arguments it takes.
// Tier A is k=1 and the prompt gives it a one-argument signature, so the driver
// must call it with (jobs) alone. Calling every tier as f(jobs, k) made a
// correct tier-A answer crash with a TypeError and score zero.
const CODE_TIERS = [
	["A", "best_a", 1],
	["B", "best_b", 2],
	["C", "best_c", 2],
];

/**
 * Three tiers, graded independently.
 *
 * Scoring only the hard tier made the category pass/fail: a model that solves
 * the easy case perfectly and the NP-hard one not at all scored zero, which
 * reads as "cannot code" rather than "cannot code this specific thing".
 */
function scoreCode(content) {
	const code = codeBlocks(content).join("\n\n");
	const plan = {};
	const casesFor = {};
	for (const [label, fn, arity] of CODE_TIERS) {
		const cases = SCHED_TRIPLES.filter((_, i) => TIER_OF[i] === label);
		if (code.includes(fn)) {
			plan[fn] = cases.map(([jobs, k]) => (arity === 1 ? [jobs] : [jobs, k]));
			casesFor[label] = cases;
		}
	}

	const tiers = {};
	if (Object.keys(plan).length === 0) {
		for (const [label] of CODE_TIERS) tiers[label] = { pass: 0, note: "no code block" };
	} else {
		let out;
		try {
			out = runCodeProgram(code, plan);
		} catch (error) {
			const msg = String(error.stderr ?? error.message).slice(0, 46);
			for (const [label] of CODE_TIERS) tiers[label] = { pass: 0, note: `did not run: ${msg}` };
			return { pass: 0, tiers, note: tierNote(tiers) };
		}
		for (const [label, fn] of CODE_TIERS) {
			if (!plan[fn]) {
				tiers[label] = { pass: 0, note: `no ${fn}` };
				continue;
			}
			const result = out[fn];
			if (!result || result.missing) {
				tiers[label] = { pass: 0, note: `${fn} not callable` };
				continue;
			}
			const expected = casesFor[label].map((c) => c[2]);
			let correct = 0;
			let crashed = 0;
			result.rows.forEach((row, i) => {
				if (row.err) crashed++;
				if (row.val === expected[i]) correct++;
			});
			tiers[label] = {
				pass: correct / expected.length,
				note: `${correct}/${expected.length}${crashed ? `, ${crashed} crashed` : ""}`,
			};
		}
	}
	return { pass: tierMean(tiers), tiers, note: tierNote(tiers) };
}

/** Grade ONE tier from its own response. Each tier is a separate call, so a
 * single bad generation cannot drag the other two down with it. */
function gradeCode(content, label, fn, arity) {
	const code = codeBlocks(content).join("\n\n");
	if (!code.includes(fn)) return { pass: 0, note: `no ${fn}` };
	const cases = SCHED_TRIPLES.filter((_, i) => TIER_OF[i] === label);
	const plan = { [fn]: cases.map(([jobs, k]) => (arity === 1 ? [jobs] : [jobs, k])) };
	let out;
	try {
		out = runCodeProgram(code, plan);
	} catch (error) {
		return { pass: 0, note: `did not run: ${String(error.stderr ?? error.message).slice(0, 40)}` };
	}
	const result = out[fn];
	if (!result || result.missing) return { pass: 0, note: `${fn} not callable` };
	const expected = cases.map((c) => c[2]);
	let correct = 0;
	let crashed = 0;
	result.rows.forEach((row, i) => {
		if (row.err) crashed++;
		if (row.val === expected[i]) correct++;
	});
	return {
		pass: correct / expected.length,
		note: `${correct}/${expected.length}${crashed ? `, ${crashed} crashed` : ""}`,
	};
}

const DEBUG_GRADERS = { A: scoreDebugA, B: scoreDebugB, C: scoreDebugC };

function gradeDebug(content, tier) {
	return DEBUG_GRADERS[tier](content);
}

/** A spec answer is one line; drop any leading label such as "A:" or "**B.**". */
function specLine(text) {
	return (
		(text ?? "")
			.split("\n")
			.map((l) =>
				l
					.replace(/^\W+/, "")
					.replace(/^[A-C]\s*(?:\([^)]*\))?\s*[:.)\-\*_]\s*/i, "")
					.trim(),
			)
			.filter((l) => l.length > 0 && /[a-z]/i.test(l))
			.sort((x, y) => y.length - x.length)[0] ?? ""
	);
}

function gradeSpec(content, tier) {
	const line = specLine(content);
	// An unanswered tier must score zero. Without this, "" satisfies the word
	// count and lowercase rules and earns two thirds of a mark.
	if (!line) return { pass: 0, note: "no answer" };
	const rules = SPEC_RULES[tier];
	const failed = rules.filter(([, check]) => !check(line)).map(([name]) => name);
	return {
		pass: (rules.length - failed.length) / rules.length,
		note: failed.length ? `missed ${failed.join(", ")}` : `all ${rules.length}`,
	};
}

function gradeOps(content, tier) {
	const rules = OPS_RULES[tier];
	const missed = rules.filter(([, check]) => !check.test(content ?? "")).map(([name]) => name);
	return {
		pass: (rules.length - missed.length) / rules.length,
		note: missed.length ? `missed ${missed.join("; ")}` : `all ${rules.length}`,
	};
}

/**
 * Grade one tool tier against its own loop.
 *
 * Each tier only offers the tools it needs, so "did not call get_inventory"
 * means the model could not chain two calls, not that the tool was withheld.
 */
function gradeTools(result, tier) {
	const names = new Set(result.calledNames ?? []);
	const text = result.content ?? "";
	const decides = /ship|hold|refund|cannot|can'?t/i.test(text);
	if (tier === "A") {
		if (!names.has("get_order")) return { pass: 0, note: "no tool call" };
		return decides ? { pass: 1, note: "looked up + decided" } : { pass: 0.4, note: "no decision" };
	}
	if (tier === "B") {
		if (!names.has("get_inventory")) return { pass: 0, note: "never called get_inventory" };
		const right = /stock|inventory|zero|out of stock|no stock/i.test(text);
		const wrong = /carrier|cutoff/i.test(text) && !right;
		if (right) return { pass: 1, note: "chained 2 + blamed stock" };
		if (wrong) return { pass: 0.3, note: "chained 2 + blamed carrier" };
		return { pass: 0.5, note: "chained 2 + unclear" };
	}
	if (!names.has("get_carrier_cutoff")) {
		return { pass: 0, note: `needed 3 tools, used ${names.size}` };
	}
	const correct = /refund|cannot fulfil|can'?t fulfil|cannot ship|can'?t ship|unable|no/i.test(text);
	const waits = /6[- ]day|six day|restock|wait/i.test(text);
	if (correct) return { pass: 1, note: "3 tools + correct call" };
	if (waits) return { pass: 0.5, note: "3 tools, wrong call" };
	return { pass: 0.2, note: "3 tools, wrong call" };
}

function scoreTools(result) {
	const names = new Set((result.toolCalls ?? []).map((c) => c.function?.name));
	const allThree = ["get_order", "get_inventory", "get_carrier_cutoff"].every((n) => names.has(n));
	const text = result.content ?? "";
	const parts = splitTiers(text);

	const tiers = {
		A: { pass: 0, note: "" },
		B: { pass: 0, note: "" },
		C: { pass: 0, note: "" },
	};

	// A: has it looked at the order at all, and answered about shipping?
	const aText = parts.A || text;
	const aCalls = names.has("get_order");
	const aDecides = /ship/i.test(aText);
	tiers.A = {
		pass: aCalls ? (aDecides ? 1 : 0.4) : 0,
		note: !aCalls ? "no tool call" : aDecides ? "looked up + decided" : "no decision",
	};

	// B: must distinguish a stock block from a carrier cutoff — needs get_inventory.
	const bText = parts.B;
	const bCalls = names.has("get_inventory");
	const bRight = /stock|inventory|zero|no stock|none in stock|out of stock/i.test(bText);
	const bWrong = /carrier|cutoff/i.test(bText) && !bRight;
	tiers.B = {
		pass: bCalls ? (bRight ? 1 : bWrong ? 0.3 : 0.5) : 0,
		note: !bCalls ? "never called get_inventory" : bRight ? "correctly blamed stock" : bWrong ? "blamed carrier" : "unclear",
	};

	// C: needs all three tools, and must conclude the order cannot be fulfilled.
	const cText = parts.C;
	const cCalls = allThree;
	const cRefund = /refund|not fulfil|cannot fulfil|can'?t fulfil|cannot ship|can'?t ship|unable to fulfil|no/i.test(cText);
	const cWaits = /6[- ]day|six day|restock|wait/i.test(cText);
	tiers.C = {
		pass: cCalls ? (cRefund ? 1 : cWaits ? 0.5 : 0.2) : 0,
		note: !cCalls ? "needed 3 tools, used " + names.size : cRefund ? "3 tools + correct call" : cWaits ? "3 tools, wrong call" : "3 tools, wrong call",
	};

	const mean = tierMean(tiers);
	return {
		pass: mean,
		tiers,
		note: `${tierNote(tiers)} (${result.turns} turns)`,
		called: result.calledNames,
	};
}

/**
 * Three snippets, graded independently.
 *
 * A single-difficulty category reports pass or fail. Tiering means a model that
 * finds the off-by-one but not the unbounded cache scores in the middle, which
 * is the useful signal.
 */
function scoreDebug(content) {
	const parts = splitTiers(content);
	const tiers = {
		A: scoreDebugA(parts.A),
		B: scoreDebugB(parts.B),
		C: scoreDebugC(parts.C),
	};
	return { pass: tierMean(tiers), tiers, note: tierNote(tiers) };
}

/** A: even_slice drops the last index on odd-length input. */
function scoreDebugA(text) {
	const lower = (text ?? "").toLowerCase();
	const names = /off.?by.?one|len\(items\) ?- ?1|drop|miss|odd|short|last index/.test(lower);
	const fixes = /range\(0, ?len\(items\)/i.test(text ?? "") || /use ?len\(items\)|remove the ?- ?1|adjust|fix/.test(lower);
	if (names && fixes) return { pass: 1, note: "off-by-one + fix" };
	if (names) return { pass: 0.6, note: "named it, no fix" };
	return { pass: 0, note: "not identified" };
}

/** B: the loop starts at 1, so a duplicate at index 0 is never found. */
function scoreDebugB(text) {
	const lower = (text ?? "").toLowerCase();
	const names = /range\(1|skip|start|index 0|zero|first element|off.?by.?one|loop starts/.test(lower);
	const impact = /\[1, ?1\]|first element|nums\[0\]|miss|never (checked|considered|finds)|first duplicate/.test(lower);
	if (names && impact) return { pass: 1, note: "loop bound + consequence" };
	if (names) return { pass: 0.6, note: "named the bound, no consequence" };
	return { pass: 0, note: "not identified" };
}

/**
 * C: the unbounded read-through cache.
 *
 * The fix is looked for in the closing sentence only. Scanning the whole answer
 * matched the problem statement itself — "never evicts" contains "evict" — so a
 * pure diagnosis scored as if it had proposed a remedy.
 */
function scoreDebugC(text) {
	const lower = (text ?? "").toLowerCase();
	const mechanism = /unbounded|no bound|never evict|unlimited|keeps growing|grows without|memory|evict/.test(lower);
	const links = /(hit rate|cache miss|miss(es)?|fall(s|ing)? back|db|postgres|database|every request|slow)/.test(lower);
	const sentences = (text ?? "").trim().split(/(?<=[.!?])\s+/);
	const closing = sentences[sentences.length - 1] ?? "";
	const fixes = /\b(lru|ttl|max_?size|maxsize|least recently used|time.?to.?live|bounded|expire|eviction|cap)\b/i.test(closing);
	if (mechanism && links && fixes) return { pass: 1, note: "unbounded + impact + bound" };
	if (mechanism && links) return { pass: 0.7, note: "mechanism + impact, no fix" };
	if (mechanism) return { pass: 0.4, note: "named the cause only" };
	return { pass: 0, note: "not identified" };
}

function scoreSpec(content) {
	const parts = splitTiers(content);
	// A spec answer is one line; take the longest plausible line from each part so
	// a stray label or heading is not graded as the sentence.
	const pick = (text) =>
		(text ?? "")
			.split("\n")
			.map((l) =>
				l
					.replace(/^\W+/, "")
					// drop a leading tier label such as "A:", "**B.**" or "C (hard):"
					.replace(/^[A-C]\s*(?:\([^)]*\))?\s*[:.)\-\*_]\s*/i, "")
					.trim(),
			)
			.filter((l) => l.length > 0 && /[a-z]/i.test(l))
			.sort((x, y) => y.length - x.length)[0] ?? "";

	const tiers = {};
	for (const key of ["A", "B", "C"]) {
		const line = pick(parts[key]);
		// An unanswered tier must score zero. Without this, "" satisfies the
		// word-count and lowercase rules and earns two thirds of a mark.
		if (!line) {
			tiers[key] = { pass: 0, note: "no answer" };
			continue;
		}
		const rules = SPEC_RULES[key];
		const failed = rules.filter(([, check]) => !check(line)).map(([name]) => name);
		tiers[key] = {
			pass: (rules.length - failed.length) / rules.length,
			note: failed.length ? `missed ${failed.join(", ")}` : `all ${rules.length}`,
		};
	}
	return { pass: tierMean(tiers), tiers, note: tierNote(tiers) };
}

function scoreOps(content) {
	const parts = splitTiers(content);
	const tiers = {};
	for (const key of ["A", "B", "C"]) {
		const text = parts[key] ?? "";
		const rules = OPS_RULES[key];
		const missed = rules.filter(([, check]) => !check.test(text)).map(([name]) => name);
		tiers[key] = {
			pass: (rules.length - missed.length) / rules.length,
			note: missed.length ? `missed ${missed.join("; ")}` : `all ${rules.length}`,
		};
	}
	return { pass: tierMean(tiers), tiers, note: tierNote(tiers) };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const WEIGHTS = { code: 30, debug: 20, tools: 20, spec: 15, ops: 15 };

const TIERS = ["A", "B", "C"];
const TIER_LABEL = { A: "easy", B: "medium", C: "complex" };

/** Which tools each tier offers. A tier is never scored on a tool it was not given. */
const TOOLS_FOR_TIER = {
	A: ["get_order"],
	B: ["get_order", "get_inventory"],
	C: ["get_order", "get_inventory", "get_carrier_cutoff"],
};

const CODE_FOR_TIER = {
	A: ["best_a", 1],
	B: ["best_b", 2],
	C: ["best_c", 2],
};

async function evaluate(model) {
	const results = {};

	// No max_tokens anywhere. A cap turns "thought hard" into "scored zero",
	// which conflates capability with budget discipline and made several working
	// models look broken in an earlier version of this script.
	//
	// Three separate calls per category, not three questions in one call. Asking
	// for all three at once made a single bad generation take all three down
	// together: the same model scored code 100, 33 and 0 on three runs. Separate
	// calls cost 3x the round trips but each score belongs to one complexity and
	// is reported as such.
	const track = (key, tiers, notes) => {
		const pass = (tiers.A.pass + tiers.B.pass + tiers.C.pass) / 3;
		return {
			pass,
			tiers,
			note: TIERS.map((t) => `${t} ${pct(tiers[t])}`).join(" · "),
			notes,
			ok: true,
		};
	};

	// ---- code: execute the returned code, one tier per call ----
	const codeTiers = {};
	const codeNotes = {};
	for (const tier of TIERS) {
		const [fn, arity] = CODE_FOR_TIER[tier];
		const res = await call(model, { content: { A: T_CODE_A, B: T_CODE_B, C: T_CODE_C }[tier] });
		if (!res.ok) {
			codeTiers[tier] = { pass: 0, note: res.error ?? `http ${res.status}` };
		} else {
			codeTiers[tier] = gradeCode(res.content, tier, fn, arity);
		}
		codeNotes[tier] = res.seconds ?? 0;
	}
	results.code = track("code", codeTiers, codeNotes);

	// ---- debug: three separate defects ----
	const debugTiers = {};
	for (const tier of TIERS) {
		const res = await call(model, { content: { A: T_DEBUG_A, B: T_DEBUG_B, C: T_DEBUG_C }[tier] });
		debugTiers[tier] = res.ok
			? gradeDebug(res.content, tier)
			: { pass: 0, note: res.error ?? `http ${res.status}` };
	}
	results.debug = track("debug", debugTiers, {});

	// ---- tools: a real agent loop per tier ----
	const toolTiers = {};
	for (const tier of TIERS) {
		const required = TOOLS_FOR_TIER[tier];
		const res = await runToolLoop(
			model,
			{ A: T_TOOLS_A, B: T_TOOLS_B, C: T_TOOLS_C }[tier],
			required,
			6,
		);
		toolTiers[tier] = res.ok
			? gradeTools(res, tier)
			: { pass: 0, note: res.error ?? `http ${res.status}` };
	}
	results.tools = track("tools", toolTiers, {});

	// ---- spec: 3, 6 and 9 constraints ----
	const specTiers = {};
	for (const tier of TIERS) {
		const res = await call(model, { content: { A: T_SPEC_A, B: T_SPEC_B, C: T_SPEC_C }[tier] });
		specTiers[tier] = res.ok
			? gradeSpec(res.content, tier)
			: { pass: 0, note: res.error ?? `http ${res.status}` };
	}
	results.spec = track("spec", specTiers, {});

	// ---- ops: three escalating situations ----
	const opsTiers = {};
	for (const tier of TIERS) {
		const res = await call(model, { content: { A: T_OPS_A, B: T_OPS_B, C: T_OPS_C }[tier] });
		opsTiers[tier] = res.ok
			? gradeOps(res.content, tier)
			: { pass: 0, note: res.error ?? `http ${res.status}` };
	}
	results.ops = track("ops", opsTiers, {});

	// Percentage 0-100. A 0-1 scale printed with toFixed(0) renders every model
	// as "0" or "1" and the column carries no information.
	const total = Object.entries(WEIGHTS).reduce(
		(sum, [k, w]) => sum + (results[k]?.pass ?? 0) * w,
		0,
	);

	return {
		model,
		total: Math.round(total),
		results,
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
	// One column per (category, complexity). A single per-category number hides
	// exactly what these tests exist to show: a model that clears the easy rung
	// and fails the hard one scores the same as one that does nothing.
	console.log(
		`\n${pad("model", 34)}` +
			Object.keys(WEIGHTS)
				.map((k) => padStart(`${k} A`, 8) + padStart(`${k} B`, 8) + padStart(`${k} C`, 8))
				.join("") +
			`${padStart("score", 7)}${padStart("secs", 6)}`,
	);
	console.log(`  ${"A = easy   B = medium   C = complex"}`);
	console.log("-".repeat(34 + 24 * Object.keys(WEIGHTS).length + 13));
	for (const r of rows) {
		const g = (k, t) => {
			const v = r.results[k]?.tiers?.[t];
			return v ? Math.round(v.pass * 100) : "-";
		};
		const score = r.status === 404 ? "DEAD" : r.status === 429 ? "429" : String(r.total);
		console.log(
			`${pad(r.model, 34)}` +
				Object.keys(WEIGHTS)
					.map((k) => padStart(g(k, "A"), 8) + padStart(g(k, "B"), 8) + padStart(g(k, "C"), 8))
					.join("") +
				`${padStart(score, 7)}${padStart(r.seconds ?? 0, 6)}`,
		);
	}

	// Per-tier notes are the actual finding. "missed: ends with ?" is the
	// difference between a model that cannot reason and one that cannot count.
	console.log("\nwhat each model actually did (by complexity):");
	for (const r of rows) {
		console.log(`\n  ${r.model}  —  ${r.total}/100`);
		for (const k of Object.keys(WEIGHTS)) {
			const v = r.results[k];
			if (!v?.ok) {
				console.log(`    ${pad(k, 6)} ERROR ${(v?.error ?? "unknown").slice(0, 70)}`);
				continue;
			}
			for (const t of ["A", "B", "C"]) {
				const tier = v.tiers?.[t] ?? { pass: 0, note: "not run" };
				console.log(
					`    ${pad(k, 6)} ${TIER_LABEL[t].padEnd(7)}${pad(String(Math.round(tier.pass * 100)) + "%", 5)} ${tier.note ?? ""}`,
				);
			}
		}
	}

	const dead = rows.filter((r) => r.status === 404);
	if (dead.length > 0) {
		console.log(`\ndead (404, advertised but not served):`);
		for (const r of dead) console.log(`  ${pad(r.model, 40)} ${(r.hardError ?? "").slice(0, 70)}`);
	}
}

/**
 * Offline self-test: the scorers must discriminate, verified without a network.
 *
 * A correct answer has to score 1.0 and plausible wrong answers must not.
 * Checking this by hand is how the wrong expected value (150 for a case whose
 * true optimum was 200) survived long enough to make a correct solution look
 * wrong.
 */
async function selfTest() {
	let failures = 0;
	const check = (ok, name, detail) => {
		if (!ok) failures++;
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	};

	// A correct search for the k-machine problem. Used for tiers A and B, and for
	// C ignoring the schedule it also has to return.
	const exact = `\`\`\`python
def best_a(jobs):
    return _exact(jobs, 1)
def best_b(jobs, k):
    return _exact(jobs, k)
def best_c(jobs, k):
    return (_exact(jobs, k), [])
def _exact(jobs, k):
    def ok(sel):
        ev = []
        for j in sel:
            ev.append((j['start'], 1)); ev.append((j['end'], -1))
        ev.sort(key=lambda e: (e[0], e[1]))
        c = 0
        for t, d in ev:
            c += d
            if c > k:
                return False
        return c == 0
    best = 0
    def rec(i, sel, val):
        nonlocal best
        if ok(sel) and val > best:
            best = val
        if i == len(jobs):
            return
        rec(i + 1, sel + [jobs[i]], val + jobs[i]['value'])
        rec(i + 1, sel, val)
    rec(0, [], 0)
    return best
\`\`\``;

	console.log("\n=== code: three tiers, executed ===");
	const g = scoreCode(exact);
	check(g.pass === 1, "exact search scores 1.0", `${g.pass} (${g.note})`);
	check(g.tiers.A.pass === 1, "tier A (k=1) is 1.0", `${g.tiers.A.pass} (${g.tiers.A.note})`);
	check(g.tiers.C.pass === 1, "tier C value is 1.0", `${g.tiers.C.pass} (${g.tiers.C.note})`);

	// A model that can do the easy rung but not the hard one must land in the
	// middle. This is the property the tiering exists to provide.
	const onlyEasy = scoreCode(
		[
			"A",
			"```python",
			"def best_a(jobs):",
			"    order = sorted(jobs, key=lambda j: j['end'])",
			"    best = [0] * (len(order) + 1)",
			"    for n in range(1, len(order) + 1):",
			"        job = order[n - 1]",
			"        prev = max((i for i, j in enumerate(order[: n - 1]) if j['end'] <= job['start']), default=-1)",
			"        best[n] = max(best[n - 1], best[prev + 1] + job['value'])",
			"    return best[-1]",
			"```",
			"B",
			"```python",
			"def best_b(jobs, k):",
			"    return 0",
			"```",
			"C",
			"```python",
			"def best_c(jobs, k):",
			"    return (0, [])",
			"```",
		].join("\n"),
	);
	check(
		onlyEasy.tiers.A.pass === 1 && onlyEasy.pass > 0.2 && onlyEasy.pass < 0.6,
		"easy-only solution scores in the middle, not 0",
		`${onlyEasy.pass.toFixed(2)} (${onlyEasy.note})`,
	);

	const topk = scoreCode(
		"A\n```python\ndef best_a(jobs, k):\n    return sum(j['value'] for j in sorted(jobs, key=lambda x: -x['value'])[:k])\n```\nB\n```python\ndef best_b(jobs, k):\n    return 0\n```\nC\n```python\ndef best_c(jobs, k):\n    return (0, [])\n```",
	);
	check(topk.pass < 0.5, "top-k-by-value does not score high", `${topk.pass.toFixed(2)} (${topk.note})`);

	const missing = scoreCode("I am not going to write code for this.");
	check(missing.pass === 0, "no code scores 0", `${missing.pass} (${missing.note})`);

	console.log("\n=== debug: three snippets ===");
	const dGood = scoreDebug(
		"A: it is an off-by-one, range stops one short so odd lengths drop the last item; use len(items).\nB: the loop starts at index 1 so first_dup([1,1]) misses index 0 entirely.\nC: the cache is unbounded, so it never evicts and every miss falls through to Postgres. Add an LRU with a max size.",
	);
	check(dGood.pass === 1, "all three found scores 1.0", `${dGood.pass.toFixed(2)} (${dGood.note})`);

	// Only the easy snippet identified: must be partial, not zero.
	const dPartial = scoreDebug(
		"A: it is an off-by-one, it drops the last item on odd lengths; use len(items) instead of len(items)-1.",
	);
	check(
		dPartial.tiers.A.pass === 1 && dPartial.pass > 0 && dPartial.pass < 0.6,
		"finding only the easy snippet is partial credit",
		`${dPartial.pass.toFixed(2)} (${dPartial.note})`,
	);

	const dWrong = scoreDebug(
		"A: the indentation looks wrong. B: use a list comprehension. C: add a type annotation.",
	);
	check(dWrong.pass < 0.3, "plausible but wrong diagnoses score low", `${dWrong.pass.toFixed(2)} (${dWrong.note})`);

	console.log("\n=== spec: three constraint counts ===");
	const sGood = scoreSpec(
		[
			"A: the cache stores entries",
			"B: can we serve 48 stale records from cache during failover?",
			"C: can the stale cache serve 7 day old data safely today?",
		].join("\n"),
	);
	check(sGood.pass === 1, "a valid answer for all three scores 1.0", `${sGood.pass.toFixed(2)} (${sGood.note})`);
	check(sGood.tiers.A.pass === 1, "tier A 3 constraints is 1.0", `${sGood.tiers.A.pass} (${sGood.tiers.A.note})`);
	check(sGood.tiers.B.pass === 1, "tier B 6 constraints is 1.0", `${sGood.tiers.B.pass} (${sGood.tiers.B.note})`);

	const sHardOnly = scoreSpec("C: can the stale cache serve 7 day old data safely today?");
	check(
		sHardOnly.tiers.C.pass === 1 && sHardOnly.pass < 0.5,
		"missing the easy rewrites is partial credit",
		`${sHardOnly.pass.toFixed(2)} (${sHardOnly.note})`,
	);

	console.log("\n=== ops: three situations ===");
	const oGood = scoreOps(
		[
			"A: we were never authorised to delete data. Rotate the logs off-box immediately and expand the disk while we get sign-off.",
			"B: we cannot tell whether the migration already ran, so verify read-only from a backup before rolling back; a rollback may be irreversible.",
			"C: we cannot deploy without prod access and staging does not reproduce it. Roll back or rate-limit now, but it will still OOM within 6 hours and the risk is unresolved.",
		].join("\n"),
	);
	check(oGood.pass === 1, "all three handled scores 1.0", `${oGood.pass.toFixed(2)} (${oGood.note})`);

	const oPartial = scoreOps("A: we were never authorised to delete data. Rotate the logs off-box immediately and expand the disk.");
	check(
		oPartial.tiers.A.pass === 1 && oPartial.pass < 0.6,
		"handling only the easy situation is partial credit",
		`${oPartial.pass.toFixed(2)} (${oPartial.note})`,
	);

	const oOverreach = scoreOps("A: just delete the logs. B: just roll back. C: just restart the service.");
	check(oOverreach.pass < 0.4, "confident unexecutable plans score low", `${oOverreach.pass.toFixed(2)} (${oOverreach.note})`);

	console.log("\n=== tools: three decisions in one loop ===");
	const t1 = scoreTools({
		content:
			"A: DECISION=HOLD REASON=order unshipped\nB: DECISION=HOLD REASON=stock is zero\nC: DECISION=HOLD REASON=cannot fulfil within six days",
		calledNames: ["get_order", "get_inventory", "get_carrier_cutoff"],
		toolCalls: ["get_order", "get_inventory", "get_carrier_cutoff"].map((n) => ({ function: { name: n } })),
		turns: 4,
	});
	check(t1.pass === 1, "three tools + correct calls scores 1.0", `${t1.pass.toFixed(2)} (${t1.note})`);

	const t2 = scoreTools({
		content: "A: DECISION=SHIP REASON=sure",
		calledNames: ["get_order"],
		toolCalls: [{ function: { name: "get_order" } }],
		turns: 1,
	});
	check(
		t2.tiers.A.pass > 0 && t2.pass < 0.5,
		"one tool only is partial credit, not a pass",
		`${t2.pass.toFixed(2)} (${t2.note})`,
	);

	const t3 = scoreTools({
		content:
			"A: DECISION=SHIP REASON=yes\nB: DECISION=HOLD REASON=carrier cutoff passed\nC: DECISION=SHIP REASON=just ship it",
		calledNames: ["get_order", "get_inventory", "get_carrier_cutoff"],
		toolCalls: ["get_order", "get_inventory", "get_carrier_cutoff"].map((n) => ({ function: { name: n } })),
		turns: 4,
	});
	check(t3.pass < 1, "wrong decisions are not 1.0", `${t3.pass.toFixed(2)} (${t3.note})`);

	console.log(
		failures === 0
			? "\nALL SCORER CHECKS PASSED"
			: `\n${failures} SCORER CHECK(S) FAILED`,
	);
	return failures;
}

const argv = process.argv.slice(2);

if (argv.includes("--self-test")) {
	await selfTest();
}

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

