// LLM client. Calls Anthropic or OpenAI directly (user supplies the key) and
// returns a validated schema object. Handles transport retry (timeout, 429/5xx)
// and content retry (one pass with error feedback if the response doesn't parse).

import { cs } from '@metricinsights/cs-helper';

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: any;
};
type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
};
declare const fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>;
declare const AbortController: new () => { signal: any; abort(): void };

const REQUEST_TIMEOUT_MS = 60 * 1000;
const RETRY_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: FetchInit): Promise<FetchResponse> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      const transient = resp.status === 429 || resp.status >= 500;
      if (transient && attempt === 0) {
        lastError = new Error('transient HTTP ' + resp.status);
        cs.log('llm: transient ' + resp.status + ', retrying in ' + String(RETRY_BACKOFF_MS) + 'ms');
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return resp;
    } catch (e: any) {
      clearTimeout(timer);
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt === 0) {
        cs.log('llm: network error (' + lastError.message + '), retrying in ' + String(RETRY_BACKOFF_MS) + 'ms');
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error('fetchWithRetry exhausted retries');
}

export type ColumnType = 'date' | 'string' | 'integer' | 'float';
export type Seasonality = 'retail_q4_peak' | 'summer_peak' | 'none';
export type Grain = 'day' | 'week' | 'month';

export type GeneratedSchema = {
  schema: Record<string, { type: ColumnType }>;
  dimension_values: Record<string, string[]>;
  measure: {
    name: string;
    unit: string;
    base: number;
    trend_pct_per_year: number;
    seasonality: Seasonality;
    noise_pct: number;
  };
  date_range: {
    start: string; // YYYY-MM-DD
    end: string; // YYYY-MM-DD
    grain: Grain;
  };
};

export type LlmProvider = 'anthropic' | 'openai';

export type LlmOptions = {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
};

export type SchemaInput = {
  prompt?: string;
  industry?: string;
  measure?: string;
  dimensions?: string;
  rows: number;
};

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
};

const SYSTEM_PROMPT = [
  'You are a data architect that designs synthetic dataset schemas for business intelligence demos.',
  '',
  'Reply with a single JSON object matching EXACTLY this shape:',
  '{',
  '  "schema": object mapping column name to {"type": "date" | "string" | "integer" | "float"},',
  '  "dimension_values": object mapping each string-typed column to an array of 5-30 realistic values,',
  '  "measure": {',
  '    "name": string (must match the numeric measure column in schema),',
  '    "unit": string (e.g., "USD", "units", "count"),',
  '    "base": number (typical magnitude per row),',
  '    "trend_pct_per_year": number (e.g., 5 for 5% YoY growth; negative for decline),',
  '    "seasonality": "retail_q4_peak" | "summer_peak" | "none",',
  '    "noise_pct": number between 0 and 50',
  '  },',
  '  "date_range": {',
  '    "start": "YYYY-MM-DD",',
  '    "end": "YYYY-MM-DD",',
  '    "grain": "day" | "week" | "month"',
  '  }',
  '}',
  '',
  'Rules:',
  '- Exactly one column with type "date". Exactly one numeric measure column (integer or float).',
  '- All other columns must be "string" and have entries in dimension_values.',
  '- Values must be realistic for the described industry.',
  '- Reply with ONLY the JSON object. No markdown fences, no commentary.',
].join('\n');

function buildUserPrompt(input: SchemaInput): string {
  if (input.prompt && input.prompt.trim()) {
    return (
      input.prompt.trim() +
      '\n\nApproximate row count: ' +
      String(input.rows) +
      '.'
    );
  }
  const lines: string[] = [];
  lines.push('Industry: ' + (input.industry || 'retail'));
  if (input.measure) lines.push('Measure: ' + input.measure);
  if (input.dimensions) {
    const n = Number(input.dimensions);
    if (!isNaN(n) && Math.floor(n) === n && n > 0) {
      lines.push(
        'Dimensions: pick ' + String(n) + ' realistic dimension columns for this industry.',
      );
    } else {
      const names = input.dimensions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ');
      lines.push('Dimensions: ' + names);
    }
  } else {
    lines.push(
      'Dimensions: pick 3-5 realistic dimension columns for this industry.',
    );
  }
  lines.push('Approximate row count: ' + String(input.rows));
  lines.push(
    'Time series: pick a sensible date range (e.g., last 2-3 years) at a day/week/month grain appropriate to the measure.',
  );
  return 'Design a synthetic dataset with:\n- ' + lines.join('\n- ');
}

async function callAnthropic(opts: LlmOptions, system: string, user: string): Promise<string> {
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODELS.anthropic,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error('Anthropic ' + response.status + ': ' + body.slice(0, 500));
  }
  const data = await response.json();
  return (data && data.content && data.content[0] && data.content[0].text) || '';
}

async function callOpenAI(opts: LlmOptions, system: string, user: string): Promise<string> {
  const response = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + opts.apiKey,
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODELS.openai,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error('OpenAI ' + response.status + ': ' + body.slice(0, 500));
  }
  const data = await response.json();
  return (
    (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
  );
}

function extractJson(text: string): any {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('No JSON object found in LLM output');
  }
  return JSON.parse(t.slice(start, end + 1));
}

function validateSchema(obj: any): GeneratedSchema {
  if (!obj || typeof obj !== 'object') throw new Error('Response is not a JSON object');
  if (!obj.schema || typeof obj.schema !== 'object') throw new Error('Missing "schema"');
  if (!obj.measure || typeof obj.measure !== 'object') throw new Error('Missing "measure"');
  if (!obj.date_range || typeof obj.date_range !== 'object') throw new Error('Missing "date_range"');

  const columns = Object.keys(obj.schema);
  if (columns.length < 2) throw new Error('schema needs at least 2 columns');

  const typeOf = (c: string): string => obj.schema[c] && obj.schema[c].type;
  const dateCols = columns.filter((c) => typeOf(c) === 'date');
  if (dateCols.length !== 1) {
    throw new Error('schema must have exactly 1 date column, got ' + String(dateCols.length));
  }
  const numericCols = columns.filter((c) => typeOf(c) === 'integer' || typeOf(c) === 'float');
  if (numericCols.length < 1) throw new Error('schema must have at least one numeric column');

  const measureName = obj.measure.name;
  if (columns.indexOf(measureName) < 0) {
    throw new Error('measure.name "' + String(measureName) + '" is not a column in schema');
  }
  if (['integer', 'float'].indexOf(typeOf(measureName)) < 0) {
    throw new Error('measure column must be integer or float');
  }

  const stringCols = columns.filter((c) => typeOf(c) === 'string');
  if (!obj.dimension_values || typeof obj.dimension_values !== 'object') {
    obj.dimension_values = {};
  }
  for (const c of stringCols) {
    const v = obj.dimension_values[c];
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error('dimension_values for "' + c + '" is missing or empty');
    }
  }

  const dr = obj.date_range;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dr.start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dr.end))) {
    throw new Error('date_range.start/end must be YYYY-MM-DD');
  }
  if (['day', 'week', 'month'].indexOf(dr.grain) < 0) {
    throw new Error('date_range.grain must be day|week|month');
  }

  if (['retail_q4_peak', 'summer_peak', 'none'].indexOf(obj.measure.seasonality) < 0) {
    obj.measure.seasonality = 'none';
  }
  if (typeof obj.measure.base !== 'number') obj.measure.base = 100;
  if (typeof obj.measure.trend_pct_per_year !== 'number') obj.measure.trend_pct_per_year = 0;
  if (typeof obj.measure.noise_pct !== 'number') obj.measure.noise_pct = 10;

  return obj as GeneratedSchema;
}

export async function generateSchema(
  opts: LlmOptions,
  input: SchemaInput,
): Promise<GeneratedSchema> {
  const basePrompt = buildUserPrompt(input);
  let prompt = basePrompt;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw =
        opts.provider === 'anthropic'
          ? await callAnthropic(opts, SYSTEM_PROMPT, prompt)
          : await callOpenAI(opts, SYSTEM_PROMPT, prompt);
      const parsed = extractJson(raw);
      return validateSchema(parsed);
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt === 0) {
        cs.log('llm: attempt 1 failed (' + lastError.message + '); retrying with error feedback');
      }
      prompt =
        basePrompt +
        '\n\nYour previous reply was invalid: ' +
        lastError.message +
        '. Return ONLY the JSON object described in the system prompt.';
    }
  }
  throw lastError || new Error('LLM schema generation failed');
}
