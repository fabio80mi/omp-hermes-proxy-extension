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

const URL_BASE = (process.env.HERMES_PROXY_URL ?? "http://localhost:8645/v1").replace(/\/$/, "");
const KEY = process.env.HERMES_PROXY_KEY ?? "HermesProxyLocal";
const REPO = new URL("..", import.meta.url).pathname;

// Generous by default. Several models burn their whole budget on reasoning
// before emitting anything, and that is itself a finding worth recording.
const MAX_TOKENS = Number(process.env.EVAL_MAX_TOKENS ?? 4000);
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 280000);

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "Get current weather for a city",
			parameters: {
				type: "object",
				properties: { city: { type: "string" } },
				required: ["city"],
			},
		},
	},
];

// The correct answer is that 1 new replica gives 400 rps but needs 45s + 20s to
// become healthy, which cannot happen inside a 200ms p99 budget. Models that
// just do the arithmetic and answer "1 event" miss it.
const T_REASON = [
	"A deployment has 3 replicas. Each handles 100 rps. Traffic spikes to 400 rps for 9 minutes.",
	"Latency budget is 200ms p99. Autoscaler adds a replica every 45s, takes 20s to become healthy.",
	"Give a short numbered plan stating the MINIMUM number of autoscaler events needed to survive,",
	"or state clearly it is impossible.",
].join(" ");

const T_CODE = [
	"Write a Python function `parse_duration(s)` that turns '1h30m' into 5400.",
	"Handle '45s','2d','1w'. Return only a fenced code block, no explanation.",
].join(" ");

const T_IF = "Output exactly 3 lines. Line 1: the word OK. Line 2: the number of days in 2026. Line 3: the sum 17+25. No other text, no numbering, no punctuation beyond the number.";

const T_TOOL = "What is the weather in Oslo right now? Use the tool.";

const T_TRIV = "If a model scores 70.2% on Terminal-Bench 2.1 and 59.5% on SWE-bench Pro, which benchmark is higher and by how many percentage points? Answer in one sentence.";

const DURATION_CASES = [
	["1h30m", 5400],
	["45s", 45],
	["2d", 172800],
	["1w", 604800],
	["90m", 5400],
];

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function call(model, body) {
	const payload = {
		model,
		messages: [{ role: "user", content: body.content }],
		max_tokens: body.max_tokens ?? MAX_TOKENS,
		stream: false,
	};
	if (body.tools) {
		payload.tools = body.tools;
		payload.tool_choice = "auto";
	}
	if (body.effort) payload.reasoning_effort = body.effort;

	const started = Date.now();
	try {
		const res = await fetch(`${URL_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${KEY}`,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const text = await res.text();
		if (!res.ok) {
			let detail = text.slice(0, 160);
			try {
				const parsed = JSON.parse(text);
				detail = `${parsed.message ?? text}`.slice(0, 160);
			} catch {}
			return { ok: false, status: res.status, error: detail, seconds: (Date.now() - started) / 1000 };
		}
		const json = JSON.parse(text);
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
		return { ok: false, status: 0, error: String(error).slice(0, 160), seconds: (Date.now() - started) / 1000 };
	}
}

async function catalog() {
	const res = await fetch(`${URL_BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
	if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
	return (await res.json()).data ?? [];
}

// ---------------------------------------------------------------------------
// scorers
// ---------------------------------------------------------------------------

// The code test must actually run Python, not approximate it. Shelling out to
// python3 is the honest implementation: a JS interpreter cannot execute Python,
// so anything clever here is silently scoring nothing.
const PYTHON = process.env.EVAL_PYTHON ?? "python3";

function runPython(code) {
	// stdin carries two records: a JSON array of inputs, then the code. Read it
	// once — a second sys.stdin.read() would return nothing.
	const driver = [
		"import json, sys",
		"raw = sys.stdin.read()",
		"head, _, body = raw.partition(chr(10))",
		"cases = json.loads(head)",
		"g = {}",
		"exec(body, g)",
		"f = g.get('parse_duration')",
		"if f is None:",
		"    print(json.dumps({'error': 'no parse_duration defined'})); raise SystemExit",
		"out = []",
		"for inp in cases:",
		"    try:",
		"        out.append({'val': f(inp)})",
		"    except Exception as e:",
		"        out.append({'val': None, 'err': type(e).__name__})",
		"print(json.dumps(out))",
	].join("\n");

	const stdout = execFileSync(PYTHON, ["-c", driver], {
		input: `${JSON.stringify(DURATION_CASES.map(([i]) => i))}\n${code}`,
		encoding: "utf-8",
		timeout: 20000,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return JSON.parse(stdout.trim().split("\n").pop());
}

function scoreCode(content) {
	const fence = /```(?:python)?\n([\s\S]*?)```/.exec(content);
	const code = fence ? fence[1] : content;
	if (!code.includes("parse_duration")) {
		return { pass: 0, note: "no parse_duration defined" };
	}
	let out;
	try {
		out = runPython(code);
	} catch (error) {
		return { pass: 0, note: `did not execute: ${String(error.stderr ?? error.message).slice(0, 60)}` };
	}
	if (out.error) return { pass: 0, note: out.error };

	let correct = 0;
	out.forEach((row, idx) => {
		if (row.val === DURATION_CASES[idx][1]) correct += 1;
	});
	return { pass: correct === DURATION_CASES.length ? 1 : 0, note: `${correct}/${DURATION_CASES.length}` };
}

function scoreReasoning(content) {
	const lower = content.toLowerCase();
	const saw = ["impossible", "cannot", "not possible", "can't", "insufficient"].some((k) => lower.includes(k));
	return { pass: saw ? 1 : 0, note: saw ? "flagged the gap" : "answered anyway" };
}

function scoreInstructionFollowing(content) {
	const lines = content.split("\n").filter((l) => l.trim());
	const ok =
		lines.length === 3 &&
		lines[0].includes("OK") &&
		lines[1].includes("365") &&
		lines[2].includes("42");
	return { pass: ok ? 1 : 0, note: `${lines.length} lines` };
}

function scoreToolUse(result) {
	const call = result.toolCalls?.[0];
	if (!call) return { pass: 0, note: "no tool call" };
	let args = {};
	try {
		args = JSON.parse(call.function.arguments);
	} catch {}
	const ok = call.function.name === "get_weather" && /oslo/i.test(String(args.city ?? ""));
	return { pass: ok ? 1 : 0, note: ok ? `get_weather(${args.city})` : `wrong call: ${call.function.name}` };
}

function scoreTrivial(content) {
	return { pass: content.replace(/\s/g, "").includes("10.7") ? 1 : 0, note: "" };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const WEIGHTS = { code: 25, reasoning: 25, tools: 20, instruction: 15, trivial: 15 };

async function evaluate(model) {
	const results = {};

	const code = await call(model, { content: T_CODE });
	results.code = code.ok
		? { ...scoreCode(code.content), ok: true, seconds: code.seconds, finish: code.finish }
		: { pass: 0, ok: false, error: code.error, status: code.status, seconds: code.seconds };

	const reasoning = await call(model, { content: T_REASON });
	results.reasoning = reasoning.ok
		? {
				...scoreReasoning(reasoning.content),
				ok: true,
				empty: reasoning.content.trim() === "",
				finish: reasoning.finish,
				tokens: reasoning.completionTokens,
				seconds: reasoning.seconds,
			}
		: { pass: 0, ok: false, error: reasoning.error, status: reasoning.status, seconds: reasoning.seconds };

	const instruction = await call(model, { content: T_IF, max_tokens: 1200 });
	results.instruction = instruction.ok
		? { ...scoreInstructionFollowing(instruction.content), ok: true, seconds: instruction.seconds }
		: { pass: 0, ok: false, error: instruction.error, status: instruction.status, seconds: instruction.seconds };

	const tools = await call(model, { content: T_TOOL, max_tokens: 1500, tools: TOOLS });
	results.tools = tools.ok
		? { ...scoreToolUse(tools), ok: true, seconds: tools.seconds }
		: { pass: 0, ok: false, error: tools.error, status: tools.status, seconds: tools.seconds };

	const trivial = await call(model, { content: T_TRIV, max_tokens: 1500 });
	results.trivial = trivial.ok
		? { ...scoreTrivial(trivial.content), ok: true, seconds: trivial.seconds }
		: { pass: 0, ok: false, error: trivial.error, status: trivial.status, seconds: trivial.seconds };

	const total = Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + (results[k]?.pass ?? 0) * w, 0) / 100;
	const failed = Object.values(results).find((r) => !r.ok);

	return { model, total, results, status: failed?.status ?? 0, hardError: failed?.error ?? null };
}

function pad(value, width) {
	return String(value).padEnd(width);
}

function padStart(value, width) {
	return String(value).padStart(width);
}

function report(rows) {
	console.log(
		`\n${pad("model", 42)}${padStart("code", 6)}${padStart("reason", 8)}${padStart("IF", 5)}${padStart("tool", 6)}${padStart("triv", 6)}${padStart("score", 8)}`,
	);
	console.log("-".repeat(81));
	for (const r of rows) {
		const g = (k) => (r.results[k]?.ok ? r.results[k].pass * WEIGHTS[k] : "-");
		const score = r.status === 404 ? "DEAD" : r.status === 429 ? "429" : r.total.toFixed(0);
		console.log(
			`${pad(r.model, 42)}${padStart(g("code"), 6)}${padStart(g("reasoning"), 8)}` +
				`${padStart(g("instruction"), 5)}${padStart(g("tools"), 6)}${padStart(g("trivial"), 6)}${padStart(score, 8)}`,
		);
	}

	const flagged = rows.filter((r) => Object.values(r.results).some((x) => x.empty));
	if (flagged.length > 0) {
		console.log(`\nreturned empty content after using their token budget:`);
		for (const r of flagged) {
			const which = Object.entries(r.results)
				.filter(([, v]) => v.empty)
				.map(([k]) => k)
				.join(", ");
			console.log(`  ${pad(r.model, 42)} ${which}`);
		}
	}

	const dead = rows.filter((r) => r.status === 404);
	if (dead.length > 0) {
		console.log(`\ndead (404, advertised but not served):`);
		for (const r of dead) console.log(`  ${pad(r.model, 42)} ${r.hardError ?? ""}`);
	}

	const limited = rows.filter((r) => r.status === 429);
	if (limited.length > 0) {
		console.log(`\nrate limited (429, capacity, not a quality signal):`);
		for (const r of limited) console.log(`  ${pad(r.model, 42)} ${(r.hardError ?? "").slice(0, 80)}`);
	}
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const explicit = [];
let all = false;
let jsonOut = null;

for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === "--model") explicit.push(argv[++i]);
	else if (argv[i] === "--all") all = true;
	else if (argv[i] === "--json") jsonOut = argv[++i];
	else if (argv[i] === "--help" || argv[i] === "-h") {
		console.log(
			[
				"eval-models — smoke-eval models through the local Hermes proxy",
				"",
				"  node scripts/eval-models.mjs",
				"  node scripts/eval-models.mjs --model <id> --model <id>",
				"  node scripts/eval-models.mjs --all        # every model in the catalog",
				"  node scripts/eval-models.mjs --json out.json",
				"",
				`  HERMES_PROXY_URL  default ${URL_BASE}`,
				`  HERMES_PROXY_KEY  default ${KEY}`,
				`  EVAL_MAX_TOKENS   default ${MAX_TOKENS}`,
			].join("\n"),
		);
		process.exit(0);
	}
}

const free = (m) => {
	const p = m.pricing ?? {};
	const zero = Number(p.prompt ?? -1) === 0 && Number(p.completion ?? -1) === 0;
	return m.id.includes(":free") || zero;
};

let models;
if (explicit.length > 0) {
	models = explicit.map((id) => ({ id }));
} else {
	const all_models = await catalog();
	models = all ? all_models : all_models.filter(free);
}

if (models.length === 0) {
	console.error("no models to evaluate");
	process.exit(1);
}

console.log(`evaluating ${models.length} model(s) against ${URL_BASE}`);
console.log(`weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(", ")}`);

const rows = [];
for (const m of models) {
	process.stderr.write(`  ${m.id} ...`);
	const row = await evaluate(m.id);
	rows.push(row);
	process.stderr.write(
		row.status === 404 ? " DEAD\n" : row.status === 429 ? " 429\n" : ` ${row.total.toFixed(0)}\n`,
	);
}

rows.sort((a, b) => b.total - a.total);
report(rows);

if (jsonOut) {
	const fs = await import("node:fs/promises");
	const target = jsonOut.startsWith("/") ? jsonOut : `${REPO}${jsonOut}`;
	await fs.writeFile(
		target,
		JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: URL_BASE, weights: WEIGHTS, rows }, null, 2),
	);
	console.log(`\nwrote ${target}`);
}
