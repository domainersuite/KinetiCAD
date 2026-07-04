# Local development

The repository is a pnpm monorepo tuned for Replit (Linux x64). This note covers
running it on a local machine, including Windows.

## Prerequisites

- Node.js 24+
- pnpm 11+

## Install

```sh
pnpm install
```

On a non-Linux machine the committed lockfile may need a refresh to pick up your
platform's native binaries (esbuild, rollup, Tailwind oxide, lightningcss):

```sh
pnpm install --no-frozen-lockfile
```

Note: the workspace `overrides` in `pnpm-workspace.yaml` deliberately exclude
native binaries for platforms Replit doesn't use. The `win32-x64` exclusions have
been lifted so Windows development works; if you develop on macOS, remove the
corresponding `darwin-arm64` / `darwin-x64` exclusion lines for the four packages
above and re-run `pnpm install --no-frozen-lockfile`.

## Run the CAD app

The Vite config requires two environment variables:

- `PORT` — dev-server port (Replit convention), e.g. `8080`
- `BASE_PATH` — public base path; `/` for local dev (production serves the app at `/app/`)

```sh
cd artifacts/kineticad
PORT=8080 BASE_PATH=/ pnpm run dev
```

Windows notes:

- In **Git Bash / MSYS**, a bare `/` gets rewritten to the Git install path.
  Prefix the command with `MSYS_NO_PATHCONV=1`, or use PowerShell:
  `$env:PORT="8080"; $env:BASE_PATH="/"; pnpm run dev`
- If `pnpm run dev` fails in the root preinstall guard ("Use pnpm instead"),
  make sure `.npmrc` contains `verify-deps-before-run=false` (see comment there).

Then open http://localhost:8080/ in a WebGPU-capable browser (Chrome/Edge).
The OpenCascade WASM kernel (~40 MB) is fetched from jsDelivr at runtime, so an
internet connection is needed on first load.

Demo assemblies, from the browser console:

```js
window.loadSeed('windmill')  // physics regression canary, 30 RPM motor
window.loadSeed('orrery')    // 13 bodies, 12 motorised revolute joints
```

## Production build

```sh
cd artifacts/kineticad
PORT=8080 BASE_PATH=/ NODE_ENV=production pnpm run build
```

Output lands in `artifacts/kineticad/dist/public` — a fully static bundle
(~3.7 MB). It can be served from any static host; the only runtime dependencies
are the jsDelivr-hosted OCCT WASM and a WebGPU browser. Deep links (e.g.
`/simulator`) need an SPA rewrite to `index.html` on hosts that support it;
without one, enter through `/index.html` and navigate in-app.
