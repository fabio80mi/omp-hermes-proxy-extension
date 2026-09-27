# OMP Hermes Proxy Extension

Registers the local Hermes proxy as an Oh My Pi (OMP) provider so every free model
the proxy exposes is available inside `omp` via `/model`.

## What it does

At startup the extension fetches the proxy catalog, writes it to disk, and
registers the filtered subset as the `hermes-proxy` provider. It refreshes
through OMP's native `refreshModels` hook, so the model list updates without
restarting OMP.

## Prerequisite

Start the Hermes proxy first:

```bash
hermes proxy start --provider nous
```

It listens on `http://localhost:8645/v1`.

## Install

```bash
omp plugin install /home/ubuntu/projects/omp-hermes-proxy-extension
```

The extension runs directly from `src/index.ts` — OMP is a Bun binary, so no
build step is needed. Edit the source and run `/reload`.

## Files

| File | Role |
|---|---|
| `src/index.ts` | Extension entrypoint: fetch, map, filter, register, probe |
| `config.json` | Policy only — hand-edited |
| `models.discovered.json` | Generated full catalog — git-ignored, never hand-edited |
| `models.json` | Offline seed — last-resort fallback only |
| `opencode.hermes.json` | Generated opencode provider block — paste manually |

The generated catalog and the seed are kept separate on purpose. If the
generator overwrote the seed, a proxy outage at boot would leave you with zero
models instead of yesterday's list.

## Configuration

All policy lives in `config.json`:

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:8645/v1` | Proxy endpoint. Overridable with `HERMES_PROXY_URL` |
| `apiKey` | `HermesProxyLocal` | Bearer token. Overridable with `HERMES_PROXY_KEY` |
| `freeOnly` | `true` | Register only zero-cost models |
| `requireChat` | `true` | Drop embeddings, rerankers, image and audio-only models |
| `requireTools` | `true` | Drop models that cannot call tools |
| `requireReasoning` | `false` | Require a reasoning block |
| `dedupeSnapshotVariants` | `true` | Collapse dated/batch snapshot duplicates |
| `verifyProbe` | `free` | `free`, `all`, or `off` — reachability check |
| `fetchTimeoutMs` | `5000` | Catalog fetch timeout |
| `maxContextWindow` | `2000000` | Clamp on advertised context |

Set `freeOnly: false` to register paid models too. Cost is mapped from the
proxy's per-token prices, so usage accounting stays accurate.

### What counts as free

A model is free when **both** prices are zero, or its id contains `:free`.

Both conditions are required. The catalog contains 34 asymmetric entries
(embeddings and rerankers) priced 0 on completion but non-zero on prompt, so
testing a single price field with an OR would advertise those as free. Price
alone is also not enough: some zero-cost models have no `:free` in their id, and
a name-only filter drops them.

## Fallback chain

1. **Proxy** — live fetch; writes the cache on success
2. **Cache** — `models.discovered.json` from the last successful fetch
3. **Seed** — `models.json`

The provider is never registered empty, and every fallback is reported by
`/hermes-status`.

## Use

```bash
omp
```

```
/model hermes-proxy/stealth/space-bunny-alpha
/hermes-status
/hermes-refresh
```

> `--model hermes-proxy/...` is not supported on the CLI; use `/model` in
> interactive OMP.

`omp models refresh` also refreshes this provider.

## Verification probe

Catalog presence is not availability. A model can stay listed while the proxy
answers 404 (retired) or 429 (upstream at capacity). After each successful
fetch the extension sends a one-token completion per free model and records the
result in the cache.

Probe results are reported but never used to filter the list — a transient 429
should not make a model vanish from your picker.

## Notes

- `omp models --json` prints an identical `thinking` array for every model. That
  column is computed by the OMP binary and ignores `thinkingLevelMap`; the
  interactive `/thinking` picker uses the registered metadata and is correct.
- Reasoning levels are mapped from each model's advertised effort vocabulary. A
  model with mandatory reasoning gets `off: null`, which prevents OMP from
  offering a level the endpoint rejects with HTTP 400.

## opencode

Each successful refresh also writes `opencode.hermes.json`, an
`opencode.jsonc` provider block covering the same models. opencode has no
discovery mechanism comparable to OMP's, so it has to be pasted in by hand.

Copy the `"hermes"` block from that file into
`~/.config/opencode/opencode.jsonc`, replacing the existing `"hermes"`
provider. Do not paste the surrounding wrapper.

The extension never writes to your opencode config.

Field mapping differs from the OMP registration:

| opencode | Source |
|---|---|
| `limit.context` | `context_length` |
| `limit.output` | `top_provider.max_completion_tokens` |
| `modalities.input` | `text` and `image` only — opencode declares no video/audio/file input modality |
| `variants.<level>` | one entry per advertised reasoning effort, each setting `reasoningEffort` |

`apiKey` holds the raw token. opencode's `openai-compatible` provider builds
the `Authorization` header itself, so a `Bearer ` prefix there would be sent
twice.

## Troubleshooting

### Models don't update

Run `/hermes-refresh` inside OMP, or `omp models refresh` from the shell.

### Check which source is in use

```
/hermes-status
```

Reports the source (`proxy`, `cache`, or `seed`), catalog size, when the cache
was written, and probe results.

### Proxy auth or port changed

Set `HERMES_PROXY_URL` / `HERMES_PROXY_KEY`, or edit `config.json`.
