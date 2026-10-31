# Proposta — SDK de voz em três fases

**Status:** fase 1 implementada (`lib/wa-voice-sdk/`). Fases 2 e 3 planejadas.
**Relacionados:** `docs/specs/18-spec-voice-calls-wacalls.md`, `lib/wacalls/`,
`docker-compose.prod.yml` (profiles `voz` e `telefonia`).

## Contexto

O Deskcomm já faz chamada de voz 1:1 pelo WhatsApp via WaCalls (sessão
`whatsmeow` própria, MLow + SRTP + relay). O que faltava era um **contrato
estável** — hoje as rotas e o worker falam direto com o cliente REST.

A ordem abaixo é deliberada: primeiro empacotar o que já funciona, depois a rota
oficial (sem risco de ban), e só então o motor próprio. O motor próprio é o de
maior custo e maior risco; ele não deve bloquear os outros dois.

---

## Fase 1 — Empacotar o motor atual (feito)

**Entrega:** `lib/wa-voice-sdk/`

- `WaVoiceClient` com `sessions`, `calls`, `events` e `capabilities()`;
- transporte com timeout, `AbortSignal`, `fetch` injetável e erro tipado
  (`WaVoiceError.code/status/retryable`);
- parser SSE reutilizável (o worker passou a usá-lo);
- adaptador `lib/wacalls/client.ts` intacto para as rotas existentes;
- testes de contrato (URL/headers/corpo, envelopes, 204, erros, SSE).

**Critérios de aceite**

- [x] `pnpm vitest run lib/wa-voice-sdk lib/wacalls` verde;
- [x] `tsc` e `eslint` limpos nos arquivos novos;
- [x] nenhuma rota ou worker precisou mudar de assinatura;
- [x] browser não importa o pacote (Bearer só no servidor).

**Fora de escopo:** mudar o motor, grupo, vídeo, SFrame.

---

## Fase 2 — Rota oficial (Meta Calling API)

**Quando:** se o número for Cloud API e o volume justificar. Elimina o segundo
aparelho vinculado e o risco de ban.

**Arquitetura**

```
WhatsApp user ⇄ Meta Calling API (WebRTC/SIP, Opus)
                    │ webhooks `calls` (HTTPS)
                    ▼
              app / worker  ──►  Asterisk (profile `telefonia`)
                    │                 │ ARI
                    ▼                 ▼
              voice_calls        voice-agent (IA em tempo real)
```

**Entregas**

1. Configuração do número: habilitar calling, webhook `calls`, permissões
   (`whatsapp_business_messaging`), limite de mensagens ≥ 2.000.
2. Rota de webhook idempotente (`calls` → `voice_calls`, `provider='meta_cloud'`).
3. SIP/WebRTC: apontar a Calling API para o Asterisk (`pjsip.conf`), reaproveitar
   `voice-agent`/ARI.
4. `capabilities()` passa a refletir o provedor ativo.
5. Testes: chamada inbound/outbound em número de teste; gravação continua off.

**Limites conhecidos**

- business-initiated indisponível em US/CA/EG/VN/NG;
- permissão de chamada por usuário (1/dia; 100/dia desde dez/2025);
- 4 chamadas não atendidas consecutivas revogam a permissão;
- áudio Opus (PCMA/PCMU desde mar/2026).

**Critérios de aceite**

- chamada real inbound e outbound com áudio bidirecional;
- `end_reason`/`duration_ms` corretos em `voice_calls`;
- nenhum segredo da Meta no browser.

---

## Fase 3 — Motor próprio

**Quando:** fases 1 e 2 estáveis, com demanda por grupo/vídeo/privacidade.

**Base:** relatório de engenharia reversa do WASM
(`analysis/RELATORIO-WASM.md`), que documenta:

- labels HKDF (`hbh srtp key/salt`, `uplink/downlink hbh srtcp key`,
  `warp auth key/salt`, `e2e sframe key`, `WhatsApp Call Transfer Key`);
- SFrame E2E (32 bytes = 16 key + 16 salt) e SFrame do DataChannel;
- máquina de estados e mensagens de sinalização;
- eleição de relay por RTT (`xpop`);
- NetEq (delay/PLC) e BWE (TFRM/PP + ExecuTorch/XNNPACK);
- caminho de vídeo/WebCodecs.

**Entregas por ordem**

1. SFrame E2E + SRTCP por direção (paridade de privacidade).
2. Relay por RTT + reconexão/transferência (`ReKey`, call transfer).
3. Grupo/SFU (WARP) e assinatura por participante.
4. Vídeo (H.264/AV1 + WebCodecs) e simulcast.
5. Qualidade: jitter buffer com min/max delay, PLC, BWE.

**Critérios de aceite**

- chamada 1:1 com SFrame verificável ponta a ponta;
- grupo com 3+ participantes e áudio estável;
- vídeo em pelo menos um codecpor navegador suportado;
- regressão zero nas fases 1/2 (mesma superfície do SDK).

**Riscos**

- protocolo mudo entre versões → pin de versão + testes de fumaça;
- custo de manutenção alto → só começar com demanda provada;
- compliance → revisar ToS antes de qualquer distribuição.

---

## Decisão

| Fase | Esforço | Risco | Retorno |
|---|---|---|---|
| 1 | baixo | baixo | contrato estável; rotas intactas |
| 2 | médio | baixo (oficial) | sem ban; SLA; Asterisk já existe |
| 3 | alto | alto | grupo, vídeo, SFrame, independência |

Sequência aprovada: **1 → 2 → 3**.
