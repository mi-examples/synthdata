// Synthetic row generator. Consumes a schema from llm.ts and produces rows
// using a seedable RNG, a date walker, uniform dimension sampling, and a
// base × trend × seasonality × noise measure function.

import type { GeneratedSchema, Grain, Seasonality } from './llm';

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

function addGrain(d: Date, grain: Grain): void {
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function enumerateDates(start: Date, end: Date, grain: Grain): Date[] {
  const out: Date[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    out.push(new Date(cursor.getTime()));
    addGrain(cursor, grain);
  }
  return out;
}

function seasonalityMultiplier(kind: Seasonality, d: Date): number {
  const month = d.getUTCMonth(); // 0-11
  if (kind === 'retail_q4_peak') {
    if (month === 10 || month === 11) return 1.5;
    if (month === 0 || month === 1) return 0.8;
    return 1.0;
  }
  if (kind === 'summer_peak') {
    if (month >= 5 && month <= 7) return 1.3;
    if (month === 11 || month === 0) return 0.8;
    return 1.0;
  }
  return 1.0;
}

function measureValue(
  schema: GeneratedSchema,
  d: Date,
  startDate: Date,
  rng: () => number,
): number {
  const m = schema.measure;
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const years = (d.getTime() - startDate.getTime()) / msPerYear;
  const trend = 1 + (m.trend_pct_per_year / 100) * years;
  const season = seasonalityMultiplier(m.seasonality, d);
  const noise = 1 + (rng() - 0.5) * 2 * (m.noise_pct / 100);
  const raw = m.base * trend * season * noise;
  const measureType = schema.schema[m.name].type;
  if (measureType === 'integer') return Math.max(0, Math.round(raw));
  return Math.max(0, Number(raw.toFixed(2)));
}

export type Row = Record<string, string | number>;

export function generateRows(
  schema: GeneratedSchema,
  targetRows: number,
  seed: number,
): Row[] {
  const rng = mulberry32(seed || Date.now());
  const start = parseDate(schema.date_range.start);
  const end = parseDate(schema.date_range.end);
  const dates = enumerateDates(start, end, schema.date_range.grain);
  if (dates.length === 0) {
    throw new Error('date_range produced zero dates (check start/end/grain)');
  }

  const columns = Object.keys(schema.schema);
  const dateCol = columns.filter((c) => schema.schema[c].type === 'date')[0];
  const measureCol = schema.measure.name;
  const stringCols = columns.filter((c) => schema.schema[c].type === 'string');

  const rowsPerDate = Math.max(1, Math.ceil(targetRows / dates.length));
  const rows: Row[] = [];

  for (const d of dates) {
    for (let i = 0; i < rowsPerDate; i++) {
      if (rows.length >= targetRows) break;
      const row: Row = {};
      row[dateCol] = formatDate(d);
      for (const c of stringCols) {
        const values = schema.dimension_values[c];
        row[c] = values[Math.floor(rng() * values.length)];
      }
      row[measureCol] = measureValue(schema, d, start, rng);
      rows.push(row);
    }
    if (rows.length >= targetRows) break;
  }

  return rows;
}
