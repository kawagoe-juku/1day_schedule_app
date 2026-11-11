/**
 * 外部 API を呼ぶ共通処理：タイムアウト・リトライ・呼び出し回数のメトリクス。
 * 各クライアント（google-maps.ts・navitime.ts）はここの requestJson だけを使って通信する。
 */
import type { z } from 'zod';
import { noopMetrics, type CallOutcome, type ExternalApiMetrics } from './metrics.js';

export type FetchLike = typeof fetch;

export interface HttpOptions {
  /** 通信に使う関数（テストではモックを渡す） */
  fetch?: FetchLike;
  /** 1回の呼び出しを打ち切るまでの時間（既定 4000ms） */
  timeoutMs?: number;
  /** 失敗時にやり直す回数（既定 1 回。5xx・429・タイムアウト・通信エラーのときだけ） */
  retries?: number;
  /** やり直す前に待つ時間（既定 200ms。2回目以降は倍にする） */
  retryDelayMs?: number;
  metrics?: ExternalApiMetrics;
  /** 待つ処理（テストで待ち時間をなくすために差し替える） */
  sleep?: (ms: number) => Promise<void>;
}

export type ExternalApiErrorKind =
  /** 時間内に応答がなかった */
  | 'timeout'
  /** 接続できなかった */
  | 'network'
  /** 4xx・5xx が返った */
  | 'http'
  /** 200 だが、中身がエラー、または想定と違う形だった */
  | 'invalid_response';

/**
 * 外部 API の失敗。エラーハンドラ（app.ts）が 502 EXTERNAL_SERVICE_ERROR に変換する。
 * メッセージに URL や応答の本文を入れない（API キーや住所・座標をログに残さないため）。
 */
export class ExternalApiError extends Error {
  constructor(
    readonly service: string,
    readonly operation: string,
    readonly kind: ExternalApiErrorKind,
    /** kind=http のときの HTTP ステータス */
    readonly status?: number,
    detail?: string,
  ) {
    super(
      `${service}.${operation} failed: ${kind}${status ? ` ${status}` : ''}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'ExternalApiError';
  }
}

export interface JsonRequest<T> {
  service: string;
  operation: string;
  method?: 'GET' | 'POST';
  url: string | URL;
  headers?: Record<string, string>;
  /** POST の本文（JSON にして送る） */
  body?: unknown;
  /** 応答の形。合わなければ invalid_response にする */
  schema: z.ZodType<T>;
}

const DEFAULTS = { timeoutMs: 4000, retries: 1, retryDelayMs: 200 };
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

/** やり直せば成功するかもしれない失敗か（4xx は何度やっても同じなので、やり直さない） */
const isRetryable = (error: ExternalApiError) =>
  error.kind === 'timeout' ||
  error.kind === 'network' ||
  (error.kind === 'http' && (error.status === 429 || (error.status ?? 0) >= 500));

export async function requestJson<T>(
  request: JsonRequest<T>,
  options: HttpOptions = {},
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = options.retries ?? DEFAULTS.retries;
  const retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
  const metrics = options.metrics ?? noopMetrics;
  const sleep = options.sleep ?? defaultSleep;
  const { service, operation } = request;
  const fail = (kind: ExternalApiErrorKind, status?: number, detail?: string) =>
    new ExternalApiError(service, operation, kind, status, detail);

  /** 1回呼び出して、結果をメトリクスに記録する */
  const attempt = async (): Promise<T> => {
    const startedAt = performance.now();
    const record = (outcome: CallOutcome) =>
      metrics.record({ service, operation, outcome, durationMs: performance.now() - startedAt });

    let response: Response;
    let text: string;
    // 打ち切りの合図は変数で持ち、応答を待つ間に破棄されないようにする
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      response = await doFetch(request.url, {
        method: request.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: timeout,
      });
      // 本文の受信もタイムアウトの対象（途中で止まる応答を待ち続けない）
      text = await response.text();
    } catch (error) {
      const timedOut = timeout.aborted || isTimeout(error);
      record(timedOut ? 'timeout' : 'network_error');
      throw fail(timedOut ? 'timeout' : 'network');
    }

    if (!response.ok) {
      record(response.status >= 500 ? 'server_error' : 'client_error');
      throw fail('http', response.status);
    }
    record('success');

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw fail('invalid_response', undefined, 'not json');
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      // どの項目が合わなかったかだけを残す（値は残さない）
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
      throw fail(
        'invalid_response',
        undefined,
        `unexpected shape: ${[...new Set(paths)].join(', ')}`,
      );
    }
    return parsed.data;
  };

  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ExternalApiError) || !isRetryable(error) || tried >= retries) {
        throw error;
      }
      await sleep(retryDelayMs * 2 ** tried);
    }
  }
}
