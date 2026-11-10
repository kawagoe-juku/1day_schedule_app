/**
 * 外部 API のモック。外部 API クライアントに fetch の代わりに渡して使う（実際の通信はしない）。
 *
 *   const api = createFakeFetch();
 *   api.on('GET', 'https://example.com/v1/items', () => json({ items: [] }));
 *   const client = createSomeClient({ fetch: api.fetch });
 *   ...
 *   expect(api.calls).toHaveLength(1);
 *
 * 登録していない宛先への要求は例外にする（テストから本物の API を呼ばないため）。
 */

export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
  /** 要求の本文（JSON なら解析済み、それ以外は文字列、無ければ undefined） */
  body: unknown;
  /** 呼び出し側が渡した打ち切りの合図（タイムアウトなど） */
  signal: AbortSignal;
}

/** 応答を返す関数。同じ宛先に複数回登録すると、呼ばれるたびに順に使う（最後の1つは繰り返す） */
export type Responder = (call: FakeCall) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  /** 宛先（メソッドと、クエリを除いた URL）ごとに応答を登録する */
  on(method: string, url: string, ...responders: Responder[]): FakeFetch;
  /** 受け取った要求の記録（順番どおり） */
  calls: FakeCall[];
}

/** JSON の応答 */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 本文なしの応答（5xx などの確認用） */
export function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: code, headers });
}

/**
 * 応答を返さない（タイムアウトの確認用）。`api.on('GET', url, hang)` のように登録する。
 * 呼び出し側が AbortSignal で打ち切ると、本物の fetch と同じようにその理由で失敗する。
 */
export const hang: Responder = (call) =>
  new Promise((_resolve, reject) => {
    const abort = () => reject(call.signal.reason);
    if (call.signal.aborted) abort();
    else call.signal.addEventListener('abort', abort, { once: true });
  });

/** 通信エラー（接続できないなど）。本物の fetch と同じ TypeError で失敗させる */
export const networkError: Responder = () => {
  throw new TypeError('fetch failed');
};

const keyOf = (method: string, url: URL) => `${method.toUpperCase()} ${url.origin}${url.pathname}`;

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return undefined;
  if (contentType?.includes('json')) return JSON.parse(text);
  return text;
}

export function createFakeFetch(): FakeFetch {
  const routes = new Map<string, Responder[]>();
  const calls: FakeCall[] = [];

  const fake: FakeFetch = {
    calls,
    on(method, url, ...responders) {
      const key = keyOf(method, new URL(url));
      routes.set(key, [...(routes.get(key) ?? []), ...responders]);
      return fake;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const call: FakeCall = {
        method: request.method,
        url,
        headers: request.headers,
        body: parseBody(await request.clone().text(), request.headers.get('content-type')),
        // 呼び出し側の合図をそのまま使う（Request が複製した合図は、打ち切りが伝わらないことがある）
        signal: init?.signal ?? request.signal,
      };
      calls.push(call);
      const key = keyOf(request.method, url);
      const responders = routes.get(key);
      if (!responders || responders.length === 0) {
        throw new Error(`モックに登録していない宛先です：${key}`);
      }
      // 登録が複数あれば順に使い、最後の1つは残して繰り返す
      const responder = responders.length > 1 ? responders.shift() : responders[0];
      if (!responder) throw new Error(`モックに登録していない宛先です：${key}`);
      return responder(call);
    },
  };
  return fake;
}
