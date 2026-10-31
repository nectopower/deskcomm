/**
 * Parser SSE mínimo e sem dependências.
 *
 * O upstream manda um `data: <json>` por linha e usa o keepalive padrão
 * (`: ping`). O parser aceita o formato completo (event/id/retry) para não
 * precisar mudar quando o servidor evoluir.
 */

import { WaVoiceError } from "./errors";
import type { SseMessage, WaVoiceEvent } from "./types";

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;

  const flush = (): SseMessage | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const message: SseMessage = { data: dataLines.join("\n") };
    if (eventName) message.event = eventName;
    if (lastId) message.id = lastId;
    dataLines = [];
    eventName = undefined;
    return message;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

        if (line === "") {
          const message = flush();
          if (message) yield message;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          switch (field) {
            case "data":
              dataLines.push(value);
              break;
            case "event":
              eventName = value;
              break;
            case "id":
              lastId = value;
              break;
            default:
              break;
          }
        }
        newline = buffer.indexOf("\n");
      }
    }

    // Stream fechou sem a linha em branco final: não perder o último evento.
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        dataLines.push(value);
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // leitor já liberado/cancelado — não há o que restaurar
    }
  }
}

/** Decodifica o payload JSON de um evento do WaCalls. */
export function parseWaVoiceEvent(data: string): WaVoiceEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw WaVoiceError.badResponse(`evento não é JSON: ${data.slice(0, 80)}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
    throw WaVoiceError.badResponse(`evento sem "type": ${data.slice(0, 80)}`);
  }
  return parsed as WaVoiceEvent;
}
