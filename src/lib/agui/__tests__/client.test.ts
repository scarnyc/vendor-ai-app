import { describe, it, expect, vi } from 'vitest';
import { streamAgUiEvents } from '../client';
import { events, encodeSse, type AgUiEvent } from '@/lib/agent/events';

/**
 * Round-trip tests for the SSE encoder/decoder pair. The server `encodeSse`
 * and the client `streamAgUiEvents` are the two halves of a single wire
 * contract — these tests pin the contract in isolation (no fetch, no graph,
 * no React) so any drift between emit and parse surfaces here first.
 *
 * Each test stubs `fetch` with a `ReadableStream` containing pre-encoded
 * frames, drains the async generator, and asserts the yielded events match
 * what was sent.
 */

function makeFetchStub(body: string): typeof fetch {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

function makeChunkedFetchStub(chunks: string[]): typeof fetch {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

async function drainWith(
  fetchImpl: typeof fetch,
  onMalformed: (raw: string, err: unknown) => void = () => {}
): Promise<AgUiEvent[]> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const collected: AgUiEvent[] = [];
    const controller = new AbortController();
    for await (const event of streamAgUiEvents('/x', { method: 'POST' }, {
      signal: controller.signal,
      onMalformed,
    })) {
      collected.push(event);
    }
    return collected;
  } finally {
    globalThis.fetch = original;
  }
}

describe('SSE round-trip — encodeSse ↔ streamAgUiEvents', () => {
  it('a single encoded frame decodes back to the original event', async () => {
    const original = events.runStarted({
      case_id: 'case_001',
      thread_id: 'case_001',
      provider: 'mock',
    });
    const wire = encodeSse(original);
    const decoded = await drainWith(makeFetchStub(wire));
    expect(decoded).toEqual([original]);
  });

  it('multiple frames in one chunk decode in order', async () => {
    const frames = [
      events.runStarted({ case_id: 'c', thread_id: 'c', provider: 'mock' }),
      events.toolCallStart({ tool_name: 'lookup_budget', args: {} }),
      events.runPausedAwaitingHuman(),
    ];
    const wire = frames.map(encodeSse).join('');
    const decoded = await drainWith(makeFetchStub(wire));
    expect(decoded).toEqual(frames);
  });

  it('frames split across chunk boundaries reassemble correctly', async () => {
    const frame = encodeSse(
      events.runStarted({ case_id: 'c', thread_id: 'c', provider: 'mock' })
    );
    // Cut the frame mid-JSON to verify the buffer reassembles partial chunks.
    const midpoint = Math.floor(frame.length / 2);
    const decoded = await drainWith(
      makeChunkedFetchStub([frame.slice(0, midpoint), frame.slice(midpoint)])
    );
    expect(decoded).toHaveLength(1);
    expect(decoded[0].type).toBe('RUN_STARTED');
  });

  it('malformed JSON triggers onMalformed and the stream continues', async () => {
    const valid = encodeSse(events.runPausedAwaitingHuman());
    const malformed = `event: RUN_STARTED\ndata: {not-json}\n\n`;
    const wire = malformed + valid;
    const onMalformed = vi.fn();
    const decoded = await drainWith(makeFetchStub(wire), onMalformed);

    expect(onMalformed).toHaveBeenCalledTimes(1);
    expect(decoded).toEqual([events.runPausedAwaitingHuman()]);
  });

  it('valid JSON with the wrong shape goes to onMalformed (Zod-rejected)', async () => {
    const wire = `event: RUN_STARTED\ndata: ${JSON.stringify({
      type: 'RUN_STARTED',
      // Missing required case_id/thread_id/provider.
    })}\n\n`;
    const onMalformed = vi.fn();
    const decoded = await drainWith(makeFetchStub(wire), onMalformed);

    expect(onMalformed).toHaveBeenCalledTimes(1);
    expect(decoded).toEqual([]);
  });

  it('AbortSignal is plumbed through to fetch', async () => {
    const original = globalThis.fetch;
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      if (observedSignal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    try {
      const controller = new AbortController();
      controller.abort();
      const iterator = streamAgUiEvents('/x', { method: 'POST' }, {
        signal: controller.signal,
        onMalformed: () => {},
      });
      await expect(iterator.next()).rejects.toThrow(/abort/i);
      expect(observedSignal).toBe(controller.signal);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('non-OK HTTP response throws before iterating', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    try {
      const controller = new AbortController();
      const iterator = streamAgUiEvents('/x', { method: 'POST' }, {
        signal: controller.signal,
        onMalformed: () => {},
      });
      await expect(iterator.next()).rejects.toThrow(/HTTP 500/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
