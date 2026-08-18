# OMP Hermes Proxy Extension

Bridge the local Hermes proxy into Oh My Pi (OMP) so free models from StepFun, Poolside, and Tencent are available directly inside `omp`.

## What it does

Hermes proxy exposes free models through an OpenAI-compatible API. This extension registers that proxy as an OMP provider, so you can switch to Hermes-backed models with `/model` without leaving OMP.

## Prerequisite

Start the Hermes proxy first:

```bash
hermes proxy start --provider nous
```

It listens on `http://localhost:8645/v1`. If the proxy is not running, the extension falls back to the local `models.json` config.

## Install

```bash
omp plugin install /home/ubuntu/projects/omp-hermes-proxy-extension
```

This links the extension into `~/.omp/plugins/` and auto-loads it from `~/.omp/agent/extensions/`.

## Configuration

Edit `models.json` next to the extension. Two modes are supported:

```json
{
  "autodiscover": true,
  "models": [...]
}
```

- `autodiscover: true` (default) — queries `http://localhost:8645/v1/models` at startup and registers any model whose id contains `:free`.
- `autodiscover: false` — uses only the models listed in `models.json`.

If the API is unreachable or returns no free models, the extension falls back to `models.json` regardless of the `autodiscover` setting.

## Models

When autodiscovery is enabled, any free model exposed by the proxy is available. The bundled fallback list includes:

- `hermes-proxy/stepfun/step-3.7-flash:free`
- `hermes-proxy/poolside/laguna-s-2.1:free`
- `hermes-proxy/poolside/laguna-xs-2.1:free`
- `hermes-proxy/tencent/hy3:free`

## Use

Start OMP normally:

```bash
omp
```

Switch to a Hermes proxy model inside OMP:

```
/model hermes-proxy/stepfun/step-3.7-flash:free
```

> `--model hermes-proxy/...` is not supported on the CLI; use `/model` in interactive OMP.

## Implementation

- `src/index.ts` — extension entrypoint. Loads `models.json`, tries the proxy `/models` endpoint with a 3s timeout, maps free models into OMP's provider schema, and registers `hermes-proxy` with `openai-completions` API.
- `models.json` — local fallback model definitions used when the proxy is unreachable or `autodiscover` is disabled.
- `dist/` — compiled output. Note: the current build has a TypeScript configuration issue; see troubleshooting.

## Troubleshooting

### Build fails with `Cannot find name 'fs'` / `path` / `process`

`tsconfig.json` uses `"moduleResolution": "Bundler"`, which prevents `@types/node` from being auto-included. Fix by adding `"types": ["node"]` to `compilerOptions`, or changing `moduleResolution` to `"Node"`.

### Models don't update after changing the proxy config

Reinstall the extension after rebuilding:

```bash
omp plugin install /home/ubuntu/projects/omp-hermes-proxy-extension
```

### Proxy auth or port changed

Update `BASE_URL` and `API_KEY` in `src/index.ts`, rebuild, and reinstall.
