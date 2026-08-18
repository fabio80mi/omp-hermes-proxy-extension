const BASE_URL = "http://localhost:8645/v1";
const API_KEY = "Bearer HermesProxyLocal";
async function loadModels() {
    // Load local config first
    let config = { models: [] };
    try {
        const fs = await import("fs");
        const path = await import("path");
        const local = path.join(process.cwd(), "models.json");
        const content = fs.readFileSync(local, "utf-8");
        config = JSON.parse(content);
    }
    catch {
        // no local config
    }
    // If autodiscover is explicitly false, use local models only
    if (config.autodiscover === false) {
        return config.models;
    }
    // Otherwise try API first, fallback to local
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(`${BASE_URL}/models`, {
            headers: { Authorization: API_KEY },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const apiModels = (data.data || [])
            .filter((m) => m.id?.includes(":free"))
            .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: true,
            input: Array.isArray(m.metadata?.input) ? m.metadata.input : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.context_window || 262144,
            maxTokens: m.max_completion_tokens || 8192,
        }));
        if (apiModels.length > 0)
            return apiModels;
    }
    catch {
        // fall through to local config
    }
    return config.models;
}
export default async function (pi) {
    const MODELS = await loadModels();
    if (!MODELS.length)
        return;
    pi.registerProvider("hermes-proxy", {
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        api: "openai-completions",
        models: MODELS.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
            id,
            name,
            reasoning,
            input,
            cost,
            contextWindow,
            maxTokens,
        })),
    });
}
//# sourceMappingURL=index.js.map