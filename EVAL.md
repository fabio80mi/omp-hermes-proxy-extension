# Model smoke-eval

A small, fast, reproducible way to compare models served by the local Hermes
proxy. Built after hand-testing the eight free models in September 2026.

It is **not** a benchmark suite. It is a regression gate that catches the two
failure modes that actually showed up in practice:

1. A model that is advertised in the catalog with zero pricing but is dead or
   rate limited.
2. A model that returns nothing when asked to think, after spending its whole
   token budget.

## Running it

```bash
node scripts/eval-models.mjs                          # every free model
node scripts/eval-models.mjs --model <id> --model <id>  # specific models
node scripts/eval-models.mjs --all                    # entire catalog, paid included
node scripts/eval-models.mjs --json results.json      # machine-readable output
```

The proxy must be running first:

```bash
hermes proxy start --provider nous
```

Requires `node` 18+ (uses global `fetch`) and `python3` on `PATH` for the code
test.

| Variable | Default | Purpose |
|---|---|---|
| `HERMES_PROXY_URL` | `http://localhost:8645/v1` | Endpoint to test against |
| `HERMES_PROXY_KEY` | `HermesProxyLocal` | Bearer token |
| `EVAL_MAX_TOKENS` | `4000` | Default output budget per call |
| `EVAL_TIMEOUT_MS` | `280000` | Per-request timeout |
| `EVAL_PYTHON` | `python3` | Interpreter for the code test |

## Output

```
model                                       code  reason  IF  tool  triv   score
---------------------------------------------------------------------------------
stealth/space-bunny-alpha                     25       0   15    20    15       75
upstage/solar-pro4:free                       -       -    -     -     -      429

returned empty content after using their token budget:
  stealth/space-bunny-alpha                  reasoning

rate limited (429, capacity, not a quality signal):
  upstage/solar-pro4:free                    The requested model is temporarily at capacity
```

Three signals are reported separately and deliberately not folded into the score:

- **DEAD** — HTTP 404. Advertised but not served. Nothing to fix locally.
- **429** — capacity. Not a quality signal. Re-run later before judging.
- **empty content** — returned a completion but with no text in it. This is the
  interesting one; it usually means the model burned its budget thinking.

## The five tests

| Test | Weight | What it asks | How it is scored |
|---|---|---|---|
| `code` | 25 | Write `parse_duration(s)` handling `1h30m`, `45s`, `2d`, `1w` | Code is **executed by python3** and called with five inputs. All five must be right. |
| `reasoning` | 25 | Autoscaling scenario where the honest answer is "impossible" | Passes if the response flags the gap rather than just doing arithmetic. |
| `instruction` | 15 | Output exactly 3 lines, no extras | Passes only on exactly the right 3 lines. |
| `tools` | 20 | "What is the weather in Oslo? Use the tool." | Passes on a real `get_weather` call with `city: Oslo`. |
| `trivial` | 15 | 70.2 vs 59.5, which is higher and by how much | Passes on `10.7`. |

Weights total 100. They are opinionated, not scientific: the code test carries
the most because executed correctness is the hardest signal to fake.

The reasoning test is a deliberate trap. The arithmetic answer is "1 event" —
3 replicas at 100 rps is 300 rps, so one more reaches 400. But that replica
needs 45s to be added plus 20s to become healthy, which cannot happen inside a
200ms p99 budget. Models that answer "1" without noticing the timing are
scored as failing.

## Using it on other models

The script takes any model id, so evaluating a newly discovered model needs no
code changes:

```bash
# something the catalog just started advertising
node scripts/eval-models.mjs --model some-vendor/some-model

# a model you are about to pay for, alongside the free ones
node scripts/eval-models.mjs --all --json compare.json

# a model that is not on the proxy at all, via any OpenAI-compatible endpoint
HERMES_PROXY_URL=https://api.example.com/v1 \
HERMES_PROXY_KEY=sk-... \
  node scripts/eval-models.mjs --model some/model
```

To add a model permanently, refresh the extension first so the model exists in
the catalog, then re-run without `--model` to include it.

To change what is measured, edit the constants near the top of the script:
`T_CODE`, `T_REASON`, `T_IF`, `T_TOOL`, `T_TRIV`, and `DURATION_CASES`. Keep the
tests cheap and mechanical. A test that needs a human to judge does not belong
in an automated gate — that is a different tool.

## Interpreting results honestly

- **Non-determinism is real.** The same model can pass `reasoning` on one run
  and return empty on the next, because thinking length varies with load and
  demand. A single run is not a verdict. Re-run before concluding.
- **429 is not a failure.** It means try later. Scoring it as zero would rank
  capacity as capability.
- **Small n.** Five tests, one sample each. A 25-point swing is one test. Treat
  the total as a coarse filter, not a ranking.
- **These are not frontier benchmarks.** Nothing here substitutes for
  Terminal-Bench or SWE-bench. Cross-check any decision against vendor numbers,
  and read those critically too — most are self-reported.

## Result from September 2026

Run against the eight free models at the time, to show what this looks like in
practice. Several findings were strong enough to act on:

- `meituan/longcat-2.0:free` returned **404** on every request — "this model is
  no longer free" — while the catalog still listed it at zero price. Its vendor
  scores were among the best in the set (59.5 SWE-bench Pro, 70.8
  Terminal-Bench 2.1) and it was completely unusable. Only a live probe finds
  this.
- `stepfun/step-3.7-flash:free` was **429** for the whole session.
- `poolside/laguna-xs-2.1:free` and `inclusionai/ling-3.0-flash-fin:free`
  returned **empty content** on most prompts, in some cases spending 4000
  tokens producing nothing. Both answer short prompts correctly and quickly, so
  a casual test would have passed them.
- The `empty` flag is the single most useful output here. It surfaced a failure
  mode that reading vendor leaderboards cannot.

The extension's own startup probe covers the cheap liveness half of this (404
and 429 detection at registration). This script covers the behaviour half.

## Related

- `README.md` — extension install, config, and troubleshooting
- `config.json` — policy: `freeOnly`, probe settings, timeouts
