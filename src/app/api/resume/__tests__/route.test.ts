import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { streamRun } from '@/lib/agent/stream';

/**
 * Tests for POST /api/resume — the operator-decision SSE endpoint. Validation
 * failures (bad body, unknown case_id) stream a single RUN_ERROR frame
 * instead of returning JSON, so the client's event-stream contract holds on
 * every code path. These tests assert:
 *
 *   1. Happy path resume of a paused case emits RUN_RESUMED first and
 *      RUN_FINISHED last, with text/event-stream content-type.
 *   2. Malformed JSON body returns a one-shot SSE with a RUN_ERROR frame
 *      (NOT a 400 JSON response).
 *   3. Unknown case_id returns the same one-shot SSE shape with code
 *      'unknown_case'.
 *   4. Every error path keeps the Content-Type header at
 *      `text/event-stream; charset=utf-8` — the reducer would break on JSON.
 */

async function bodyToText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function expectSseHeaders(res: Response) {
  expect(res.headers.get('content-type')).toBe(
    'text/event-stream; charset=utf-8'
  );
  expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
}

function parseSseFrames(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: ')) ?? '';
      const dataLine = lines.find((l) => l.startsWith('data: ')) ?? '';
      return {
        event: eventLine.slice('event: '.length),
        data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null,
      };
    });
}

async function drainRun(caseId: string): Promise<void> {
  for await (const _ of streamRun(caseId, { kind: 'run' })) {
    void _;
  }
}

describe('POST /api/resume', () => {
  it('happy path: paused case + valid decision → RUN_RESUMED…RUN_FINISHED', async () => {
    const caseId = 'case_001';
    await drainRun(caseId);

    const req = new NextRequest('http://localhost/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        case_id: caseId,
        decision: {
          verdict: 'approved',
          notes: null,
          decided_at: new Date().toISOString(),
          decided_by: 'priya',
          edits_applied: null,
        },
      }),
    });
    const res = await POST(req);

    expectSseHeaders(res);
    const text = await bodyToText(res);
    const frames = parseSseFrames(text);

    expect(frames[0].event).toBe('RUN_RESUMED');
    expect(frames[frames.length - 1].event).toBe('RUN_FINISHED');
  });

  it('malformed JSON body → one-shot SSE with RUN_ERROR (invalid_request)', async () => {
    const req = new NextRequest('http://localhost/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    });
    const res = await POST(req);

    expectSseHeaders(res);
    const text = await bodyToText(res);
    const frames = parseSseFrames(text);

    expect(frames.length).toBe(1);
    expect(frames[0].event).toBe('RUN_ERROR');
    const data = frames[0].data as { code: string; recoverable: boolean };
    expect(data.code).toBe('invalid_request');
    expect(data.recoverable).toBe(false);
  });

  it('valid JSON but invalid schema → one-shot SSE with RUN_ERROR', async () => {
    const req = new NextRequest('http://localhost/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ case_id: 'case_001' /* missing decision */ }),
    });
    const res = await POST(req);

    expectSseHeaders(res);
    const text = await bodyToText(res);
    const frames = parseSseFrames(text);

    expect(frames[0].event).toBe('RUN_ERROR');
    expect((frames[0].data as { code: string }).code).toBe('invalid_request');
  });

  it('unknown case_id → one-shot SSE with RUN_ERROR (unknown_case)', async () => {
    const req = new NextRequest('http://localhost/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        case_id: 'case_999',
        decision: {
          verdict: 'approved',
          notes: null,
          decided_at: new Date().toISOString(),
          decided_by: 'priya',
          edits_applied: null,
        },
      }),
    });
    const res = await POST(req);

    expectSseHeaders(res);
    const text = await bodyToText(res);
    const frames = parseSseFrames(text);

    expect(frames.length).toBe(1);
    expect(frames[0].event).toBe('RUN_ERROR');
    const data = frames[0].data as { code: string; message: string };
    expect(data.code).toBe('unknown_case');
    expect(data.message).toMatch(/case_999/);
  });
});
