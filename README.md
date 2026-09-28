# OMP Free Model Providers

Registers free models from several upstreams as Oh My Pi (OMP) providers, and
audits which of them actually work as agent models.

The original project registered the local Hermes proxy. It now also supports an
allowlist of additional providers, each with its own free-model rules, auth, and
quirks. The audit is the part worth trusting: catalog metadata says a model
exists, and only a real request says whether it works.

## What it does

At startup the extension reads `providers.json`, fetches each enabled
provider's free models, and registers them as separate OMP providers
(`verified-hermes`, `verified-cline`, `verified-kilo`). Models refresh through OMP's native
`refreshModels` hook, so lists update without restarting OMP.

Separately, `scripts/audit-models.mjs` probes every free model for chat and
tool-calling support, appends the result to an audit history, and derives
`audit-stable.json`: a model earns the `verified-` name by passing at least 2
of the last 3 runs, not by passing once. The same verdict generates the opencode
provider blocks.

Providers are registered separately rather than merged because model ids collide
across upstreams — `stealth/space-bunny-alpha` is available from Hermes, Cline,
and Kilo, and a merged list would silently drop two of them.

## Prerequisite

For the Hermes provider, start the proxy first:

```bash
hermes proxy start --provider nous
```

It listens on `http://localhost:8645/v1`. Cline and Kilo need API keys in `.env`.

## Install

```bash
git clone git@github.com:fabio80mi/omp-hermes-proxy-extension.git
cd omp-hermes-proxy-extension
cp .env.example .env     # then fill in CLINE_API_KEY and KILO_API_KEY
omp plugin install .
```

Or install from the remote directly:

```bash
omp plugin install git@github.com:fabio80mi/omp-hermes-proxy-extension.git
```

Then check what registered:

```bash
omp models --json | jq -r '.[] | select(.provider | test("hermes|cline|kilo")) | .id'
```

The extension runs directly from `src/index.ts` — OMP is a Bun binary, so no
build step is needed. Edit the source and run `/reload`.

## Credentials

Keys live in `.env`, which is git-ignored. Copy `.env.example` and fill it in.
A real environment variable always wins over the file, so you can also just
export them.

| Variable | Needed by |
|---|---|
| `HERMES_PROXY_KEY` | Hermes proxy. The proxy ignores `Authorization`, so any value works. |
| `CLINE_API_KEY` | Cline. Required for `cline-free/*`. |
| `KILO_API_KEY` | Kilo gateway. |

Never commit real keys. The repo's only credential file is `.env.example`, which
is empty.

## The audit

```bash
node scripts/audit-models.mjs                    # every enabled provider
node scripts/audit-models.mjs --provider kilo    # one provider
node scripts/audit-models.mjs --delay 2000       # slower, gentler
```

Probes are serial and spaced out. Parallel probes trigger provider rate limits,
and a 429 caused by our own concurrency is indistinguishable from a genuinely
throttled model — we would record confident wrong verdicts on a schedule.

### Verdicts

| Verdict | Meaning |
|---|---|
| `ok` | Chat and tool calls both work. |
| `partial` | Chat works, no tool call emitted. Usable, not an agent model. |
| `limited` | Burned the whole token budget reasoning before answering. **Not broken.** |
| `throttled` | HTTP 429. Rate limited upstream — retry later, never a permanent verdict. |
| `timeout` | No response in time. Inconclusive, retried once. |
| `paid` | Advertised free, answers 402. The provider's free flag was wrong. |
| `end_of_life` | HTTP 410. The provider retired the model and **keeps advertising it**, so disappearing from the catalogue will never detect this. |
| `dead` | HTTP 404. Absent, or not entitled to this account. |
| `auth_error` | HTTP 401/403. A problem with the key, never a model verdict. |

Throttled, timed-out, and errored models are re-probed once after a 20s pause
before the result is recorded.

### History and stability

Every run is appended to `audit-history/` and never overwritten, because a
single snapshot cannot tell a broken model from an unlucky attempt — our own
eval scored one model 100, 33 and 0 on three identical runs, and providers are
no steadier. The derived verdict lands in `audit-stable.json`:

| Status | Meaning | In picker |
|---|---|---|
| `stable` | Passed at least 2 of the last 3 runs. Proven. | yes |
| `known-good` | Worked, but not enough comparable evidence yet. | yes |
| `unstable` | Worked once, then failed. Worth retrying later. | yes |
| `rejected` | Reached, and never worked. | no |
| `unknown` | Never actually reached — every attempt was throttled. | no |
| `retired` | Permanently gone: `dead`, `end_of_life`, `paid`, or absent from the catalogue. | no |
| `new` | Too little history to judge. | no |

**A throttle is not evidence against a model.** `throttled`, `timeout`, `error`
and `limited` describe the moment, not the model: in one run, five Kilo models
returned 429 simultaneously, which says the provider was busy, not that those
five models are broken. They are excluded from the pass/fail tally and never
remove a model from the picker.

That is deliberate, and it is the tradeoff between a picker that is always
right and one that does not churn. Only a permanent condition — dead,
end-of-life, no longer free, absent from the catalogue — removes a model, and
those do not come back. Everything else leaves a model in place. If a
configuration depends on a model ID, it keeps working; the only models that
disappear are the ones that are genuinely gone.

The free catalogue changes over time — new models appear, existing ones stop
being free. Retirement is therefore expected, not a fault, and the generated
opencode file records it explicitly rather than leaving a silent gap.

Two rules worth knowing:

- **Absence is only retirement when the run that lacked it succeeded.** A
  provider whose catalogue fetch failed says nothing about its models; treating
  that as retirement would empty the picker after one bad request.
- **A model needs 2 usable runs before it can be `stable`.** After the first
  audit everything is `known-good` or `new`; the picker fills up rather than
  staying empty.

History is bounded at 10 runs (`KEEP` in `scripts/audit-history.mjs`). Older
runs are pruned after each run and the pruning is printed. The limit is asserted
to exceed the 3-run window, so pruning can never delete a run the current
verdict depends on. `audit-history/` is git-ignored; back it up, because losing
it silently resets stability to "no history".

## Why it probes serially

Parallel probes trigger provider rate limits, and a 429 caused by our own
concurrency is indistinguishable from a genuinely throttled model. We would then
record confident wrong verdicts on a schedule. A full run over ~45 models takes
a few minutes by design.

### Three things that produced wrong results

These are the reason the audit exists and the reason it is careful. Each was a
real measurement error, caught only by checking against OMP's own logs.

**Cline needs SDK-identity headers.** `cline-free/*` answers HTTP 403 "only
available via Cline product surfaces" without them, which reads exactly like a
dead model. The four required headers are in `providers.json`. A key alone is
not enough.

**Kilo encodes "not free" as the string `-1`.** Clamping a negative price to zero
made 11 routers and both Lyria models look free, and all 13 answered 402. Kilo
also publishes an explicit `isFree` boolean, which is always preferred over
inferring from price.

**Reasoning models need a real token budget.** Probing with `max_tokens: 32`
returns `finish_reason: "length"` and no content, which is indistinguishable
from a broken model unless you read the finish reason. The floor is 1500
tokens. At 32 tokens, 9 of Kilo's 20 free models looked dead; at 1500, they
answered.

A fourth trap, for a prober rather than this code: probe results are facts about
one client, not about models. A prober that cannot speak like the real client
will report false negatives on the best models it was meant to find.

## Quality eval

The audit asks "does this model work". The eval asks "is it any good". Both are
needed: a model can be alive and useless, or excellent and unreachable.

```bash
node scripts/eval-models.mjs --provider hermes            # all free models
node scripts/eval-models.mjs --provider cline --from-audit  # only audit-passing
node scripts/eval-models.mjs --provider kilo --json eval-kilo.json
node scripts/eval-models.mjs --provider hermes --model <id> --model <id>
node scripts/eval-models.mjs --delay 2500                 # gentler on rate limits
```

Five weighted checks: executable code (25), reasoning under an impossible
constraint (25), tool calls (20), instruction following (15), and a one-line
arithmetic comparison (15). Scores are 0-100.

The code test actually executes the model's Python with `python3` against known
inputs. Approximating it would score nothing, and a scorer that silently
measures nothing is worse than no scorer.

It runs serially with a gap, for the same reason the audit does: five tests per
model back to back is what produces throttle noise that reads as a quality
result. See `EVAL.md` for the tests, scoring, and known limitations.

## Files

| File | Role |
|---|---|
| `providers.json` | The allowlist. Hand-edited. |
| `src/index.ts` | Extension entrypoint for Hermes; delegates shared logic |
| `src/providers.mjs` | Shared core: `.env`, catalog, free rules, probe, mapping |
| `config.json` | Hermes-specific policy — hand-edited |
| `scripts/audit-models.mjs` | The audit |
| `scripts/render-opencode.mjs` | Audit results → opencode blocks |
| `audit.json` | Generated audit results — git-ignored |
| `opencode.providers.json` | Generated opencode blocks — paste manually |
| `models.discovered.json` | Generated Hermes catalog — git-ignored |
| `models.json` | Offline Hermes seed — last-resort fallback only |
| `opencode.hermes.json` | Generated by the extension on refresh |
| `scripts/eval-models.mjs` | Model quality smoke-eval — see `EVAL.md` |

`src/providers.mjs` is shared deliberately: the extension and the audit scripts
import the same free-model rules, so they cannot drift apart and disagree about
what is free.

## Adding a provider

Append to the `providers` array in `providers.json`:

```json
{
  "id": "myprovider",
  "label": "My Provider",
  "enabled": true,
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "MYPROVIDER_KEY",
  "freeSource": "pricing",
  "headers": { "X-Client": "my-sdk" }
}
```

| Key | Meaning |
|---|---|
| `freeSource` | `pricing` — zero price on both axes, or `:free` in the id. `clineFreeList` — provider publishes a free list and has no pricing at all. |
| `headers` | Extra headers on every request. Some providers gate models behind SDK identity. |
| `apiKeyEnv` | Env var holding the credential. Omit for providers that need no auth. |
| `freePath` | For `clineFreeList`, the path returning the free list. |

The extension registers it as `free-<id>` on next `/reload`. Note that OMP
requires a non-empty `apiKey` for any provider that defines models, and does not
honour `auth: "none"`.

## Configuration

Hermes-specific policy lives in `config.json`:

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

### What counts as free

Per provider, because the answer differs:

- **Hermes** — zero on both price axes, or `:free` in the id. Both are needed.
  The catalog has 34 asymmetric entries (embeddings, rerankers) priced 0 on
  completion but non-zero on prompt, so an OR over price fields advertises those
  as free. Price alone also drops genuinely free models with no `:free` marker.
- **Cline** — the free list at `/ai/cline/recommended-models`. Cline's own
  `/models` endpoint carries no pricing at all.
- **Kilo** — the live `isFree` flag. Not OMP's cached cost, which marks ~200
  paid models as free.

## Fallback chain (Hermes only)

1. **Proxy** — live fetch; writes the cache on success
2. **Cache** — `models.discovered.json` from the last successful fetch
3. **Seed** — `models.json`

The provider is never registered empty, and every fallback is reported by
`/hermes-status`. Cline and Kilo register nothing if their fetch fails, rather
than serving a stale list that no longer reflects the provider.

## Use

```
/model verified-hermes/stealth/space-bunny-alpha
/model verified-cline/cline-free/deepseek-v4.1-flash
/model verified-kilo/nvidia/nemotron-3-super-120b-a12b:free
/hermes-status
/hermes-refresh
```

`omp models refresh` also refreshes these providers.

## Why `verified-*`

The providers are named for what they guarantee, not for their source. Each
`verified-*` provider contains only models that answered a real tool call in the
audit. OMP's own picker shows everything an upstream advertises, including
models that answer 402, return nothing, or are permanently throttled, so
choosing a provider there means triaging 18 candidates to find the 13 that
work.

Three states are deliberately **excluded**, because a list whose promise is
"everything here works" should not contain them:

| State | Excluded because |
|---|---|
| `partial` | Chat works but no tool call is emitted. Not an agent model. |
| `throttled` | A 429 is a capacity reading, not a verdict. It might work at 3am. |
| `timeout` / `error` | Inconclusive. The model was never actually shown to fail. |

These reappear in the list as soon as an audit clears them. The generated
opencode file records each exclusion with its reason, so an absence is
explained rather than silent.

## opencode

The audit writes `opencode.providers.json`: one provider block per audited
provider, containing only models that answered a real tool call. Models the
audit excluded are listed in a trailing comment with the reason, so an absence is
explained rather than silent.

Copy the block you want into `~/.config/opencode/opencode.jsonc`. The extension
never writes to your opencode config.

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

## Notes

- `omp models --json` prints an identical `thinking` array for every model. That
  column is computed by the OMP binary and ignores `thinkingLevelMap`; the
  interactive `/thinking` picker uses the registered metadata and is correct.
- Reasoning levels are mapped from each model's advertised effort vocabulary. A
  model with mandatory reasoning gets `off: null`, which prevents OMP from
  offering a level the endpoint rejects with HTTP 400.
- OMP's `~/.omp/agent/models.db` cache is stale and should not be trusted as a
  free-model source. It lists models the providers no longer serve, and marks
  paid models as free.

## Troubleshooting

### Models don't update

Run `/hermes-refresh` inside OMP, or `omp models refresh` from the shell.

### A provider did not register

The extension logs to the OMP session. Check the key is in `.env` and run
`node scripts/audit-models.mjs --provider <id>` — it prints the catalog fetch
error directly.

### Check which Hermes source is in use

```
/hermes-status
```

Reports the source (`proxy`, `cache`, or `seed`), catalog size, when the cache
was written, and probe results.

### Proxy auth or port changed

Set `HERMES_PROXY_URL` / `HERMES_PROXY_KEY`, or edit `config.json`.

### Cline models all 403

The `headers` block is missing from the Cline entry in `providers.json`. A key
alone is not sufficient.
