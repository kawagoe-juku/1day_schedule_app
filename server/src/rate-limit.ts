import { AppError } from './errors.js';

export interface RateLimiterOptions {
  /** 期間内に許す回数 */
  limit: number;
  /** 期間（ミリ秒） */
  windowMs: number;
  /** テスト用。現在時刻（ミリ秒） */
  now?: () => number;
}

export interface RateLimiter {
  /** 1回分を数える。上限を超えていたら 429 RATE_LIMITED を投げる */
  consume(key: string): void;
}

/** 覚えておくキーの上限。超えたら、期間の終わったものを捨てる（メモリを使い続けないため） */
const MAX_KEYS = 10_000;

/**
 * 利用者ごとの回数制限（期間を区切って数える方式）。
 * 回数はこのサーバの中だけで数える。サーバが複数台あるときの実際の上限は「上限 × 台数」になるが、
 * 目的は連打による外部 API の課金と利用枠の消費を抑えることなので、厳密さは求めない。
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, now = Date.now } = options;
  const windows = new Map<string, { startedAt: number; count: number }>();

  return {
    consume(key) {
      const time = now();
      const current = windows.get(key);
      if (!current || time - current.startedAt >= windowMs) {
        if (windows.size >= MAX_KEYS) {
          for (const [k, w] of windows) {
            if (time - w.startedAt >= windowMs) windows.delete(k);
          }
          // それでも減らなければ（全員が期間内）、全部捨てて数え直す
          if (windows.size >= MAX_KEYS) windows.clear();
        }
        windows.set(key, { startedAt: time, count: 1 });
        return;
      }
      current.count += 1;
      if (current.count > limit) {
        const retryAfterSeconds = Math.ceil((current.startedAt + windowMs - time) / 1000);
        throw new RateLimitedError(retryAfterSeconds);
      }
    },
  };
}

/** 回数制限の超過。エラーハンドラが Retry-After ヘッダーを付けて返す */
export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'しばらく時間をおいて再度お試しください');
    this.name = 'RateLimitedError';
  }
}
