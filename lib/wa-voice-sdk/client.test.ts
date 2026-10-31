import { beforeEach, describe, expect, it, vi } from "vitest";

import { CallsApi, START_CALL_TIMEOUT_MS } from "./client";
import { WaVoiceClient, WaVoiceError } from "./index";
import type { HttpTransport } from "./transport";

const baseUrl = "http://wa-voice-test:8080";
const token = "token-de-teste";

/** Response mínimo: o SDK aceita `json` ou `text`, como um Response real. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("WaVoiceClient", () => {
  let client: WaVoiceClient;

  beforeEach(() => {
    client = new WaVoiceClient({ baseUrl, token, clientId: "teste" });
    vi.restoreAllMocks();
  });

  it("lista sessões e envia Bearer em toda chamada", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessions: [{ id: "s1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await client.sessions.list();

    expect(sessions).toEqual([{ id: "s1" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/api/sessions`);
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    expect(init.cache).toBe("no-store");
  });

  it("cria sessão com POST /api/sessions e corpo {name}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "sess_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.sessions.create("org_1")).resolves.toEqual({ id: "sess_1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/api/sessions`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "org_1" });
  });

  it("inicia chamada com X-Client-Id e sem record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ call: { callId: "call_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const call = await client.calls.start({ sessionId: "s1", clientId: "user_1", phone: "+5511999998888" });

    expect(call).toEqual({ callId: "call_1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/api/sessions/s1/calls`);
    expect(init.headers).toMatchObject({ "X-Client-Id": "user_1" });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ phone: "+5511999998888" });
    expect(body.record).toBeUndefined();
  });

  it("o discado não usa o timeout padrão de 15s do transporte", async () => {
    // Regressão medida contra a imagem pinada: o StartCall do WaCalls levou
    // 15,6s e a rota respondia 502 com o celular já tocando. O padrão de 15s
    // não cabe nesse endpoint; as outras operações continuam nele.
    const request = vi.fn().mockResolvedValue({ call: { callId: "call_1" } });
    const calls = new CallsApi({ request } as unknown as HttpTransport);

    await calls.start({ sessionId: "s1", clientId: "user_1", phone: "+5511999998888" });

    const opts = request.mock.calls[0][2] as { timeoutMs?: number };
    expect(opts.timeoutMs).toBe(START_CALL_TIMEOUT_MS);
    expect(START_CALL_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it("histórico monta query keyset e normaliza a resposta", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ calls: [{ callId: "c1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await client.calls.history({ sessionId: "s1", limit: 10, cursor: "abc" });

    expect(page).toEqual({ calls: [{ callId: "c1" }], nextCursor: null });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${baseUrl}/api/sessions/s1/history?limit=10&cursor=abc`);
  });

  it("troca SDP e traduz sdp_answer para sdpAnswer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sdp_answer: "v=0" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.calls.exchangeWebrtc({ sessionId: "s1", callId: "c1", sdpOffer: "v=0 offer" }),
    ).resolves.toEqual({ sdpAnswer: "v=0" });
  });

  it("204 vira undefined em end", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.calls.end({ sessionId: "s1", callId: "c1" })).resolves.toBeUndefined();
  });

  it("401 vira erro tipado, não retentável, mantendo o formato wacalls_<status>", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, '{"error":"unauthorized"}'));
    vi.stubGlobal("fetch", fetchMock);

    const err = await client.sessions.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaVoiceError);
    const typed = err as WaVoiceError;
    expect(typed.code).toBe("unauthorized");
    expect(typed.status).toBe(401);
    expect(typed.retryable).toBe(false);
    expect(typed.message).toBe('wacalls_401: {"error":"unauthorized"}');
  });

  it("5xx vira upstream retentável", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(503, "not paired"));
    vi.stubGlobal("fetch", fetchMock);

    const err = (await client.sessions.list().catch((e: unknown) => e)) as WaVoiceError;
    expect(err.code).toBe("upstream");
    expect(err.retryable).toBe(true);
  });

  it("JSON inválido vira bad_response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>proxy error</html>",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const err = (await client.sessions.list().catch((e: unknown) => e)) as WaVoiceError;
    expect(err.code).toBe("bad_response");
  });

  it("falha de rede vira network retentável", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const err = (await client.sessions.list().catch((e: unknown) => e)) as WaVoiceError;
    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("capacidades não prometem o que o motor atual não faz", () => {
    expect(client.capabilities()).toEqual({
      audio: true,
      video: false,
      group: false,
      sframe: false,
      recording: false,
    });
  });
});
