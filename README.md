# synthdata

Generate synthetic tabular data for Metric Insights datasets. Ask an LLM to design a schema for the industry/measure you describe, then generate rows locally and PUT them to a manual dataset via `/api/dataset_data`.

## Params

Only `datasetId` and `llmApiKey` are required. Everything else has a default.

| Name | Type | Required | Default |
|:--|:--:|:--:|:--:|
| `datasetId` | Number | x | |
| `llmApiKey` | String | x | |
| `prompt` | String | | `""` |
| `industry` | String | | `"retail"` |
| `measure` | String | | `""` |
| `dimensions` | String | | `""` |
| `rows` | Number | | `5000` |
| `mode` | String | | `"replace"` |
| `measurementTime` | String | | `""` |
| `llmProvider` | String | | `"anthropic"` |
| `llmModel` | String | | `""` (provider default) |
| `seed` | Number | | `0` |
| `chunkSize` | Number | | `2000` |
| `scriptTimeoutMs` | Number | | `600000` |

### Params description

- **prompt**: Free-form natural-language description of the dataset. When non-empty, overrides `industry` / `measure` / `dimensions`. Example: `"Global retail sales for a clothing company, dimensioned by region, brand, product category, and product sub-category."`
- **industry**: Industry label the LLM uses to pick realistic dimension values. Example: `retail`, `energy`, `financial_services`.
- **measure**: The measure you want. Example: `sales_usd`, `units_sold`, `leads`.
- **dimensions**: Either a comma-separated list of dimension names (`region,brand,product_category`) or a single integer (`4`) letting the LLM pick that many dimensions for the industry.
- **rows**: Approximate target row count. Capped at 500,000.
- **mode**: `replace` overwrites the target dataset's data; `append` adds rows. (`new` — creating a dataset from scratch — is Phase 2.)
- **datasetId**: ID of the target MI dataset. Must be a manual dataset (`data_fetch_method = manual`).
- **measurementTime**: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`. Required when the target is a snapshot dataset (`save_historical_instances_ind = Y`). Ignored otherwise.
- **llmProvider**: `anthropic` or `openai`.
- **llmApiKey**: Your own API key for the chosen provider. The script POSTs directly to `api.anthropic.com` / `api.openai.com` from the MI script sandbox.
- **llmModel**: Optional model override. Defaults: `claude-sonnet-4-6` (anthropic), `gpt-4o` (openai).
- **seed**: RNG seed for reproducible rows. `0` uses the current time.
- **chunkSize**: Rows per PUT request. The first chunk honors `mode`; subsequent chunks always append. PUTs are sequential (MI serializes dataset writes).
- **scriptTimeoutMs**: Outer safety timeout. Script logs and closes if it exceeds this. Bump for very large runs (e.g., `1800000` for 30 min when writing 500k+ rows).

## Build

```sh
npm install
npm run build   # → dist/synthdata.js
```

## Pipeline

```
params → LLM (schema + dimension values + measure profile)
       → local row generator (seedable PRNG, date walker, dim sampler, measure = base × trend × seasonality × noise)
       → PUT /api/dataset_data in chunks
       → cs.result summary → cs.close
```

LLM calls have a 60s per-request timeout and retry once on `429` / `5xx`. Schema responses that fail validation trigger a second LLM call with the error echoed back, so malformed JSON from the model usually self-corrects.

The MI script token is refreshed proactively every ~3 minutes and on any `401`, using `GET /api/get_token`. A mutex coalesces concurrent refresh attempts during parallel PUT phases.

## Scaling to large datasets

MI serializes dataset writes — concurrent PUTs to the same dataset are rejected with a "Task is conflicting" error — so the script always writes chunks sequentially. The levers you have:

- **`chunkSize`.** Larger chunks = fewer PUTs = less overhead. Default is `2000`. `5000`-`10000` is usually safe; MI's request body limit sets the ceiling.
- **`scriptTimeoutMs`.** Bump to 30 min (`1800000`) for 500k+ runs so the outer safety timer doesn't kill you mid-write.
- **Conflict retry is built in.** If a PUT hits "Task is conflicting" (e.g., a previous dataset task hasn't released), the script backs off and retries up to 3 times per chunk before failing.
- **Token refresh is built in.** `cs.apiToken` is refreshed every ~3 minutes and on any `401`, so long-running jobs don't die on expiry.

Rough expectation for 500k rows at `chunkSize=5000`: 100 sequential PUTs × ~1-2s each = 2-4 minutes wall clock, plus the token refresh every 3 min in the background.

## Known limits

- **`append` + schema mismatch.** `replace` redefines the dataset's columns every run (nice). `append` against a dataset whose existing columns don't match the LLM's output may fail or silently drop columns — the LLM has no visibility into the current schema. Phase 2 will fix this by feeding the target schema into the prompt.
- **Mid-run PUT failure = partial state.** There's no transaction. If a chunk fails after the conflict-retry budget is exhausted, everything before it is already applied; everything after is not. Re-running with `mode=replace` is the recovery path.
- **Per-chunk retry covers 401 and task-conflict.** Other transient HTTP errors (network hiccup, `5xx`) currently hard-fail the PUT. If this bites, we'd generalize the retry.
- **API key visibility.** `llmApiKey` is stored as a script parameter — visible to MI admins who can view the script. Fine for dev/demo, not a fit for production where keys need vault handling.
- **Provider coverage.** Anthropic and OpenAI only. Google / Azure are easy additions when needed.
- **Preview ordering.** Rows are written date-major, so the first page of the default dataset preview will all show the earliest date. Data is correct; sort by a measure or chart a time series to see the full range.
