/**
 * Fachada pública do SDK.
 *
 * Superfície estável:
 *   client.sessions.*  — pareamento/ciclo de vida da conta de voz
 *   client.calls.*     — discar, atender, recusar, encerrar, SDP, histórico
 *   client.events.*    — stream SSE tipado (async iterator + subscribe)
 *   client.capabilities() — o que ESTE build do motor entrega
 *
 * O SDK não sabe de organizações, Supabase ou RBAC: quem chama resolve a
 * sessão da organização e passa `sessionId`/`clientId`. Essa separação é o que
 * permite usar o mesmo pacote no app, no worker e em scripts.
 */

import { toWaVoiceError, WaVoiceError } from "./errors";
import { parseSse, parseWaVoiceEvent } from "./sse";
import { HttpTransport, seg, type HttpTransportOptions } from "./transport";
import type {
  AcceptCallInput,
  CallRef,
  ExchangeWebrtcInput,
  HistoryQuery,
  StartCallInput,
  WaVoiceCall,
  WaVoiceCallRecord,
  WaVoiceCapabilities,
  WaVoiceEvent,
  WaVoiceHistoryPage,
  WaVoiceSession,
} from "./types";

export interface WaVoiceClientOptions extends HttpTransportOptions {
  /** `X-Client-Id` padrão do stream SSE; o worker usa para se identificar. */
  clientId?: string;
}

export class WaVoiceClient {
  private readonly transport: HttpTransport;
  private readonly clientId: string;

  readonly sessions: SessionsApi;
  readonly calls: CallsApi;
  readonly events: EventsApi;

  constructor(opts: WaVoiceClientOptions) {
    this.transport = new HttpTransport(opts);
    this.clientId = opts.clientId ?? "deskcomm-sdk";
    this.sessions = new SessionsApi(this.transport);
    this.calls = new CallsApi(this.transport);
    this.events = new EventsApi(this.transport, this.clientId);
  }

  /**
   * O que o motor por trás do SDK entrega hoje. `video`, `group` e `sframe`
   * são `false` de propósito: prometer no contrato o que o WaCalls atual não
   * faz é pior do que não ter o campo. As fases 2/3 ligam cada um.
   */
  capabilities(): WaVoiceCapabilities {
    return { audio: true, video: false, group: false, sframe: false, recording: false };
  }
}

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

export class SessionsApi {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /api/sessions` */
  async list(): Promise<WaVoiceSession[]> {
    const out = await this.transport.request<{ sessions?: WaVoiceSession[] }>("GET", "/api/sessions");
    return out?.sessions ?? [];
  }

  /**
   * `POST /api/sessions` — cria a conta E JÁ inicia o pareamento. O QR chega
   * pelo stream de eventos (`auth-state`/`session-qr`), não nesta resposta.
   */
  async create(name: string): Promise<{ id: string }> {
    return this.transport.request<{ id: string }>("POST", "/api/sessions", { body: { name } });
  }

  /** `POST /api/sessions/{id}/logout` — derruba o vínculo com o WhatsApp. */
  async logout(sessionId: string): Promise<void> {
    await this.transport.request<void>("POST", `/api/sessions/${seg(sessionId)}/logout`);
  }

  /** `DELETE /api/sessions/{id}` — remove a conta do processo. */
  async remove(sessionId: string): Promise<void> {
    await this.transport.request<void>("DELETE", `/api/sessions/${seg(sessionId)}`);
  }

  async find(sessionId: string): Promise<WaVoiceSession | null> {
    const all = await this.list();
    return all.find((s) => s.id === sessionId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

export class CallsApi {
  constructor(private readonly transport: HttpTransport) {}

  /**
   * `POST /api/sessions/{sid}/calls`
   *
   * `phone` é o número que o WhatsApp registrou (pode vir sem o nono dígito);
   * a resolução fica em `lib/voice/numero-discavel.ts`, fora do SDK.
   * `record` nunca é enviado: gravação está fora de escopo (spec 18 §1.2).
   */
  async start(input: StartCallInput): Promise<WaVoiceCall> {
    const out = await this.transport.request<{ call?: WaVoiceCall }>(
      "POST",
      `/api/sessions/${seg(input.sessionId)}/calls`,
      {
        headers: { "X-Client-Id": input.clientId },
        body: { phone: input.phone },
      },
    );
    if (!out?.call?.callId) throw WaVoiceError.badResponse("resposta sem call.callId");
    return out.call;
  }

  /** `POST .../calls/{id}/accept` */
  async accept(input: AcceptCallInput): Promise<void> {
    await this.transport.request<void>(
      "POST",
      `/api/sessions/${seg(input.sessionId)}/calls/${seg(input.callId)}/accept`,
      { headers: { "X-Client-Id": input.clientId } },
    );
  }

  /** `POST .../calls/{id}/reject` */
  async reject(ref: CallRef): Promise<void> {
    await this.transport.request<void>(
      "POST",
      `/api/sessions/${seg(ref.sessionId)}/calls/${seg(ref.callId)}/reject`,
    );
  }

  /** `DELETE .../calls/{id}` */
  async end(ref: CallRef): Promise<void> {
    await this.transport.request<void>(
      "DELETE",
      `/api/sessions/${seg(ref.sessionId)}/calls/${seg(ref.callId)}`,
    );
  }

  /** `POST .../calls/{id}/webrtc` — relay puro do SDP (a mídia não passa por aqui). */
  async exchangeWebrtc(input: ExchangeWebrtcInput): Promise<{ sdpAnswer: string }> {
    const out = await this.transport.request<{ sdp_answer?: string }>(
      "POST",
      `/api/sessions/${seg(input.sessionId)}/calls/${seg(input.callId)}/webrtc`,
      { body: { sdp_offer: input.sdpOffer } },
    );
    if (typeof out?.sdp_answer !== "string") throw WaVoiceError.badResponse("resposta sem sdp_answer");
    return { sdpAnswer: out.sdp_answer };
  }

  /** `GET .../history` — envelope `{calls, nextCursor}` (keyset). */
  async history(query: HistoryQuery): Promise<WaVoiceHistoryPage> {
    const out = await this.transport.request<{ calls?: WaVoiceCallRecord[]; nextCursor?: string | null }>(
      "GET",
      `/api/sessions/${seg(query.sessionId)}/history`,
      { query: { limit: query.limit, cursor: query.cursor } },
    );
    return { calls: out?.calls ?? [], nextCursor: out?.nextCursor ?? null };
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export interface EventStreamOptions {
  signal?: AbortSignal;
  clientId?: string;
  /** Replay do último evento visto (suportado pelo SSE padrão). */
  lastEventId?: string;
}

export interface SubscribeOptions extends EventStreamOptions {
  /** Reconecta com backoff? Padrão `true`. */
  reconnect?: boolean;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onError?: (err: WaVoiceError) => void;
}

export class EventsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly defaultClientId: string,
  ) {}

  /** Uma conexão, sem reconexão: itera até o servidor fechar ou o sinal abortar. */
  async *stream(opts: EventStreamOptions = {}): AsyncGenerator<WaVoiceEvent> {
    const headers: Record<string, string> = {
      "X-Client-Id": opts.clientId ?? this.defaultClientId,
    };
    if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

    const res = await this.transport.stream("/api/events", { headers, signal: opts.signal });
    if (!res.body) throw WaVoiceError.badResponse("stream de eventos sem corpo");

    for await (const message of parseSse(res.body)) {
      if (!message.data) continue;
      yield parseWaVoiceEvent(message.data);
    }
  }

  /**
   * Consome o stream em background com reconexão exponencial. Devolve a função
   * de cancelamento — o mesmo contrato do `unsubscribe` de qualquer event emitter.
   */
  subscribe(handler: (event: WaVoiceEvent) => void, opts: SubscribeOptions = {}): () => void {
    const controller = new AbortController();
    const callerSignal = opts.signal;
    const onAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) return () => {};
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    const signal = controller.signal;
    const reconnect = opts.reconnect ?? true;
    const initial = opts.initialBackoffMs ?? 1_000;
    const max = opts.maxBackoffMs ?? 30_000;

    void (async () => {
      let backoff = initial;
      while (!signal.aborted) {
        try {
          for await (const event of this.stream({ ...opts, signal })) {
            backoff = initial;
            handler(event);
          }
        } catch (err) {
          if (signal.aborted) break;
          opts.onError?.(toWaVoiceError(err));
        }
        if (!reconnect || signal.aborted) break;
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, max);
      }
    })();

    return () => {
      controller.abort();
      callerSignal?.removeEventListener("abort", onAbort);
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
