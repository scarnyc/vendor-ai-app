import { AgUiEventSchema, type AgUiEvent } from '@/lib/agent/events';

/**
 * Hand-rolled SSE reader over `fetch` + `ReadableStream` — NOT `EventSource`.
 *
 * Why not EventSource: it's GET-only and we POST to `/api/run/[case]` (and
 * `/api/resume`) with request bodies. fetch + ReadableStream lets us keep
 * one transport for both routes.
 *
 * Frame format expected from the server: `event: <type>\ndata: <json>\n\n`.
 * The `event:` field is ignored on parse — the JSON body has the same `type`
 * discriminant the client Zod-validates, so it's the single source of truth.
 * (This keeps us robust to byte-order surprises and lets the same parser
 * accept the slimmer `data: <json>\n\n` frames a future change might emit.)
 *
 * Schema discipline: every frame is Zod-parsed against `AgUiEventSchema`
 * before being yielded. Malformed frames are reported to the caller through
 * `onMalformed` (default: swallow) so a stray newline can't poison the
 * reducer. The caller's `signal` aborts the underlying fetch and the loop.
 */
export interface StreamOptions {
  signal: AbortSignal;
  onMalformed?: (raw: string, error: unknown) => void;
}

export async function* streamAgUiEvents(
  url: string,
  init: RequestInit,
  options: StreamOptions
): AsyncGenerator<AgUiEvent, void, void> {
  const response = await fetch(url, { ...init, signal: options.signal });

  if (!response.ok || !response.body) {
    throw new Error(`SSE request failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames terminate with a blank line (two consecutive LFs).
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataLine = rawFrame
          .split('\n')
          .find((line) => line.startsWith('data:'));
        if (dataLine) {
          const json = dataLine.slice('data:'.length).trim();
          try {
            const parsed = AgUiEventSchema.parse(JSON.parse(json));
            yield parsed;
          } catch (err) {
            options.onMalformed?.(json, err);
          }
        }

        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the stream was already cancelled; safe to ignore.
    }
  }
}
