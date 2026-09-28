/**
 * Shared provider core: environment loading, catalog discovery, free-model
 * detection, model mapping, capability probing, and opencode rendering.
 *
 * Plain JS with JSDoc types so both the OMP extension (TypeScript) and the
 * CLI scripts (node) can import it without a build step.
 *
 * Three lessons from measuring real providers are baked in here. Each one
 * caused confidently wrong answers before it was found:
 *
 *   1. Some providers gate models behind SDK-identity headers. Without them a
 *      working model answers 403 and looks dead. Headers are per-provider
 *      config, never guessed.
 *   2. Some providers wrap the OpenAI response shape in an extra envelope.
 *      Reading the wrong level yields no content and looks like a dead model.
 *   3. Thinking models spend their whole token budget on reasoning. A small
 *      max_tokens makes them return `finish_reason: "length"` with no content,
 *      which is indistinguishable from broken unless you read finish_reason.
 *
 * A fourth, about honesty: HTTP 429 means throttled, not dead. A 429 is never
 * allowed to become a permanent "unavailable" verdict.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(HERE, "..");

export const PROVIDERS_PATH = join(ROOT_DIR, "providers.json");
export const AUDIT_PATH = join(ROOT_DIR, "audit.json");

/**
 * Floor for probe token budgets. Reasoning models routinely burn 100-900
 * tokens before emitting anything; probing with less than this reports working
 * models as dead.
 */
export const PROBE_MIN_TOKENS = 1500;

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

/**
 * Minimal .env reader. Deliberately not a dependency: keys live in one file
 * that is git-ignored, and the format needed is a dozen lines of parsing.
 *
 * Existing process.env always wins, so a real environment variable overrides
 * the file without any extra logic at the call site.
 */
export function loadDotEnv(path = join(ROOT_DIR, ".env")) {
	if (!existsSync(path)) return {};
	const parsed = {};
	for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		parsed[key] = value;
		if (process.env[key] === undefined) process.env[key] = value;
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// provider definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProviderDef
 * @property {string}   id             OMP provider id
 * @property {string}   label          display name
 * @property {boolean}  enabled
 * @property {string}   baseUrl
 * @property {string}   [apiKeyEnv]    env var holding the credential
 * @property {string}   [apiKeyDefault]
 * @property {Record<string,string>} [headers]  extra headers, e.g. SDK identity
 * @property {"openai"|"cline"} [catalog]
 * @property {"pricing"|"clineFreeList"} [freeSource]
 * @property {string}   [modelsPath]   path appended to baseUrl for the catalog
 * @property {string}   [freePath]     path returning the provider's free list
 */

/** @returns {ProviderDef[]} */
export function loadProviders(path = PROVIDERS_PATH) {
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf-8"));
	return Array.isArray(parsed) ? parsed : (parsed.providers ?? []);
}

/** Strip a leading "Bearer " so the raw token is stored once. */
export function normalizeToken(value) {
	return String(value ?? "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * Resolve the credential for a provider. Returns "" when none is configured,
 * which is correct for the local Hermes proxy: it ignores Authorization.
 */
export function resolveKey(def) {
	const fromEnv = def.apiKeyEnv ? normalizeToken(process.env[def.apiKeyEnv]) : "";
	return fromEnv || normalizeToken(def.apiKeyDefault);
}

/** Build request headers, omitting Authorization entirely when there is no key. */
export function buildHeaders(def, extra = {}) {
	const headers = { ...(def.headers ?? {}), ...extra };
	const key = resolveKey(def);
	if (key) headers.Authorization = `Bearer ${key}`;
	return headers;
}

// ---------------------------------------------------------------------------
// catalog + free detection
// ---------------------------------------------------------------------------

function toPrice(value) {
	const parsed = Number(value);
	// Kilo encodes "not free" as the string "-1", and pads free models with "0".
	// Clamping negatives to zero inverts both, so a negative is explicitly not
	// free rather than "very cheap".
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Whether a model is free, using the provider's own signal when it publishes
 * one.
 *
 * Kilo is the cautionary case: it has a dedicated `isFree` boolean, and its
 * pricing field is a string that uses "-1" for paid. Inferring free from
 * pricing alone there counted 11 routers and both Lyria models as free, and
 * every one of them answered 402. An explicit flag is always preferred over
 * inference.
 */
export function isFreeModel(model) {
	if (typeof model.isFree === "boolean") return model.isFree;
	return isFreeByPricing(model);
}

/**
 * Zero on both price axes, or an explicit free marker in the id.
 *
 * Both conditions are required. An OR over price fields wrongly counts
 * embeddings and rerankers that are priced 0 on completion only; a name-only
 * check misses genuinely free models whose id carries no marker.
 */
export function isFreeByPricing(model) {
	if (String(model.id ?? "").includes(":free")) return true;
	const pricing = model.pricing ?? {};
	return toPrice(pricing.prompt) === 0 && toPrice(pricing.completion) === 0;
}

/**
 * Fetch the provider's catalog and reduce it to free chat models.
 *
 * @returns {Promise<{models: object[], source: string, catalogTotal: number, note?: string}>}
 */
export async function fetchFreeModels(def, { timeoutMs = 15000 } = {}) {
	const headers = buildHeaders(def, { Accept: "application/json" });

	// Cline publishes an explicit free list. Its own /models endpoint carries no
	// pricing at all, so this is the only trustworthy free signal it offers.
	if (def.freeSource === "clineFreeList") {
		const path = def.freePath ?? "/ai/cline/recommended-models";
		const response = await fetch(`${def.baseUrl}${path}`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = await response.json();
		const free = Array.isArray(body.free) ? body.free : [];
		return {
			models: free.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				description: m.description || "",
			})),
			source: "cline-free-list",
			catalogTotal: free.length,
		};
	}

	const path = def.modelsPath ?? "/models";
	const response = await fetch(`${def.baseUrl}${path}`, {
		headers,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = await response.json();
	const all = Array.isArray(body.data) ? body.data : [];
	const models = all.filter((m) => isFreeModel(m));
	return { models, source: all.some((m) => typeof m.isFree === "boolean") ? "isFree-flag" : "pricing", catalogTotal: all.length };
}

// ---------------------------------------------------------------------------
// response unwrapping
// ---------------------------------------------------------------------------

/**
 * Some gateways nest the OpenAI shape under `data`. Reading the wrong level
 * yields no content, which reads as a dead model rather than a shape mismatch.
 */
export function unwrapCompletion(payload) {
	if (!payload || typeof payload !== "object") return null;
	return payload.data && typeof payload.data === "object" ? payload.data : payload;
}

export function extractMessage(payload) {
	const body = unwrapCompletion(payload);
	const choice = body?.choices?.[0];
	return { message: choice?.message ?? null, finishReason: choice?.finish_reason ?? null, usage: body?.usage ?? null };
}

// ---------------------------------------------------------------------------
// capability probe
// ---------------------------------------------------------------------------

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "Get the current weather for a city",
			parameters: {
				type: "object",
				properties: { city: { type: "string" } },
				required: ["city"],
			},
		},
	},
];

async function post(def, modelId, payload, timeoutMs) {
	const response = await fetch(`${def.baseUrl}/chat/completions`, {
		method: "POST",
		headers: buildHeaders(def, { "Content-Type": "application/json" }),
		body: JSON.stringify({ model: modelId, stream: false, ...payload }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status}`);
		error.status = response.status;
		error.body = text.slice(0, 300);
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		const error = new Error("unparseable response body");
		error.status = response.status;
		throw error;
	}
}

/**
 * Probe one model for chat and tool-calling support.
 *
 * Verdicts are deliberately three-valued:
 *   ok      — answered, and tool calls when asked
 *   partial — answered, but no tool call emitted
 *   limited — finish_reason "length": spent the budget thinking, not broken
 *   throttled / dead / error — with the status that produced them
 */
export async function probeModel(def, modelId, { maxTokens = PROBE_MIN_TOKENS, timeoutMs = 120000 } = {}) {
	const budget = Math.max(maxTokens, PROBE_MIN_TOKENS);
	const verdict = {
		id: modelId,
		chat: false,
		tools: false,
		status: null,
		state: "error",
		detail: "",
		reasoningTokens: 0,
		completionTokens: 0,
	};

	try {
		const payload = await post(
			def,
			modelId,
			{ max_tokens: budget, messages: [{ role: "user", content: "Reply with exactly: PONG" }] },
			timeoutMs,
		);
		const { message, finishReason, usage } = extractMessage(payload);
		verdict.reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
		verdict.completionTokens = usage?.completion_tokens ?? 0;
		verdict.chat = Boolean(message?.content);

		if (finishReason === "length" && !verdict.chat) {
			// The model spent the entire budget reasoning. Not a failure.
			verdict.state = "limited";
			verdict.detail = `budget spent reasoning (${verdict.reasoningTokens} tokens), no answer yet`;
			return verdict;
		}
	} catch (error) {
		verdict.status = error.status ?? 0;
		if (verdict.status === 429) {
			verdict.state = "throttled";
			verdict.detail = "rate limited upstream — retry later, not dead";
		} else if (verdict.status === 402) {
			verdict.state = "paid";
			verdict.detail = "advertised free but requires credits";
		} else if (verdict.status === 404 || verdict.status === 410) {
			verdict.state = "dead";
			verdict.detail = String(error.body ?? "").slice(0, 120);
		} else {
			verdict.state = "error";
			// An aborted fetch carries a generic "This operation was aborted", which
			// hides the real cause. Name it so a timeout is not read as a
			// mysterious server error.
			const raw = String(error?.message ?? error ?? "");
			const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
			verdict.state = timedOut ? "timeout" : "error";
			verdict.detail = timedOut
				? `no response within ${timeoutMs}ms — retry later, not dead`
				: raw.slice(0, 120) || "unknown error";
		}
		return verdict;
	}

	try {
		const payload = await post(
			def,
			modelId,
			{
				max_tokens: budget,
				messages: [{ role: "user", content: "What is the weather in Oslo? Use the tool." }],
				tools: TOOLS,
				tool_choice: "auto",
			},
			timeoutMs,
		);
		const { message } = extractMessage(payload);
		verdict.tools = Boolean(message?.tool_calls);
	} catch (error) {
		// Tracked separately from `status`. Chat already succeeded, so a 429 on
		// the tool call is a throttle on the tool probe, not a reason to call
		// the model unavailable — and a "chat works" verdict carrying HTTP 429
		// reads as a contradiction in the report.
		verdict.toolStatus = error.status ?? 0;
		verdict.toolDetail = String(error?.message ?? error ?? "").slice(0, 80);
	}

	verdict.state = verdict.tools ? "ok" : verdict.chat ? "partial" : verdict.state;
	if (verdict.state === "ok") verdict.detail = "chat + tool calls";
	else if (verdict.state === "partial") {
		verdict.detail = verdict.toolStatus
			? `chat works; tool probe hit HTTP ${verdict.toolStatus} (${verdict.toolDetail})`
			: "chat works, no tool call emitted";
	}
	return verdict;
}

// ---------------------------------------------------------------------------
// mapping to OMP
// ---------------------------------------------------------------------------

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** @param {object} model @param {object} limits */
export function mapModel(model, limits = {}) {
	const maxContextWindow = limits.maxContextWindow ?? 2_000_000;
	const defaultMaxTokens = limits.defaultMaxTokens ?? 8192;
	const id = model.id;
	if (!id) return null;

	const advertised = model.top_provider?.max_completion_tokens;
	const contextWindow = Math.min(model.context_length ?? 262144, maxContextWindow);
	if (contextWindow <= 0) return null;

	const entry = {
		id,
		name: model.name ?? id,
		reasoning: model.reasoning !== undefined,
		input: ["text"],
		cost: {
			input: toPrice(model.pricing?.prompt) * 1e6,
			output: toPrice(model.pricing?.completion) * 1e6,
		},
		contextWindow,
		maxTokens:
			typeof advertised === "number" && advertised > 0
				? Math.min(advertised, contextWindow)
				: Math.min(defaultMaxTokens, contextWindow),
	};

	const modalities = model.architecture?.input_modalities ?? [];
	if (modalities.includes("image")) entry.input = ["text", "image"];

	const efforts = model.reasoning?.supported_efforts;
	if (efforts && efforts.length > 0) {
		const map = {};
		for (const level of THINKING_LEVELS) map[level] = efforts.includes(level) ? level : null;
		if (model.reasoning.mandatory) map.off = null;
		else if (efforts.includes("none")) map.off = "none";
		entry.thinkingLevelMap = map;
	}
	return entry;
}

/** Render a model as an opencode provider entry. */
export function toOpencodeModel(model) {
	const input = ["text"];
	if ((model.architecture?.input_modalities ?? []).includes("image")) input.push("image");
	const entry = {
		name: model.name ?? model.id,
		limit: {
			context: model.context_length ?? 262144,
			output: model.top_provider?.max_completion_tokens ?? 8192,
		},
		// opencode declares no video, audio, or file input modality.
		modalities: { input, output: ["text"] },
	};
	const efforts = model.reasoning?.supported_efforts;
	if (efforts && efforts.length > 0) {
		const variants = {};
		for (const level of THINKING_LEVELS) {
			if (efforts.includes(level)) variants[level] = { reasoningEffort: level };
		}
		if (efforts.includes("none") && !model.reasoning?.mandatory) variants.none = { reasoningEffort: "none" };
		if (Object.keys(variants).length > 0) entry.variants = variants;
	}
	return entry;
}
