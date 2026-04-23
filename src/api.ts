// MI backend API helpers. Wraps cs.runApiRequest in Promises, refreshes the
// script token proactively + on 401, and PUTs dataset_data sequentially
// (MI serializes dataset writes via a task lock — concurrent PUTs to the same
// dataset are rejected with "Task is conflicting").

import { cs } from '@metricinsights/cs-helper';

export type AjaxOptions = {
  type?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  contentType?: string;
  dataType?: string;
  data?: string;
  headers?: Record<string, string>;
};

export class MiApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function joinHomeAndPath(path: string): string {
  const base = cs.homeSite.replace(/\/?$/, '/');
  return base + path.replace(/^\//, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw request with no auth wrapping — used by both the public request() and
// by the token refresh itself (which must not recurse into refresh logic).
function executeRequest<T = any>(path: string, options: AjaxOptions = {}): Promise<T> {
  const url = joinHomeAndPath(path);
  return new Promise<T>((resolve, reject) => {
    cs.runApiRequest(url, {
      ...options,
      success: function (data: T) {
        resolve(data);
      },
      error: function (xhr: any, textStatus: string, err: any) {
        const status = (xhr && xhr.status) || 0;
        const body = (xhr && xhr.responseText) || '';
        const msg = `${options.type || 'GET'} ${path} failed: ${status} ${textStatus} ${String(err || '')}`.trim();
        reject(new MiApiError(msg, status, body));
      },
    });
  });
}

// Token refresh state. Proactive interval is set below the common 5-minute MI
// default so we refresh with buffer. Mutex ensures that even if multiple calls
// trigger a refresh around the same time, only one token fetch fires.
const PROACTIVE_REFRESH_MS = 3 * 60 * 1000;
let lastTokenRefreshMs = Date.now();
let refreshInFlight: Promise<void> | null = null;

async function refreshToken(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const r = await executeRequest<{ token?: string; expires?: string }>(
        'api/get_token',
      );
      if (r && r.token) {
        cs.apiToken = r.token;
        lastTokenRefreshMs = Date.now();
        cs.log('api: token refreshed');
      } else {
        cs.log('api: token refresh returned no token; keeping existing');
      }
    } catch (e: any) {
      cs.log('api: token refresh failed (' + (e && e.message) + '); keeping existing');
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function ensureFreshToken(): Promise<void> {
  if (Date.now() - lastTokenRefreshMs >= PROACTIVE_REFRESH_MS) {
    await refreshToken();
  }
}

// Public request: refreshes if stale, executes, retries once on 401 after a
// forced refresh. Other errors bubble up.
export async function request<T = any>(path: string, options: AjaxOptions = {}): Promise<T> {
  await ensureFreshToken();
  try {
    return await executeRequest<T>(path, options);
  } catch (err: any) {
    if (err instanceof MiApiError && err.status === 401) {
      cs.log('api: 401 on ' + path + '; refreshing token and retrying');
      lastTokenRefreshMs = 0;
      await refreshToken();
      return await executeRequest<T>(path, options);
    }
    throw err;
  }
}

export type PutDatasetDataOptions = {
  append?: boolean;
  measurementTime?: string; // 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' — required for snapshot datasets
};

function isTaskConflict(err: MiApiError): boolean {
  return err.status === 400 && /conflicting with existing task/i.test(err.body || '');
}

// One PUT. Transparent retry on MI's "Task is conflicting" response (which can
// happen if a previous dataset task hasn't fully released its lock yet).
export async function putDatasetData<Row extends Record<string, unknown>>(
  datasetId: number,
  rows: Row[],
  options: PutDatasetDataOptions = {},
): Promise<any> {
  const body: Record<string, unknown> = {
    dataset: datasetId,
    data: rows,
  };
  if (options.append) body.append = 'Y';
  if (options.measurementTime) body.measurement_time = options.measurementTime;

  const reqOptions: AjaxOptions = {
    type: 'PUT',
    contentType: 'application/json',
    data: JSON.stringify(body),
  };

  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await request('api/dataset_data', reqOptions);
    } catch (e: any) {
      lastErr = e;
      if (e instanceof MiApiError && isTaskConflict(e) && attempt < maxAttempts - 1) {
        const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s
        cs.log(
          'api: dataset task conflict (attempt ' +
            String(attempt + 1) +
            '/' +
            String(maxAttempts) +
            '); waiting ' +
            String(backoff) +
            'ms',
        );
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export type ChunkedPutOptions = PutDatasetDataOptions & {
  chunkSize: number;
  onChunk?: (index: number, total: number, size: number) => void;
};

// Sequential chunked PUT. Chunk 1 honors the caller's append flag; chunks 2+
// always append so a "replace" call still replaces once and then grows.
export async function putDatasetDataChunked<Row extends Record<string, unknown>>(
  datasetId: number,
  rows: Row[],
  options: ChunkedPutOptions,
): Promise<{ chunks: number; rows: number }> {
  const size = Math.max(1, options.chunkSize);
  const total = Math.max(1, Math.ceil(rows.length / size));
  for (let i = 0; i < total; i++) {
    const slice = rows.slice(i * size, (i + 1) * size);
    const append = i === 0 ? !!options.append : true;
    if (options.onChunk) options.onChunk(i + 1, total, slice.length);
    await putDatasetData(datasetId, slice, {
      append,
      measurementTime: options.measurementTime,
    });
  }
  return { chunks: total, rows: rows.length };
}
