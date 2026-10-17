export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded; strings are sent as-is. */
  body?: unknown;
}

/** Scripted fetch: responses are consumed in order; every call is recorded. */
export function createFakeFetch(script: Array<ScriptedResponse | Error>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
    });
    const next = script[i++];
    if (next === undefined) throw new Error('fakeFetch: script exhausted');
    if (next instanceof Error) throw next;
    const body =
      typeof next.body === 'string' || next.body === undefined
        ? (next.body as string | undefined)
        : JSON.stringify(next.body);
    return new Response(body, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}
