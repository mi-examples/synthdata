import { cs, parseParams } from '@metricinsights/cs-helper';
import { generateSchema, LlmOptions, LlmProvider } from './llm';
import { generateRows } from './generate';
import { putDatasetDataChunked } from './api';

type Params = {
  // Dataset description (prompt takes priority if non-empty)
  prompt?: string;
  industry?: string;
  measure?: string;
  dimensions?: string;

  // Volume
  rows?: number;

  // Target dataset
  mode?: string; // 'replace' | 'append'
  datasetId: number;
  measurementTime?: string; // required for snapshot datasets

  // LLM
  llmProvider?: string; // 'anthropic' | 'openai'
  llmApiKey: string;
  llmModel?: string;

  // Reproducibility + safety
  seed?: number;
  chunkSize?: number;
  scriptTimeoutMs?: number;
};

const rawParams = parseParams<Params>({
  prompt: '',
  industry: 'retail',
  measure: '',
  dimensions: '',
  rows: 5000,
  mode: 'replace',
  datasetId: 0,
  measurementTime: '',
  llmProvider: 'anthropic',
  llmApiKey: '',
  llmModel: '',
  seed: 0,
  chunkSize: 2000,
  scriptTimeoutMs: 10 * 60 * 1000,
});

// MI passes numeric params as strings depending on the UI; coerce once so
// everything downstream gets real numbers.
type ResolvedParams = {
  prompt: string;
  industry: string;
  measure: string;
  dimensions: string;
  rows: number;
  mode: string;
  datasetId: number;
  measurementTime: string;
  llmProvider: string;
  llmApiKey: string;
  llmModel: string;
  seed: number;
  chunkSize: number;
  scriptTimeoutMs: number;
};

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function resolveParams(p: Params): ResolvedParams {
  return {
    prompt: String(p.prompt || ''),
    industry: String(p.industry || 'retail'),
    measure: String(p.measure || ''),
    dimensions: String(p.dimensions || ''),
    rows: num(p.rows, 5000),
    mode: String(p.mode || 'replace'),
    datasetId: num(p.datasetId, 0),
    measurementTime: String(p.measurementTime || ''),
    llmProvider: String(p.llmProvider || 'anthropic'),
    llmApiKey: String(p.llmApiKey || ''),
    llmModel: String(p.llmModel || ''),
    seed: num(p.seed, 0),
    chunkSize: num(p.chunkSize, 2000),
    scriptTimeoutMs: num(p.scriptTimeoutMs, 10 * 60 * 1000),
  };
}

const params = resolveParams(rawParams);

function scheduleClose(): void {
  setTimeout(() => cs.close(), 500);
}

function validateParams(p: ResolvedParams): void {
  if (p.datasetId <= 0) {
    throw new Error('datasetId is required (target dataset for PUT)');
  }
  if (p.mode !== 'replace' && p.mode !== 'append') {
    throw new Error('mode must be "replace" or "append" (mode "new" is not supported in Phase 1)');
  }
  if (!p.llmApiKey) {
    throw new Error('llmApiKey is required');
  }
  if (p.llmProvider !== 'anthropic' && p.llmProvider !== 'openai') {
    throw new Error('llmProvider must be "anthropic" or "openai"');
  }
  if (p.rows <= 0 || p.rows > 500000) {
    throw new Error('rows must be between 1 and 500000');
  }
  if (p.chunkSize <= 0) {
    throw new Error('chunkSize must be positive');
  }
}

async function main(): Promise<void> {
  validateParams(params);

  cs.log('synthdata: starting');
  cs.log(
    'params: mode=' +
      params.mode +
      ' datasetId=' +
      String(params.datasetId) +
      ' rows=' +
      String(params.rows) +
      ' provider=' +
      params.llmProvider,
  );

  const llmOpts: LlmOptions = {
    provider: params.llmProvider as LlmProvider,
    apiKey: params.llmApiKey,
    model: params.llmModel || undefined,
  };

  cs.log('synthdata: requesting schema from ' + params.llmProvider);
  const schema = await generateSchema(llmOpts, {
    prompt: params.prompt,
    industry: params.industry,
    measure: params.measure,
    dimensions: params.dimensions,
    rows: params.rows,
  });

  cs.log(
    'synthdata: schema received — columns=' +
      Object.keys(schema.schema).join(',') +
      ' measure=' +
      schema.measure.name +
      ' date_range=' +
      schema.date_range.start +
      '..' +
      schema.date_range.end +
      '/' +
      schema.date_range.grain,
  );

  const rows = generateRows(schema, params.rows, params.seed);
  cs.log('synthdata: generated ' + String(rows.length) + ' rows');

  cs.log(
    'synthdata: PUT /api/dataset_data dataset=' +
      String(params.datasetId) +
      ' mode=' +
      params.mode +
      (params.measurementTime ? ' measurement_time=' + params.measurementTime : ''),
  );

  const result = await putDatasetDataChunked(params.datasetId, rows, {
    append: params.mode === 'append',
    measurementTime: params.measurementTime || undefined,
    chunkSize: params.chunkSize,
    onChunk: (index: number, total: number, size: number) => {
      cs.log('synthdata: chunk ' + String(index) + '/' + String(total) + ' (' + String(size) + ' rows)');
    },
  });

  cs.result(
    JSON.stringify(
      {
        ok: true,
        dataset_id: params.datasetId,
        mode: params.mode,
        rows_written: result.rows,
        chunks: result.chunks,
        schema: schema.schema,
        measure: schema.measure,
        date_range: schema.date_range,
      },
      null,
      2,
    ),
  );
  cs.log('synthdata: done');
}

main()
  .then(() => scheduleClose())
  .catch(function (e: any) {
    cs.error(
      (e && e.responseText) ||
        (e && e.message) ||
        (String(e) === '[object Object]' ? JSON.stringify(e) : String(e)),
    );
    if (e && e.body) cs.error('body: ' + String(e.body).slice(0, 1000));
    cs.error((e && e.stack) || 'No stack trace');
    scheduleClose();
  });

setTimeout(
  () => {
    cs.log('synthdata: safety timeout reached, closing');
    cs.close();
  },
  params.scriptTimeoutMs,
);
