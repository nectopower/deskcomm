# `wa-voice-sdk` — SDK de chamadas de voz do Deskcomm

> **Status:** fase 1 (proposta implementada). Empacota o contrato do motor atual
> ([WaCalls](https://github.com/JotaDev66/WaCalls)) sem acoplar ao Next.js.
> As fases 2/3 trocam a implementação por trás mantendo esta superfície.

## O que é (e o que não é)

É a **fachada tipada** para o serviço de voz: sessões, chamadas, SDP e stream de
eventos. Não é o motor de mídia e **não é o WASM do WhatsApp Web** — aquele
artefato é o cliente oficial, preso à sessão Signal do dispositivo e ao runtime
privado, e não serve como biblioteca.

```
Browser → /api/v1/voice/* (app: auth + org + número discável) → este SDK → motor
                                                                  (WaCalls hoje)
```

O browser **nunca** importa este pacote: ele contém o Bearer server-to-server.

## Uso

```ts
import { WaVoiceClient, WaVoiceError } from "@/lib/wa-voice-sdk";

const voice = new WaVoiceClient({
  baseUrl: process.env.WACALLS_API_BASE_URL!,
  token: process.env.WACALLS_API_TOKEN!,
  clientId: "deskcomm-worker", // X-Client-Id do SSE
});

// pareamento: cria a conta e JÁ inicia o QR (não existe /pair no fluxo)
const { id } = await voice.sessions.create(`org_${orgId}`);

// discar (phone já resolvido; record nunca é enviado)
const call = await voice.calls.start({ sessionId: id, clientId: userId, phone });

// atender + SDP (a mídia não passa pelo SDK)
await voice.calls.accept({ sessionId: id, callId: call.callId, clientId: userId });
const { sdpAnswer } = await voice.calls.exchangeWebrtc({ sessionId: id, callId: call.callId, sdpOffer });

// eventos tipados
const stop = voice.events.subscribe(
  (event) => {
    if (event.type === "call-ended") console.log(event.id, event.reason);
  },
  { onError: (err) => console.error(err.code, err.message) },
);
// ...
stop();
```

### Compatibilidade

`lib/wacalls/client.ts` continua existindo como adaptador: `WacallsClient`,
`getWacallsClient`, `wacallsFriendlyError` e `wacallsSemConexao` têm a mesma
assinatura e o mesmo formato de erro (`wacalls_<status>: <corpo>`). Nenhuma rota
ou worker precisa mudar nesta fase.

## Superfície

| Membro | Upstream | Observação |
|---|---|---|
| `sessions.list()` | `GET /api/sessions` | devolve `[]` se o envelope vier vazio |
| `sessions.create(name)` | `POST /api/sessions` | já inicia o pareamento |
| `sessions.logout(id)` | `POST /api/sessions/{id}/logout` | desvincula o aparelho |
| `sessions.remove(id)` | `DELETE /api/sessions/{id}` | remover ≠ desvincular |
| `calls.start({sessionId, clientId, phone})` | `POST .../calls` | `X-Client-Id` = dono |
| `calls.accept(...)` | `POST .../accept` | |
| `calls.reject(...)` | `POST .../reject` | |
| `calls.end(...)` | `DELETE .../calls/{id}` | |
| `calls.exchangeWebrtc(...)` | `POST .../webrtc` | relay puro de SDP |
| `calls.history({sessionId, limit, cursor})` | `GET .../history` | keyset `{calls, nextCursor}` |
| `events.stream(opts)` | `GET /api/events` | `AsyncGenerator<WaVoiceEvent>` |
| `events.subscribe(fn, opts)` | idem | reconexão com backoff; devolve `stop()` |
| `capabilities()` | — | áudio sim; vídeo/grupo/SFrame não (ainda) |

## Erros

`WaVoiceError` carrega `code`, `status?`, `retryable` e `body?`. O `message`
preserva o formato histórico para não quebrar os chamadores.

| `code` | Quando | Retentável |
|---|---|---|
| `unauthorized` / `forbidden` | 401/403 — token errado | não |
| `not_found` | 404 — sessão/chamada sumiu | não |
| `conflict` | 409 — operador já em chamada | não |
| `unprocessable` | 422 — payload recusado | não |
| `rate_limited` | 429 | sim |
| `upstream` | 5xx | sim |
| `network` / `timeout` | falha de transporte | sim |
| `bad_response` | corpo não-JSON / contrato quebrado | não |
| `aborted` | `AbortSignal` do chamador | não |

## Invariantes de segurança

1. **Bearer em toda chamada** — o upstream não tem modo aberto; sem token, 401.
2. **API só na rede interna** — o SDK não publica porta; o compose já vigia isso.
3. **Telefone nunca vem do browser** — a rota resolve pelo contato + WAHA.
4. **`record` jamais é enviado** — gravação está fora de escopo (spec 18 §1.2).
5. **`clientId` é o `auth.users.id`** — nunca um valor escolhido pelo frontend.
6. **Browser não importa o pacote** — só as rotas server-side.

## Roadmap

| Fase | Entrega | Motor |
|---|---|---|
| **1 (esta)** | SDK tipado + adaptador + testes; rota atual intacta | WaCalls |
| **2** | Rota oficial Meta Calling API (Cloud API + SIP/WebRTC, Opus) no `voice-agent`/Asterisk | Meta |
| **3** | Motor próprio: SFrame E2E, SRTCP por direção, relay por RTT, grupo/WARP, vídeo/WebCodecs, NetEq/BWE | próprio |

A fase 3 usa como spec o relatório de engenharia reversa do WASM
(`analysis/RELATORIO-WASM.md`, no repositório de análise): labels HKDF, SFrame,
NetEq, máquina de estados e eleição de relay.

## Testes

```bash
pnpm vitest run lib/wa-voice-sdk lib/wacalls
```

Cobrem: URL/headers/corpo, unwrap de envelopes, query keyset, 204, mapeamento de
erro (401/5xx/rede/JSON inválido), capacidades e parser SSE (chunks partidos,
CRLF, keepalive, múltiplas linhas `data`, evento final sem linha em branco).
