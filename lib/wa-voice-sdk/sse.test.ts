// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseSse, parseWaVoiceEvent } from "./sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const message of parseSse(stream)) out.push(message);
  return out;
}

describe("parseSse", () => {
  it("lê eventos separados por linha em branco, inclusive partidos entre chunks", async () => {
    const messages = await collect(
      streamOf([
        'data: {"type":"auth-state","paired":true}\n\n',
        'data: {"type":"call-status",',
        '"status":"ringing"}\n\n',
      ]),
    );

    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[0]?.data ?? "")).toMatchObject({ type: "auth-state", paired: true });
    expect(JSON.parse(messages[1]?.data ?? "")).toMatchObject({ type: "call-status", status: "ringing" });
  });

  it("ignora comentários de keepalive e aceita CRLF", async () => {
    const messages = await collect(streamOf([": ping\r\n\r\n", 'data: {"type":"call-ended"}\r\n\r\n']));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('{"type":"call-ended"}');
  });

  it("junta múltiplas linhas data do mesmo evento", async () => {
    const messages = await collect(streamOf(['data: {"type":"call-list",\ndata: "calls":[]}\n\n']));

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]?.data ?? "")).toEqual({ type: "call-list", calls: [] });
  });

  it("não perde o último evento quando o stream fecha sem linha em branco", async () => {
    const messages = await collect(streamOf(['data: {"type":"incoming"}']));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('{"type":"incoming"}');
  });

  it("respeita event/id", async () => {
    const messages = await collect(streamOf(["id: 42\nevent: custom\ndata: {}\n\n"]));

    expect(messages[0]).toMatchObject({ id: "42", event: "custom", data: "{}" });
  });
});

describe("parseWaVoiceEvent", () => {
  it("devolve o evento tipado", () => {
    expect(parseWaVoiceEvent('{"type":"incoming","id":"c1","peer":"5511"}')).toMatchObject({
      type: "incoming",
      id: "c1",
      peer: "5511",
    });
  });

  it("recusa JSON inválido", () => {
    expect(() => parseWaVoiceEvent("não é json")).toThrow(/bad_response/);
  });

  it("recusa objeto sem type", () => {
    expect(() => parseWaVoiceEvent('{"id":"c1"}')).toThrow(/bad_response/);
  });
});
