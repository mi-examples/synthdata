# Metric Insights custom script — synthdata

This repository is a **Metric Insights custom script** created with `@metricinsights/cs-helper`.

## Commands

- **Install:** `npm install`
- **Build:** `npm run build` (bundles the script for Metric Insights; `dist/` is the output)

## Compatibility (v6 vs v7)

The **`npm run build`** script passes ` --v7` (either nothing or ` --v7` for webpack). That selects how the helper and polyfills are wired.

### Metric Insights v6 (default build, no `--v7`)

- **Runtime:** PhantomJS (legacy headless browser).
- **Language level:** Treat the environment as **old ES5-era** code. The bundle uses Babel with **`targets: "ie 11"`** and webpack **`target: ["web", "es5"]`** so syntax is transpiled down, but **not every modern API** is available or polyfilled.
- **Polyfills from cs-helper (v6 path):** the helper pulls in a small set (e.g. `Object.assign`, `Array.prototype.find`, `Promise`, `String.prototype.includes` via the v6 polyfill entry). **Anything beyond that is not guaranteed**—avoid newer builtins unless you add your own polyfills or verify they compile and run.

### Metric Insights v7 (`--v7` / v7-only build)

- **Runtime:** **Puppeteer** with a current Chromium stack (MI tracks updates).
- **Language level:** Babel **`targets: { chrome: "97" }`** with **`useBuiltIns: "entry"`** and **core-js 3.x**, plus webpack **`target: ["web", "es2023"]`**. You can use modern JavaScript much more freely than on v6; still prefer patterns that match a recent Chromium.

## Logging (important)

**Do not use `console.log`, `console.warn`, `console.error`, or other `console` methods** for output you need to see in Metric Insights. The console may exist, but **you typically cannot inspect that output** in the MI UI or run logs.

Use one of these instead:

1. **`cs.log('message')`** — `cs` is the exported `customScript` object from `@metricinsights/cs-helper` (see the scaffolded entry file).
2. **`customScript.log('message')`** — same global API MI injects at runtime.
3. **Leveled helper:** `import { log, setLogLevel, … } from '@metricinsights/cs-helper/utils'` — the `log` helper forwards to `customScript.log` (with batching and levels); use this when you want log levels and filtering.

For failures, use **`cs.error(...)`** (and **`cs.result(...)`** / **`cs.close()`** as in the template) so behavior and diagnostics stay visible through MI’s channels.

## Backend HTTP requests (`cs.runApiRequest`)

**Use `cs.runApiRequest(url, settings?)` (or `customScript.runApiRequest`) for all Metric Insights backend HTTP calls.** Do not use raw `fetch`, `XMLHttpRequest`, or manual AJAX for normal API access unless you have a rare, documented exception.

### Official MI API docs (partial coverage)

- Primary docs: **https://help.metricinsights.com/m/API_Access**
- Coverage is **not complete**. Some endpoints/fields/edge-case behaviors may be undocumented; confirm with runtime API responses, your MI instance behavior, and release notes/support when needed.

### Authentication

Metric Insights injects API authentication for you. Each request includes an HTTP header:

- **`token`:** the script API token (same value as **`cs.apiToken`**).

Do not set or replace this header yourself for standard backend calls.

### API token lifetime and refresh

The script **`token`** lifetime is **configured on the Metric Insights server** (administration / security policy). There is **no fixed TTL in the client**—always treat expiry as **server-defined**.

In practice, lifetimes are **often at least several minutes** (commonly **not shorter than about 5 minutes**), but **do not rely on a specific number** without confirming your environment.

If the script can **run longer than the token remains valid** (loops, retries, long waits, batch jobs), you should **design explicit token refresh logic**:

1. Call **`GET`** **`/api/get_token`** against the same instance (full URL: **`cs.homeSite`** / **`customScript.homeSite`** + `api/get_token`, with the same URL rules as other backend calls).
2. Parse the JSON body: **`{ token: string; expires: string }`** — use the new **`token`** for subsequent API traffic and use **`expires`** (host-defined format, often a timestamp or ISO string) to decide **when** to refresh before the next call fails with an auth error.

Wire refresh into your **`runApiRequest`** / **`buildRequest`** flow (e.g. refresh before long phases, or on 401 if your host returns it). If you are unsure how the refreshed **`token`** is applied on each request in your MI version, confirm with Metric Insights documentation or support.

### Implementation (jQuery.ajax)

`runApiRequest` is a **wrapper around jQuery.ajax**:

| MI build | Runtime   | jQuery (ajax) |
| -------- | --------- | ------------- |
| v6 (no `--v7` in `npm run build`) | PhantomJS | **1.2.x** |
| v7 (`--v7`) | Puppeteer / Chromium | **3.x** |

The optional **`settings`** argument uses the same shape as **jQuery ajax** options: `success`, `error`, `type`, `data`, `contentType`, etc., depending on what the MI host merges in.

### URLs

Backend URLs must target the Metric Insights instance. Build the request URL from **`cs.homeSite`** or **`customScript.homeSite`** (MI base URL, e.g. `https://web:<port>/`) plus the API path—do not rely on a bare relative path unless you know the host resolves it correctly.

Example:

```javascript
const url = cs.homeSite.replace(/\/?$/, '/') + 'api/dataset_data?dataset=1';

cs.runApiRequest(url, {
  success: function (data) {
    cs.log(JSON.stringify(data));
  },
  error: function (xhr, status, err) {
    cs.error(String(err || status));
  },
});
```

### Promise wrapper (optional pattern)

You can wrap **`runApiRequest`** in a **`Promise`** and pass **paths relative to `homeSite`** (same rules as above: always resolve the MI base URL correctly).

- Prefer a small **`joinHomeAndPath`** (or equivalent) so **`cs.homeSite`** with or without a trailing slash does not get concatenated wrongly with **`path`**.
- **`RequestParams`** mirrors jQuery ajax fields you use (`type`, `headers`, `data`, …). Spread **`params`** into the second argument, then attach **`success`** / **`error`** so the Promise **resolves** / **rejects** — otherwise the request never completes the Promise.

```typescript
import { cs } from '@metricinsights/cs-helper';

export type RequestParams = {
  type?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  data?: string;
  [p: string]: any;
};

function joinHomeAndPath(path: string): string {
  const base = cs.homeSite.replace(/\/?$/, '/');
  return base + path.replace(/^\//, '');
}

function buildRequest<T extends {} = any>(
  path: string,
  params: RequestParams = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    cs.runApiRequest(joinHomeAndPath(path), {
      ...params,
      success: (data) => resolve(data as T),
      error: (_xhr, _status, err) => {
        reject(err != null ? err : new Error(String(_status)));
      },
    });
  });
}
```

## Finishing the script (`cs.close`)

- The script must end by calling **`cs.close()`** when work is done (success or controlled failure).
- **Best practice:** schedule **`cs.close()` inside `setTimeout(..., 500)`** (e.g. a small `scheduleClose()` helper) so Metric Insights can flush **`cs.result`** / logs before teardown.
- **Safety timeout:** keep a **maximum execution window** by passing **`scriptTimeout`** in **milliseconds** (ms) from script parameters and using e.g. `setTimeout(..., scriptTimeout)` so that if the script never finishes normally, you **`cs.log`** and then call **`cs.close()`** (again after the usual short delay), avoiding stuck runs.

## Project metadata

- Package version: **1.0.0** — description: **Generate synthetic data**.
- cs-helper version at scaffold time: **0.7.1**.
- v7-only build when the project was created with **`--v7`** (see `package.json` **`build`** script: ` --v7`).

Refer to **`README.md`** and **`src/`** for API surface; **backend HTTP details** for assistants live in this file and **`.cursor/rules/`**.
