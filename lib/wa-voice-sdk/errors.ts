/**
 * Erros tipados do SDK.
 *
 * O `message` preserva o formato histórico `wacalls_<status>: <corpo>` porque
 * `lib/wacalls/client.ts` (e os testes de mensagem amigável) já dependem dele.
 * O que muda é que agora existe `code`/`status`/`retryable` para o chamador
 * decidir sem fazer regex em texto.
 */

export type WaVoiceErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "upstream"
  | "network"
  | "timeout"
  | "aborted"
  | "bad_response";

export interface WaVoiceErrorOptions {
  code: WaVoiceErrorCode;
  status?: number;
  retryable?: boolean;
  body?: string;
  cause?: unknown;
}

export class WaVoiceError extends Error {
  readonly code: WaVoiceErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly body?: string;
  readonly cause?: unknown;

  constructor(message: string, opts: WaVoiceErrorOptions) {
    super(message);
    this.name = "WaVoiceError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? RETRYABLE.has(opts.code);
    this.body = opts.body;
    this.cause = opts.cause;
  }

  static fromResponse(status: number, body: string): WaVoiceError {
    return new WaVoiceError(`wacalls_${status}: ${body.slice(0, 200)}`, {
      code: codeForStatus(status),
      status,
      // O corpo inteiro fica disponível para diagnóstico, mas com teto: um
      // proxy devolvendo HTML gigante não deve virar memória retida no erro.
      body: body.slice(0, 4096),
      retryable: RETRYABLE.has(codeForStatus(status)),
    });
  }

  static network(cause: unknown): WaVoiceError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new WaVoiceError(`wacalls_network: ${detail.slice(0, 200)}`, {
      code: "network",
      retryable: true,
      cause,
    });
  }

  static timeout(timeoutMs: number): WaVoiceError {
    return new WaVoiceError(`wacalls_timeout: ${timeoutMs}ms`, {
      code: "timeout",
      retryable: true,
    });
  }

  static aborted(cause?: unknown): WaVoiceError {
    return new WaVoiceError("wacalls_aborted", { code: "aborted", cause });
  }

  static badResponse(detail: string): WaVoiceError {
    return new WaVoiceError(`wacalls_bad_response: ${detail.slice(0, 200)}`, {
      code: "bad_response",
    });
  }
}

const RETRYABLE: ReadonlySet<WaVoiceErrorCode> = new Set([
  "rate_limited",
  "upstream",
  "network",
  "timeout",
]);

function codeForStatus(status: number): WaVoiceErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "upstream" : "bad_request";
  }
}

/** Normaliza qualquer coisa lançada para `WaVoiceError`. */
export function toWaVoiceError(err: unknown): WaVoiceError {
  if (err instanceof WaVoiceError) return err;
  return WaVoiceError.network(err);
}
