/**
 * OMP extension: register the local Hermes proxy as an OMP LLM provider.
 *
 * Startup order:
 *   1. read config.json (policy)
 *   2. GET <baseUrl>/models from the proxy
 *   3. write the FULL catalog to models.discovered.json (atomic tmp+rename)
 *   4. register the filtered subset from that catalog
 *
 * Fallback chain when the proxy is unreachable: discovered cache -> seed
 * (models.json). Never registers an empty provider, never fails silently.
 *
 * Live model lists refresh through OMP's native `refreshModels` hook, so
 * `omp models refresh` and `/hermes-refresh` both work without a restart.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "hermes-proxy";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** Package root: the extension lives in <root>/src, data files sit beside package.json. */
const ROOT_DIR = join(MODULE_DIR, "..");

const CONFIG_PATH = join(ROOT_DIR, "config.json");
const CACHE_PATH = join(ROOT_DIR, "models.discovered.json");
const SEED_PATH = join(ROOT_DIR, "models.json");

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface HermesConfig {
	baseUrl: string;
	apiKey: string;
	fetchTimeoutMs: number;
	probeTimeoutMs: number;
	freeOnly: boolean;
	requireChat: boolean;
	requireTools: boolean;
	requireReasoning: boolean;
	maxContextWindow: number;
	defaultMaxTokens: number;
	dedupeSnapshotVariants: boolean;
	verifyProbe: "free" | "all" | "off";
	probeConcurrency: number;
	probeMaxTokens: number;
	minModelsToAccept: number;
}

const DEFAULT_CONFIG: HermesConfig = {
	baseUrl: "http://localhost:8645/v1",
	apiKey: "HermesProxyLocal",
	fetchTimeoutMs: 5000,
	probeTimeoutMs: 30000,
	freeOnly: true,
	requireChat: true,
	requireTools: true,
	requireReasoning: false,
	maxContextWindow: 2_000_000,
	defaultMaxTokens: 8192,
	dedupeSnapshotVariants: true,
	verifyProbe: "free",
	probeConcurrency: 3,
	probeMaxTokens: 1,
	minModelsToAccept: 1,
};

function loadConfig(): HermesConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<HermesConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ---------------------------------------------------------------------------
// Wire types (the proxy speaks OpenRouter's /v1/models schema)
// ---------------------------------------------------------------------------

interface WireModel {
	id?: string;
	name?: string;
	context_length?: number;
	pricing?: { prompt?: string; completion?: string };
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
		default_effort?: string;
	};
	top_provider?: { max_completion_tokens?: number };
	supported_parameters?: string[];
	expiration_date?: string | null;
}

function toPrice(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * A model is free when BOTH sides of its price are zero, or when the id carries
 * the ":free" marker.
 *
 * Both conditions are required. The catalog contains 34 asymmetric entries
 * (embeddings, rerankers) priced 0 on completion but non-zero on prompt, so an
 * OR on a single price field would advertise those as free. Price alone is also
 * not sufficient: zero-cost models exist whose id has no ":free" marker, so a
 * name-only filter drops them.
 */
function isFree(model: WireModel): boolean {
	if ((model.id ?? "").includes(":free")) return true;
	return toPrice(model.pricing?.prompt) === 0 && toPrice(model.pricing?.completion) === 0;
}

function isChatCapable(model: WireModel): boolean {
	const input = model.architecture?.input_modalities;
	const output = model.architecture?.output_modalities;
	if (!input || !output) return false;
	return input.includes("text") && output.includes("text");
}

function supportsTools(model: WireModel): boolean {
	return (model.supported_parameters ?? []).includes("tools");
}

/** Strip a trailing dated snapshot suffix: "foo-20260926" -> "foo". */
function snapshotBase(id: string): string {
	return id.replace(/-(\d{8})$/, "").replace(/:batch$/, "");
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function buildThinkingLevelMap(model: WireModel): Record<string, string | null> | undefined {
	const reasoning = model.reasoning;
	if (!reasoning) return undefined;
	const efforts = reasoning.supported_efforts;
	// No advertised vocabulary: leave the map off so OMP keeps its defaults.
	if (!efforts || efforts.length === 0) return undefined;

	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) {
		map[level] = efforts.includes(level) ? level : null;
	}
	if (reasoning.mandatory) {
		// Reasoning cannot be switched off on this model.
		map.off = null;
	} else if (efforts.includes("none")) {
		map.off = "none";
	}
	return map;
}

function mapModel(model: WireModel, config: HermesConfig): ProviderModelConfig | null {
	if (!model.id) return null;

	const modalities = model.architecture?.input_modalities ?? [];
	const input: ("text" | "image")[] = [];
	if (modalities.includes("text")) input.push("text");
	if (modalities.includes("image")) input.push("image");
	if (input.length === 0) input.push("text");

	const contextWindow = Math.min(model.context_length ?? 0, config.maxContextWindow);
	if (contextWindow <= 0) return null;

	const advertisedMax = model.top_provider?.max_completion_tokens;
	const maxTokens =
		typeof advertisedMax === "number" && advertisedMax > 0
			? Math.min(advertisedMax, contextWindow)
			: Math.min(config.defaultMaxTokens, contextWindow);

	const entry: ProviderModelConfig = {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning !== undefined,
		input,
		// The proxy quotes per-token prices; OMP expects per-million-token rates.
		cost: {
			input: toPrice(model.pricing?.prompt) * 1e6,
			output: toPrice(model.pricing?.completion) * 1e6,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
	};

	const thinkingLevelMap = buildThinkingLevelMap(model);
	if (thinkingLevelMap) entry.thinkingLevelMap = thinkingLevelMap;

	return entry;
}

interface Selection {
	wire: WireModel[];
	models: ProviderModelConfig[];
	rejected: { id: string; reason: string }[];
}

function selectModels(all: WireModel[], config: HermesConfig): Selection {
	const rejected: { id: string; reason: string }[] = [];
	const seen = new Set<string>();
	const wire: WireModel[] = [];

	for (const model of all) {
		if (!model.id) continue;

		if (config.freeOnly && !isFree(model)) {
			rejected.push({ id: model.id, reason: "paid" });
			continue;
		}
		if (config.requireChat && !isChatCapable(model)) {
			rejected.push({ id: model.id, reason: "not-chat" });
			continue;
		}
		if (config.requireTools && !supportsTools(model)) {
			rejected.push({ id: model.id, reason: "no-tools" });
			continue;
		}
		if (config.requireReasoning && model.reasoning === undefined) {
			rejected.push({ id: model.id, reason: "no-reasoning" });
			continue;
		}
		if (config.dedupeSnapshotVariants) {
			const base = snapshotBase(model.id);
			if (seen.has(base)) {
				rejected.push({ id: model.id, reason: "duplicate-variant" });
				continue;
			}
			seen.add(base);
		}
		wire.push(model);
	}

	const models = wire
		.map((model) => mapModel(model, config))
		.filter((model): model is ProviderModelConfig => model !== null);

	return { wire, models, rejected };
}

// ---------------------------------------------------------------------------
// Cache file
// ---------------------------------------------------------------------------

interface ProbeResult {
	status: number | string;
	ok: boolean;
	checkedAt: string;
	detail?: string;
}

interface CacheFile {
	version: number;
	generatedAt: string;
	source: "proxy" | "cache" | "seed";
	baseUrl: string;
	catalogTotal: number;
	selectedTotal: number;
	catalog: WireModel[];
	probes?: Record<string, ProbeResult>;
}

function writeCache(cache: CacheFile): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		// Write to a sibling temp file, then rename. rename() is atomic on the same
		// filesystem, so an interrupted write can never truncate the live cache.
		const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
		renameSync(tmp, CACHE_PATH);
	} catch (error) {
		report(`could not write cache: ${errorMessage(error)}`);
	}
}

function readCache(): CacheFile | null {
	try {
		if (!existsSync(CACHE_PATH)) return null;
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CacheFile;
		if (parsed.version !== 1 || !Array.isArray(parsed.catalog)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function readSeed(): WireModel[] {
	try {
		const parsed = JSON.parse(readFileSync(SEED_PATH, "utf-8")) as
			| { catalog?: WireModel[] }
			| WireModel[];
		if (Array.isArray(parsed)) return parsed;
		if (Array.isArray(parsed.catalog)) return parsed.catalog;
		return [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let logSink: ((message: string) => void) | undefined;
function report(message: string): void {
	if (logSink) logSink(message);
}

async function fetchCatalog(baseUrl: string, apiKey: string, timeoutMs: number): Promise<WireModel[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as { data?: WireModel[] };
		if (!Array.isArray(body.data)) throw new Error("malformed catalog: no data array");
		return body.data;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One-token completion confirming a listed model is actually reachable.
 * Catalog presence is not availability: a free model can stay listed while the
 * proxy answers 404 (retired) or 429 (upstream at capacity).
 */
async function probeModel(
	model: WireModel,
	baseUrl: string,
	apiKey: string,
	config: HermesConfig,
): Promise<ProbeResult> {
	const checkedAt = new Date().toISOString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.probeTimeoutMs);
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: model.id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: config.probeMaxTokens,
				stream: false,
			}),
			signal: controller.signal,
		});
		if (response.ok) return { status: response.status, ok: true, checkedAt };
		const detail = (await response.text()).slice(0, 200);
		return { status: response.status, ok: false, checkedAt, detail };
	} catch (error) {
		return { status: "error", ok: false, checkedAt, detail: errorMessage(error).slice(0, 200) };
	} finally {
		clearTimeout(timer);
	}
}

async function runProbes(
	models: WireModel[],
	baseUrl: string,
	apiKey: string,
	config: HermesConfig,
): Promise<Record<string, ProbeResult>> {
	const results: Record<string, ProbeResult> = {};
	const limit = Math.max(1, config.probeConcurrency);
	let cursor = 0;

	async function worker(): Promise<void> {
		while (cursor < models.length) {
			const model = models[cursor++];
			if (!model?.id) continue;
			results[model.id] = await probeModel(model, baseUrl, apiKey, config);
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, models.length) }, worker));
	return results;
}

// ---------------------------------------------------------------------------
// Load pipeline
// ---------------------------------------------------------------------------

interface LoadResult {
	models: ProviderModelConfig[];
	source: CacheFile["source"];
	catalogTotal: number;
	generatedAt?: string;
	probes?: Record<string, ProbeResult>;
	note?: string;
}

async function loadCatalog(config: HermesConfig, allowNetwork: boolean): Promise<LoadResult> {
	let source: CacheFile["source"] = "seed";
	let catalogTotal = 0;
	let note: string | undefined;

	if (allowNetwork) {
		try {
			const catalog = await fetchCatalog(config.baseUrl, config.apiKey, config.fetchTimeoutMs);
			catalogTotal = catalog.length;
			const selection = selectModels(catalog, config);
			if (selection.models.length >= config.minModelsToAccept) {
				const generatedAt = new Date().toISOString();
				let probes: Record<string, ProbeResult> | undefined;
				if (config.verifyProbe !== "off") {
					const targets =
						config.verifyProbe === "all" ? selection.wire : selection.wire.filter(isFree);
					probes = await runProbes(targets, config.baseUrl, config.apiKey, config);
				}
				writeCache({
					version: 1,
					generatedAt,
					source: "proxy",
					baseUrl: config.baseUrl,
					catalogTotal,
					selectedTotal: selection.wire.length,
					catalog: selection.wire,
					probes,
				});
				return {
					models: selection.models,
					source: "proxy",
					catalogTotal,
					generatedAt,
					probes,
					note,
				};
			}
			note = `proxy returned ${selection.models.length} usable models, below minimum ${config.minModelsToAccept}`;
		} catch (error) {
			note = `proxy unreachable: ${errorMessage(error)}`;
		}
	}

	const cache = readCache();
	if (cache && cache.catalog.length > 0) {
		const selection = selectModels(cache.catalog, config);
		if (selection.models.length >= config.minModelsToAccept) {
			report(`hermes-proxy: using cache from ${cache.generatedAt} (${note ?? "no network"})`);
			return {
				models: selection.models,
				source: "cache",
				catalogTotal: cache.catalogTotal,
				generatedAt: cache.generatedAt,
				probes: cache.probes,
				note,
			};
		}
		note = `${note ?? "cache unusable"}; cache had ${selection.models.length} usable models`;
	}

	const seed = readSeed();
	const seedSelection = selectModels(seed, config);
	if (seedSelection.models.length === 0) {
		report(`hermes-proxy: no models available (${note ?? "all sources empty"})`);
		return { models: [], source: "seed", catalogTotal: 0, note };
	}
	report(`hermes-proxy: falling back to seed models.json (${note ?? "no network, no cache"})`);
	return { models: seedSelection.models, source: "seed", catalogTotal: seed.length, note };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

function providerConfig(config: HermesConfig, models: ProviderModelConfig[]) {
	return {
		name: "Hermes Proxy",
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		authHeader: true,
		api: "openai-completions",
		models,
	};
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const config = loadConfig();
	let last: LoadResult = { models: [], source: "seed", catalogTotal: 0 };

	async function refresh(): Promise<ProviderModelConfig[]> {
		const result = await loadCatalog(config, true);
		last = result;
		if (result.models.length === 0) {
			report("hermes-proxy: refresh produced no models, keeping previous list");
		}
		return result.models;
	}

	// Populate eagerly so startup model selection and `omp --list-models` see the
	// provider. Pi awaits async extension factories before continuing.
	let initial: ProviderModelConfig[] = [];
	try {
		initial = await refresh();
	} catch (error) {
		report(`hermes-proxy: initial load failed: ${errorMessage(error)}`);
	}

	pi.registerProvider(PROVIDER_ID, {
		...providerConfig(config, initial),
		async refreshModels(context) {
			// Offline init phase, or a cancelled refresh: keep the current list.
			if (!context.allowNetwork || context.signal.aborted) return last.models;
			return refresh();
		},
	});

	pi.registerCommand("hermes-refresh", {
		description: "Re-fetch the Hermes proxy catalog and re-register hermes-proxy models",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify("hermes-proxy: refreshing catalog...");
			const models = await refresh();
			// After initial load these take effect immediately, no /reload needed.
			pi.unregisterProvider(PROVIDER_ID);
			pi.registerProvider(PROVIDER_ID, providerConfig(config, models));
			ctx.ui.notify(describe(last), models.length > 0 ? "info" : "error");
		},
	});

	pi.registerCommand("hermes-status", {
		description: "Show Hermes proxy model source, counts, and last probe results",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(describe(last), "info");
		},
	});

	pi.on("session_start", async () => {
		// Refresh once the session is live so startup is not blocked by the probe pass.
		void refresh();
	});
}

function describe(result: LoadResult): string {
	const lines = [
		`hermes-proxy: ${result.models.length} model(s) from ${result.source}` +
			(result.catalogTotal ? ` (catalog ${result.catalogTotal})` : ""),
	];
	if (result.generatedAt) lines.push(`  catalog written: ${result.generatedAt}`);
	if (result.note) lines.push(`  note: ${result.note}`);
	if (result.probes) {
		const entries = Object.entries(result.probes);
		const ok = entries.filter(([, probe]) => probe.ok).length;
		lines.push(`  probes: ${ok}/${entries.length} reachable`);
		for (const [id, probe] of entries) {
			if (probe.ok) continue;
			lines.push(`    ${id}: ${probe.status}${probe.detail ? ` ${probe.detail}` : ""}`);
		}
	}
	return lines.join("\n");
}
