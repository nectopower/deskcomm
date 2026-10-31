/**
 * Adaptador de compatibilidade: `WacallsClient` → SDK (`@deskcomm/wa-voice-sdk`).
 *
 * A implementação real mora em `lib/wa-voice-sdk/`. Este arquivo existe para
 * que as rotas, o worker e os testes que já falam `WacallsClient` continuem
 * funcionando sem mudança — a rota atual fica disponível enquanto o SDK é
 * adotado aos poucos.
 *
 * O que NÃO mudou:
 *   - a API exige Bearer (`WACALLS_API_TOKEN`); sem token o cliente é `null`;
 *   - o formato do erro continua `wacalls_<status>: <corpo>`;
 *   - `POST /api/sessions` já inicia o pareamento (nunca chamar `/pair`).
 */

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { WaVoiceClient, WaVoiceError } from "@/lib/wa-voice-sdk";
import type { WaVoiceCallRecord, WaVoiceSession } from "@/lib/wa-voice-sdk";

/** Nomes históricos mantidos para não quebrar imports existentes. */
export type WacallsSessionInfo = WaVoiceSession;
export type WacallsCallRecord = WaVoiceCallRecord;

export class WacallsClient {
  private readonly sdk: WaVoiceClient;

  constructor(baseUrl: string, apiToken: string) {
    this.sdk = new WaVoiceClient({ baseUrl, token: apiToken, clientId: "deskcomm" });
  }

  /**
   * `POST /api/sessions` — cria a conta E JÁ inicia o pareamento.
   * O QR começa a sair no `/api/events` antes de esta resposta chegar.
   */
  createSession(name: string): Promise<{ id: string }> {
    return this.sdk.sessions.create(name);
  }

  /** `GET /api/sessions` */
  listSessions(): Promise<WacallsSessionInfo[]> {
    return this.sdk.sessions.list();
  }

  /**
   * `DELETE /api/sessions/{sid}` — remove a conta do WaCalls.
   * Sozinho não basta para desparear: ver `lib/voice/desparear.ts`, que chama
   * `logoutSession` ANTES desta.
   */
  deleteSession(sessionId: string): Promise<void> {
    return this.sdk.sessions.remove(sessionId);
  }

  /** `POST /api/sessions/{sid}/logout` — derruba o vínculo com o WhatsApp. */
  logoutSession(sessionId: string): Promise<void> {
    return this.sdk.sessions.logout(sessionId);
  }

  /**
   * `POST /api/sessions/{sid}/calls` — inicia chamada outbound.
   * `clientId` vira o dono da chamada (exclusividade) — SEMPRE o user.id da
   * sessão autenticada, nunca escolhido pelo frontend.
   */
  startCall(sessionId: string, clientId: string, phone: string): Promise<{ callId: string }> {
    return this.sdk.calls.start({ sessionId, clientId, phone });
  }

  /** `POST .../calls/{id}/webrtc` — relay puro do SDP. */
  exchangeWebrtc(sessionId: string, callId: string, sdpOffer: string): Promise<{ sdpAnswer: string }> {
    return this.sdk.calls.exchangeWebrtc({ sessionId, callId, sdpOffer });
  }

  acceptCall(sessionId: string, callId: string, clientId: string): Promise<void> {
    return this.sdk.calls.accept({ sessionId, callId, clientId });
  }

  rejectCall(sessionId: string, callId: string): Promise<void> {
    return this.sdk.calls.reject({ sessionId, callId });
  }

  endCall(sessionId: string, callId: string): Promise<void> {
    return this.sdk.calls.end({ sessionId, callId });
  }

  /** `GET .../history` — envelope `{calls, nextCursor}` (keyset). */
  history(
    sessionId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ calls: WacallsCallRecord[]; nextCursor: string | null }> {
    return this.sdk.calls.history({ sessionId, limit: opts.limit, cursor: opts.cursor });
  }
}

/**
 * `null` quando não configurado — o chamador degrada para "indisponível".
 *
 * As DUAS chaves são exigidas: o upstream autenticado só aceita Bearer OU
 * cookie de login, e o app não tem cookie. Aceitar `baseUrl` sem token daria
 * um cliente que constrói e devolve 401 em toda chamada.
 */
export function getWacallsClient(): WacallsClient | null {
  const url = (env.WACALLS_API_BASE_URL ?? "").trim();
  const token = (env.WACALLS_API_TOKEN ?? "").trim();
  if (!url) {
    logger.debug("wacalls: WACALLS_API_BASE_URL ausente, cliente indisponível");
    return null;
  }
  if (!token) {
    logger.warn("wacalls: WACALLS_API_TOKEN ausente — a API do WaCalls exige Bearer", {});
    return null;
  }
  return new WacallsClient(url, token);
}

/**
 * "websocket not connected" DE DENTRO DO WHATSMEOW — queda real do socket.
 *
 * A causa histórica (dois clientes whatsmeow na mesma sessão por causa do
 * `POST /pair`) está resolvida: este repositório nunca chama `/pair`. O que
 * resta é queda de rede de verdade — passageira, porque o whatsmeow reconecta
 * sozinho; a rota devolve 503 com `Retry-After`.
 */
export function wacallsSemConexao(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("websocket not connected");
}

export function wacallsFriendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof WaVoiceError ? err.code : undefined;

  if (wacallsSemConexao(err)) {
    return "O número de voz está sem conexão com o WhatsApp neste momento. Aguarde alguns segundos e tente de novo; se continuar, desconecte o número e pareie de novo em Configurações › Canais.";
  }
  if (code === "unauthorized" || code === "forbidden" || msg.includes("wacalls_401") || msg.includes("wacalls_403")) {
    return "O serviço de chamada de voz recusou a credencial deste servidor. Confira WACALLS_API_TOKEN.";
  }
  if (msg.includes("operator already on a call")) {
    return "Você já está em outra chamada. Encerre-a antes de iniciar uma nova.";
  }
  if (msg.includes("not paired")) {
    return "O número de chamada de voz ainda não foi pareado. Configure em Configurações › Canais.";
  }
  // O upstream escreve `no session <id>` (`Manager.Get` falhando); a versão
  // anterior só procurava "no such session", que ele nunca emite.
  if (code === "not_found" || msg.includes("no such session") || /\bno session\b/.test(msg)) {
    return "Sessão de chamada de voz não encontrada.";
  }
  return "Não foi possível completar a chamada. Tente novamente em instantes.";
}
