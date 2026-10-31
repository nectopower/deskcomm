/**
 * `@deskcomm/wa-voice-sdk` — SDK de chamadas de voz do Deskcomm.
 *
 * Fase 1: empacota o contrato do WaCalls (motor atual) sem acoplar ao Next.
 * O motor por trás é substituível: as fases 2/3 trocam a implementação e
 * mantêm esta superfície.
 *
 * Regra de ouro: o browser nunca fala com o motor. Tudo passa pelas rotas
 * `/api/v1/voice/*` do app, que resolvem organização, RBAC e número discável.
 */

export { WaVoiceClient, SessionsApi, CallsApi, EventsApi } from "./client";
export type {
  WaVoiceClientOptions,
  EventStreamOptions,
  SubscribeOptions,
} from "./client";

export { WaVoiceError, toWaVoiceError } from "./errors";
export type { WaVoiceErrorCode, WaVoiceErrorOptions } from "./errors";

export { HttpTransport, seg } from "./transport";
export type { HttpTransportOptions, FetchLike, HttpMethod, RequestOptions } from "./transport";

export { parseSse, parseWaVoiceEvent } from "./sse";

export type {
  AcceptCallInput,
  AuthStateEvent,
  CallEndedEvent,
  CallListEvent,
  CallQualityEvent,
  CallRef,
  CallStatusEvent,
  ExchangeWebrtcInput,
  HistoryQuery,
  IncomingClaimedEvent,
  IncomingEvent,
  SessionListEvent,
  SessionQrEvent,
  SseMessage,
  StartCallInput,
  UnknownWaVoiceEvent,
  WaVoiceCall,
  WaVoiceCallRecord,
  WaVoiceCallStatus,
  WaVoiceCapabilities,
  WaVoiceEvent,
  WaVoiceEventBase,
  WaVoiceHistoryPage,
  WaVoiceSession,
} from "./types";
