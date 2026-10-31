/**
 * Transporte HTTP do SDK.
 *
 * - `fetch` é injetável (testes e runtimes alternativos);
 * - timeout por requisição com `AbortController` (o SSE não usa timeout);
 * - erro nunca vira `Error` genérico: sai como `WaVoiceError` tipado;
 * - `Content-Type`, `Authorization: Bearer` e `cache: no-store` em toda chamada.
 */

import { WaVoiceError } from "./errors";

export type FetchLike = typeof fetch;

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  /** Timeout padrão de requisições JSON. SSE não é afetado. */
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export type HttpMethod = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: HttpTransportOptions) {
    const base = opts.baseUrl.trim();
    if (!base) throw new Error("wa-voice-sdk: baseUrl obrigatória");
    if (!opts.token.trim()) throw new Error("wa-voice-sdk: token obrigatório (a API exige Bearer)");
    this.baseUrl = base.replace(/\/+$/, "");
    this.token = opts.token.trim();
    // Resolvido por requisição: `vi.stubGlobal("fetch")` depois do construtor
    // continua valendo, e o mesmo cliente serve a runtimes com fetch trocado.
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /** GET cru para SSE: sem timeout e sem parse, mas com auth e checagem de status. */
  async stream(path: string, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const doFetch = this.fetchImpl ?? fetch;
    const res = await doFetch(this.buildUrl(path), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.token}`,
        ...this.defaultHeaders,
        ...opts.headers,
      },
      cache: "no-store",
      signal: opts.signal,
    });
    if (!res.ok) {
      throw WaVoiceError.fromResponse(res.status, await readBody(res));
    }
    return res;
  }

  async request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const callerSignal = opts.signal;
    const onAbort = () => controller.abort(callerSignal?.reason);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (callerSignal) {
      if (callerSignal.aborted) throw WaVoiceError.aborted(callerSignal.reason);
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...this.defaultHeaders,
        ...opts.headers,
      },
      cache: "no-store",
      signal: controller.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let res: Response;
    try {
      const doFetch = this.fetchImpl ?? fetch;
      res = await doFetch(this.buildUrl(path, opts.query), init);
    } catch (err) {
      if (callerSignal?.aborted) throw WaVoiceError.aborted(err);
      if (timedOut) throw WaVoiceError.timeout(timeoutMs);
      throw WaVoiceError.network(err);
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      throw WaVoiceError.fromResponse(res.status, await readBody(res));
    }
    if (res.status === 204) return undefined as T;
    // `Response` real sempre tem `text`. Mocks de teste (e alguns runtimes
    // mínimos) só têm `json`, e o contrato do SDK não obriga o chamador a
    // montar um Response completo.
    if (typeof res.text !== "function") {
      return (await res.json()) as T;
    }
    const text = await res.text().catch(() => "");
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw WaVoiceError.badResponse(text);
    }
  }
}

/** `encodeURIComponent` com nome curto — usado em todos os paths com id. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

async function readBody(res: Response): Promise<string> {
  if (typeof res.text === "function") return res.text().catch(() => "");
  if (typeof res.json === "function") {
    try {
      return JSON.stringify(await res.json());
    } catch {
      return "";
    }
  }
  return "";
}
