/**
 * Contrato público do SDK de voz (`@deskcomm/wa-voice-sdk`).
 *
 * Este arquivo é a fronteira: nada aqui importa Next, Supabase, `env` ou
 * `logger`. O pacote é deliberadamente puro (só `fetch` + Web Streams) para
 * poder ser consumido pelo app, pelo worker, por scripts e, no futuro, por
 * outro produto sem arrastar o CRM junto.
 */

/** Sessão de WhatsApp pareada para voz (uma por organização). */
export interface WaVoiceSession {
  id: string;
  name: string;
  jid: string;
  /** `open` é o estado saudável; `logged_out` exige novo pareamento. */
  state: string;
  paired: boolean;
}

/** Status do upstream (cmd/server/broker.go), passthrough literal. */
export type WaVoiceCallStatus = "starting" | "ringing" | "connected" | "ended";

/** Linha de histórico devolvida pelo upstream. */
export interface WaVoiceCallRecord {
  sessionId: string;
  callId: string;
  owner: string | null;
  direction: "inbound" | "outbound";
  peer: string;
  startedAt: number;
  status: WaVoiceCallStatus;
  endedAt?: number;
  endReason?: string;
}

/** Handle mínimo de uma chamada iniciada. */
export interface WaVoiceCall {
  callId: string;
}

export interface WaVoiceHistoryPage {
  calls: WaVoiceCallRecord[];
  nextCursor: string | null;
}

export interface WaVoiceCapabilities {
  /** Áudio 1:1 — o que o motor atual entrega. */
  audio: boolean;
  /** Vídeo — fase 3 (WebCodecs), sempre `false` neste build. */
  video: boolean;
  /** Chamadas de grupo/SFU — fase 3. */
  group: boolean;
  /** SFrame E2E — fase 2; hoje o motor atual usa SRTP derivado da call key. */
  sframe: boolean;
  /** Gravação — desligada por LGPD (spec 18 §1.2). */
  recording: boolean;
}

// ---------------------------------------------------------------------------
// Entradas das operações
// ---------------------------------------------------------------------------

export interface StartCallInput {
  sessionId: string;
  /** `auth.users.id` — vira o dono da chamada no upstream. Nunca vem do browser. */
  clientId: string;
  /** Número já resolvido (com/sem nono dígito) — ver `lib/voice/numero-discavel.ts`. */
  phone: string;
}

export interface AcceptCallInput {
  sessionId: string;
  callId: string;
  clientId: string;
}

export interface CallRef {
  sessionId: string;
  callId: string;
}

export interface ExchangeWebrtcInput extends CallRef {
  sdpOffer: string;
}

export interface HistoryQuery {
  sessionId: string;
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Eventos do stream SSE (`GET /api/events`)
// ---------------------------------------------------------------------------

export interface WaVoiceEventBase {
  type: string;
  sessionId?: string;
}

export interface AuthStateEvent extends WaVoiceEventBase {
  type: "auth-state";
  paired: boolean;
  state: string;
  qr?: string;
}

export interface SessionQrEvent extends WaVoiceEventBase {
  type: "session-qr";
  qr: string;
}

export interface SessionListEvent extends WaVoiceEventBase {
  type: "session-list";
  sessions: WaVoiceSession[];
}

export interface CallStatusEvent extends WaVoiceEventBase {
  type: "call-status";
  id: string;
  owner: string | null;
  status: WaVoiceCallStatus;
  peer: string;
  startedAt: number;
}

export interface CallEndedEvent extends WaVoiceEventBase {
  type: "call-ended";
  id: string;
  owner: string | null;
  reason: string;
  endedAt: number;
}

export interface CallListEvent extends WaVoiceEventBase {
  type: "call-list";
  calls: WaVoiceCallRecord[];
}

export interface IncomingEvent extends WaVoiceEventBase {
  type: "incoming";
  id: string;
  peer: string;
  offeredAt: number;
}

export interface IncomingClaimedEvent extends WaVoiceEventBase {
  type: "incoming-claimed";
  id: string;
  owner: string;
}

export interface CallQualityEvent extends WaVoiceEventBase {
  type: "call-quality";
  id?: string;
  [key: string]: unknown;
}

/** Evento desconhecido — o upstream pode ganhar tipos novos (doutrina DIRC). */
export interface UnknownWaVoiceEvent extends WaVoiceEventBase {
  [key: string]: unknown;
}

export type WaVoiceEvent =
  | AuthStateEvent
  | SessionQrEvent
  | SessionListEvent
  | CallStatusEvent
  | CallEndedEvent
  | CallListEvent
  | IncomingEvent
  | IncomingClaimedEvent
  | CallQualityEvent
  | UnknownWaVoiceEvent;

/** Item decodificado de um stream SSE. */
export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}
