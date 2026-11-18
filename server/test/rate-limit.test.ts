import { describe, expect, it } from 'vitest';
import { RateLimitedError, createRateLimiter } from '../src/rate-limit.js';

describe('回数制限', () => {
  const setup = () => {
    let time = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => time });
    return { limiter, advance: (ms: number) => (time += ms) };
  };

  it('期間内は上限まで通し、超えたら 429 にする', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i += 1) limiter.consume('user-a');
    advance(15_000);
    try {
      limiter.consume('user-a');
      expect.unreachable('上限を超えたのに通った');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      expect((error as RateLimitedError).statusCode).toBe(429);
      expect((error as RateLimitedError).retryAfterSeconds).toBe(45);
    }
  });

  it('期間が過ぎたら、また通す', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i += 1) limiter.consume('user-a');
    advance(60_000);
    expect(() => limiter.consume('user-a')).not.toThrow();
  });

  it('利用者ごとに別々に数える', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i += 1) limiter.consume('user-a');
    expect(() => limiter.consume('user-b')).not.toThrow();
    expect(() => limiter.consume('user-a')).toThrow(RateLimitedError);
  });
});
