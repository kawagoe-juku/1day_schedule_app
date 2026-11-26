/**
 * 想定外の例外を、ログに出してよい形にする。
 * DB の失敗（Drizzle の例外）は、メッセージに SQL へ渡した値（住所・座標など）が入るため、
 * そのままは出さない。SQL の文（値は $1 などの記号）と、PostgreSQL のエラーコードだけを残す。
 */
export function toLoggableError(error: unknown): Record<string, unknown> {
  if (error instanceof Error && 'query' in error && 'params' in error) {
    const cause: unknown = error.cause;
    return {
      dbError: {
        type: error.name,
        query: typeof error.query === 'string' ? error.query : undefined,
        // 23505（一意制約）などのコード。メッセージと detail には値が入り得るので出さない
        code: cause instanceof Error && 'code' in cause ? cause.code : undefined,
        causeType: cause instanceof Error ? cause.name : undefined,
      },
    };
  }
  return { err: error };
}
