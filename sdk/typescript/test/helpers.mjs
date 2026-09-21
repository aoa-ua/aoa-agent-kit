/**
 * Mocked fetch: records every call and answers from a queue of responses.
 * Each queued item is `{ status, body, headers }` or a function of the call.
 */
export const mockFetch = (...queue) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const call = {
      url: new URL(url),
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error(`Unexpected request ${call.method} ${url}`);
    const spec = typeof next === 'function' ? await next(call) : next;
    const body =
      typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body ?? {});
    return new Response(body, {
      status: spec.status ?? 200,
      statusText: spec.statusText ?? '',
      headers: spec.headers ?? { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, calls };
};

export const TEST_KEY = 'aoa_live_test_key_not_real';
