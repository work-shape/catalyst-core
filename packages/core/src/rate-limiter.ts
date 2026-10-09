/** How many calls one key may make within one window. */
export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** How long a refused caller has to wait before the key is counted afresh. */
  retryAfterMs: number;
}

/**
 * Counts calls per key. The counters live wherever the implementation keeps them: in the API
 * process while an instance runs one, in the database once it runs several.
 */
export interface RateLimiter {
  /** Counts one call against `key` and says whether it is still within `rule`. */
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}
