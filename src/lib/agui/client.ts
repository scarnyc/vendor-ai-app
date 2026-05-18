import { AgUiEventSchema, type AgUiEvent } from '@/lib/agent/events';

/**
 * Hand-rolled SSE reader over `fetch` + `ReadableStream`. EventSource is
 * GET-only; we POST request bodies, so we re-implement the framing here.
 * Frame format: `event: <type>\ndata: <json>\n\n`. The JSON body carries
 * the type discriminant and is the single source of truth — `event:` is
 * ignored. `onMalformed` is required so parse failures cannot silently
 * strand the reducer waiting on events that will never arrive.
 */
export interface StreamOptions {
  signal: AbortSignal;
  onMalformed: (raw: string, error: unknown) => void;
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
            options.onMalformed(json, err);
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
