# Model evaluation

Quality evaluation of free models. This is separate from the capability audit.

The audit (`scripts/audit-models.mjs`) answers "does this model work" — can it
answer a chat request and emit a tool call. This script answers "is this model
any good" — can it write correct code, find a bug, chain tools, hold many
constraints in its head, and judge an operational situation.

A model must pass the audit before it is registered as `verified-*` in OMP. This
evaluation is not part of registration; it ranks models that already pass.

Replaces the earlier five-test smoke eval, which every competent model scored
100/100 and which therefore measured nothing.

## Running it

Always pass a provider. One model costs 15 calls (three per category), so budget
roughly 2-3 minutes per model.

```bash
# one model
node scripts/eval-models.mjs --provider hermes --model upstage/solar-pro4:free

# every model the audit cleared for one provider
node scripts/eval-models.mjs --provider hermes

# slower pacing
node scripts/eval-models.mjs --provider kilo --delay 4000

# machine-readable
node scripts/eval-models.mjs --provider cline --json
```

Providers are `hermes`, `cline`, `kilo`. Credentials come from `.env` in the
project root (mode 600, git-ignored) or from the process environment.

`--self-test` runs offline, with no network and no model calls. Run it after
touching any scorer:

```bash
node scripts/eval-models.mjs --self-test
```

A full pass over all 24 audited models takes over an hour. That is the one case
where background execution is reasonable — ask first, and record the PID.

## History: the audit and the eval are different things

They answer different questions and are stored separately. Conflating them is
how a fast, cheap check ends up being treated as a quality judgement.

| | audit | eval |
|---|---|---|
| question | does the model work? | is the model good? |
| measures | chat, tool calls, repeatability | code/debug/tools/spec/ops, 3 complexities each |
| verdict | `stable` after 2 of 3 runs | median over the last 3 runs, plus spread |
| stored in | `audit-history/`, `audit-stable.json` | `eval-history/`, `eval-summary.json` |
| gates registration | **yes** — this is what earns a `verified-` provider | **no** — it only ranks |

Every eval run is appended to `eval-history/<provider>/` automatically. `--json`
is an ad-hoc export, not the record.

**The headline number is the mean of the last 3 runs**, or the single run if
there is only one. Mean rather than median because with three samples the median
is just the middle value and discards the other two observations entirely.

The mean's weakness — one outlier pulls it — is handled by reporting the spread
(next to it) rather than by hiding it. The two answer different questions: the
mean says what the model typically scores, the spread says whether that number
is worth acting on. The same model scored 64, 83 and 60 across three identical
runs: mean 69, spread 23, flagged `noisy — ranking unreliable`.

```
model                          mean  med  low   hi  spread  confidence
upstage/solar-pro4:free          69   64   60   83      23  noisy — ranking unreliable
```

With a single run the summary says `single run — not yet measured` rather than
presenting it with the same confidence as three agreeing runs. Ranking sorts by
mean, then by spread, so among equal scorers the consistent one wins.

**History is bounded at 10 runs per provider.** Older runs are pruned after each
run, and the pruning is printed. The limit is asserted to exceed the 3-run
window, so pruning can never delete a run the current verdict depends on.
Back up `eval-history/`: losing it returns every model to "no data".

## Design: three complexities per category

Each category asks three questions of increasing difficulty. Each is a
**separate model call**, and the report prints a column per complexity.

| category | A (easy) | B (medium) | C (complex) |
| --- | --- | --- | --- |
| `code`   | `best_a(jobs)` — k=1 weighted interval scheduling | `best_b(jobs, k)` — value across k machines | `best_c(jobs, k)` — value **and** a valid machine assignment |
| `debug`  | off-by-one that drops the last element on odd input | loop starts at index 1, so a duplicate at 0 is missed | unbounded read-through cache, correct-looking, slower than no cache |
| `tools`  | one tool call | two chained calls, correct ordering | three chained calls, must conclude the order cannot be fulfilled |
| `spec`   | 3 simultaneous constraints | 6 constraints | 9 conflicting constraints |
| `ops`    | obvious blocker | unknown data-migration state | no prod access, service will OOM |

Weights: `code` 30, `debug` 20, `tools` 20, `spec` 15, `ops` 15.

### Why separate calls rather than three questions in one call

Both were tried. Three questions in one call cost a single round trip but made
one bad generation take all three down together — the same model scored `code`
100, 33 and 0 on three consecutive runs. A zero then meant two different things:
"cannot do this" and "unlucky sample". Separate calls cost 3× the round trips
and every score belongs to exactly one complexity, so a zero is just a zero.

### Why three complexities

With one difficulty per category a model can only score 0 or full marks. Solar
Pro 4 solved the easy scheduling case perfectly and the k-machine case not at
all; under a single hard prompt that reads as "cannot code" when it means "can
code, but not this". The ladder separates those cases.

## How scoring works

No second model judges the output, and nothing is graded on the whole answer
alone.

- **code** — the returned Python is executed against fixtures whose expected
  values were computed by brute force. Every fixture is chosen so the optimum
  differs from three plausible wrong strategies: top-k by value, sum everything,
  and greedy in start order. A fixture where those coincide measures nothing.
  Tier A is called as `best_a(jobs)` and B/C as `f(jobs, k)`, because the
  prompt specifies those signatures.
- **debug** — a three-level rubric per snippet: named the cause (partial), named
  it and its impact (higher), and for the cache bug, proposed a bound. The fix
  is looked for in the closing sentence only, because scanning the whole answer
  matched "never evicts" in the problem statement.
- **tools** — a real agent loop, not one request: the tool result is fed back and
  the model continues. Each tier is offered only the tools it needs, so "never
  called `get_inventory`" measures chaining, not a withheld tool.
- **spec** — each constraint is a predicate, so a model satisfying 5 of 9 scores
  0.56 and the report names the constraints it missed.
- **ops** — required facts are regexes. A confident but unexecutable plan scores
  low; recognising the authority gap scores high.

## Reading the output

```
model                     code A  code B  code C debug A ...
  A = easy   B = medium   C = complex
```

then the per-tier breakdown, which is the actual finding:

```
  upstage/solar-pro4:free  —  67/100
    code   easy    100%  2/2
    code   medium   0%   0/2
    code   complex  0%   0/4
    spec   complex  78%  missed exactly 11 words, has 7
```

"missed exactly 11 words, has 7" is the useful output. A bare 78 is not.

## Fixtures

`SCHED_CASES` is a flat list of `[jobs, k, expected]` triples; `TIER_OF` assigns
each to a tier. Both are validated at load, because a length mismatch there
silently scores a correct solution as zero.

Never hand-compute an expected value. Brute-force it and paste the result. A
hand-computed 150 survived long enough to mark a correct answer wrong when the
true optimum was 200.

## Honest limits

- **Non-determinism is real.** Thinking length varies with load. A single run
  is not a verdict on a borderline model.
- **429 is not a failure.** It means try later; scoring it as zero would rank
  capacity as capability.
- **Small n.** One sample per (category, complexity). A 10-point swing in one
  category is one question. Treat the total as a coarse filter, not a ranking.
- **These are not frontier benchmarks.** Nothing here substitutes for
  Terminal-Bench or SWE-bench, and most vendor numbers are self-reported.

## Related

- `scripts/audit-models.mjs` — capability audit that gates registration
- `scripts/render-opencode.mjs` — generates the OpenCode provider block
- `README.md` — plugin install, configuration, troubleshooting
