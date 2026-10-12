export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${url}`);
    this.name = "HttpError";
  }
}

export async function request<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}
