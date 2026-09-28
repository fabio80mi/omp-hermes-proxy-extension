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
// A real defect that looks correct and passes a casual read: the cache is
// unbounded, so a pathological key distribution evicts everything and the
// "fast path" is slower than the database it fronts. The cause is a missing
// bound, not a syntax error, and a model that pattern-matches on off-by-one
// will misdiagnose it.
const T_DEBUG = [
	"This function is a read-through cache in front of a Postgres users table. It is correct",
	"for ordinary traffic but latency has tripled in production and p99 is worse than no cache.",
	"In one or two sentences, state what is actually wrong. Be specific about the mechanism.",
	"Do not rewrite the code.",
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

// --- 3. a real programming problem -------------------------------------------
// Weighted interval scheduling, scored by executing the returned code against a
// known input/output pair. An approximation, brute force, or wrong signature
// all score zero, and partial credit is proportional to how many cases pass.
const T_CODE = [
	"Write a Python function `best_sched(jobs, k)` returning the maximum total value of a",
	"subset of jobs that can be scheduled on `k` parallel machines with no overlap on any",
	"machine. Each job is a dict with keys 'start', 'end', 'value'. Intervals are half-open:",
	"a job ending at time t does not conflict with one starting at t.",
	"Return only a fenced Python code block.",
].join(" ");

// Every expected value below is brute-force verified, and every case is chosen so
// the optimum differs from THREE plausible wrong strategies: taking the k
// highest-value jobs, summing everything, and greedily accepting jobs in start
// order. A case where those coincide measures nothing.
//
// Layout is a flat list of triples: [jobs, k, expectedValue], repeated.
//
// With k machines this is NP-hard in general, so there is no polynomial answer a
// model can pattern-match. It has to either reason about the constraint or search.
const SCHED_CASES = [
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

// --- 4. spec compliance under many simultaneous constraints ------------------
// Six constraints that conflict if any one is forgotten. Counted individually so
// the score shows which constraint the model dropped.
// Nine constraints that fight each other. Six were previously satisfied by a
// single short sentence, so the test had no headroom; these cannot all be met
// without counting words, watching the tail, and avoiding a banned token.
const T_SPEC = [
	"Rewrite the sentence below to satisfy ALL nine constraints:",
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

const SPEC_RULES = [
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

// Grouped from the flat triple list, with a length check: an index mismatch here
// silently scores a correct solution as 0, and a wrong "expected" count is
// invisible in the output.
const CASE_TRIPLES = [];
for (let i = 0; i < SCHED_CASES.length; i += 3) {
	CASE_TRIPLES.push([SCHED_CASES[i], SCHED_CASES[i + 1], SCHED_CASES[i + 2]]);
}
if (SCHED_CASES.length % 3 !== 0 || CASE_TRIPLES.some((t) => t.length !== 3 || !Array.isArray(t[0]))) {
	throw new Error(`SCHED_CASES must be a flat list of [jobs, k, expected] triples; got ${SCHED_CASES.length} entries`);
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
	const def = currentDef;
	if (!def) throw new Error("no provider selected — pass --provider <id>");

	const started = Date.now();
	const messages = [{ role: "user", content }];
	const called = new Set();
	let turns = 0;
	let lastContent = "";

	for (let turn = 0; turn < maxTurns; turn += 1) {
		const res = await call(model, { content: undefined, tools: TOOLS, messages });
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
		"for jobs, k in cases:",
		"    try:",
		"        out.append({'val': f(jobs, k)})",
		"    except Exception as e:",
		"        out.append({'val': None, 'err': type(e).__name__})",
		"print(json.dumps(out))",
	].join("\n");

	const stdout = execFileSync(PYTHON, ["-c", driver], {
		input: `${JSON.stringify(CASE_TRIPLES.map(([jobs, k]) => [jobs, k]))}\n${code}`,
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
	CASE_TRIPLES.forEach(([, , expected], i) => {
		if (out[i]?.val === expected) correct += 1;
	});
	const total = CASE_TRIPLES.length;
	return { pass: correct / total, note: `${correct}/${total} cases` };
}

/**
 * Multi-step tool use.
 *
 * Requires both tools to have been called, and the decision to be correct. The
 * stub results make the order unshipped but the SKU out of stock with a 6-day
 * restock, so the right answer is NO. Calling both tools and answering YES means
 * the model read neither result.
 */
function scoreTools(result) {
	const called = new Set((result.toolCalls ?? []).map((c) => c.function?.name));
	const missing = result.missing ?? [];
	if (missing.length > 0) {
		return { pass: 0, note: `never called ${missing.join(", ")} over ${result.turns ?? 1} turn(s)` };
	}
	const decision = /SHIP=(YES|NO)/i.exec(result.content ?? "");
	if (!decision) {
		return { pass: 0.5, note: `both tools called, no SHIP= decision in the reply` };
	}
	if (decision[1].toUpperCase() !== "NO") {
		// Both tools were consulted and the answer is still wrong: the model
		// gathered the evidence and did not use it.
		return { pass: 0.5, note: "both tools called, but answered YES against zero stock" };
	}
	// The format spec also requires a reason, capped at 12 words.
	const reason = /REASON=(.*)/i.exec(result.content ?? "");
	if (!reason || reason[1].trim().split(/\s+/).length > 12) {
		return { pass: 0.7, note: "correct decision, missing or oversized REASON" };
	}
	return { pass: 1, note: `both tools over ${result.turns} turns, correct decision + reason` };
}

function scoreDebug(content) {
	const lower = content.toLowerCase();
	// The defect is an unbounded cache, so the cause must be identified as
	// unbounded growth or eviction, not as a syntax or indexing slip.
	const mechanism = /unbounded|no bound|never evict|unlimited|keeps growing|grows without|memory|evict/.test(lower);
	// A correct diagnosis connects the growth to the latency regression.
	const links = /(hit rate|cache miss|miss(es)?|fall(s|ing)? back|db|postgres|database|every request|slow)/.test(lower);
	// A real fix bounds the cache. Anchored to a specific bound, because a bare
	// "limit" or "drop" matches any sentence that happens to mention the problem.
	// The fix is looked for in the closing sentence only. Scanning the whole
	// answer matched the problem statement itself — "never evicts" contains
	// "evict" — so a pure diagnosis scored as if it had proposed a remedy.
	const closing = (content.trim().split(/(?<=[.!?])\s+/).pop() ?? "");
	const fixes = /\b(lru|ttl|max_?size|maxsize|least recently used|time.?to.?live|bounded|expire|eviction|cap)\b/i.test(closing);
	if (mechanism && links && fixes) return { pass: 1, note: "unbounded cache + why it hurts + a bound" };
	if (mechanism && links) return { pass: 0.7, note: "correct mechanism and impact, no fix proposed" };
	if (mechanism) return { pass: 0.4, note: "named the cause, did not connect it to latency" };
	return { pass: 0, note: "did not identify unbounded growth" };
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

	// A real agent loop, not a single request.
	//
	// This test needs BOTH tools, and no model can call two tools in one turn
	// without seeing the first result — providers return one tool call and stop.
	// Scoring the first response alone therefore fails every correct model for
	// stopping where it is required to continue, and reports a capability gap
	// that is really a missing tool-result round trip.
	const tools = await runToolLoop(model, T_TOOLS, ["get_order", "get_inventory"]);
	results.tools = tools.ok
		? { ...scoreTools(tools), ok: true, seconds: tools.seconds, turns: tools.turns }
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

	console.log("\n=== code: k-machine scheduling (executed) ===");
	const exact = `\`\`\`python
def best_sched(jobs, k):
    def ok(sel):
        ev = []
        for j in sel:
            ev.append((j['start'], 1)); ev.append((j['end'], -1))
        ev.sort(key=lambda e: (e[0], e[1]))
        c = 0
        for t, d in ev:
            c += d
            if c > k: return False
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
	const g = scoreCode(exact);
	check(g.pass === 1, "exact search scores 1.0", `${g.pass} (${g.note})`);

	const topk = scoreCode("```python\ndef best_sched(jobs, k):\n    return sum(j['value'] for j in sorted(jobs, key=lambda x: -x['value'])[:k])\n```");
	check(topk.pass < 0.5, "top-k-by-value does not score high", `${topk.pass} (${topk.note})`);

	const sumAll = scoreCode("```python\ndef best_sched(jobs, k):\n    return sum(j['value'] for j in jobs)\n```");
	check(sumAll.pass === 0, "sum-everything scores 0", `${sumAll.pass} (${sumAll.note})`);

	console.log("\n=== debug: unbounded cache ===");
	const d1 = scoreDebug("The cache is unbounded and never evicts, so it grows until the hit rate collapses and every read falls back to Postgres. Bound it with an LRU.");
	check(d1.pass === 1, "mechanism + impact + fix", `${d1.pass} (${d1.note})`);
	const d2 = scoreDebug("The cache is unbounded and never evicts, so it consumes memory and the hit rate drops.");
	check(d2.pass > 0 && d2.pass < 1, "cause without a fix is partial", `${d2.pass} (${d2.note})`);
	const d3 = scoreDebug("There is a missing await before the value is read.");
	check(d3.pass === 0, "a plausible wrong diagnosis scores 0", `${d3.pass} (${d3.note})`);

	console.log("\n=== spec: 9 conflicting constraints ===");
	const s1 = scoreSpec("can a stale cache entry still be served after 7 days?");
	check(s1.pass === 1, "a valid answer exists and scores 1.0", `${s1.pass} (${s1.note})`);
	const s2 = scoreSpec("can a stale cache entry be served after 7 days?");
	check(s2.pass < 1, "10 words is not 1.0", `${s2.pass.toFixed(3)} (${s2.note})`);
	const s3 = scoreSpec("Our cache served stale records to 7 users, daily.");
	check(s3.pass < 0.6, "capitals/comma/no-question scores low", `${s3.pass.toFixed(3)} (${s3.note})`);

	console.log("\n=== ops: judgement under missing authority ===");
	const o1 = scoreOps("I can't deploy: the only engineer with prod access is on leave for 10 hours. I can raise an alert. Without containment this will OOM in about 6 hours, so the risk remains.");
	check(o1.pass === 1, "recognises the authority gap and the runout", `${o1.pass} (${o1.note})`);
	const o2 = scoreOps("I will roll back the last deploy and add more memory, which resolves the leak.");
	check(o2.pass < 1, "confident but unexecutable plan is not 1.0", `${o2.pass} (${o2.note})`);

	console.log("\n=== tools: two-step chain ===");
	const t1 = scoreTools({ toolCalls: [{ function: { name: "get_order" } }, { function: { name: "get_inventory" } }], missing: [], turns: 3, content: "SHIP=NO REASON=SKU out of stock, 6 day restock" });
	check(t1.pass === 1, "both tools + correct NO + reason", `${t1.pass} (${t1.note})`);
	const t2 = scoreTools({ toolCalls: [{ function: { name: "get_order" } }], missing: ["get_inventory"], turns: 1, content: "SHIP=NO REASON=not shipped" });
	check(t2.pass === 0, "stopped after one tool scores 0", `${t2.pass} (${t2.note})`);
	const t3 = scoreTools({ toolCalls: [{ function: { name: "get_order" } }, { function: { name: "get_inventory" } }], missing: [], turns: 3, content: "SHIP=YES REASON=send it now" });
	check(t3.pass < 1, "wrong decision is not 1.0", `${t3.pass} (${t3.note})`);

	console.log(
		`\n${failures === 0 ? "ALL SCORER CHECKS PASSED" : `${failures} CHECK(S) FAILED — the eval would misreport`}`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

// The scorer check runs before any provider is selected, so it needs no keys
// and no network.
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

