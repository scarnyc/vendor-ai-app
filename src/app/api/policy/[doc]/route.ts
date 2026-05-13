import { NextRequest, NextResponse } from 'next/server';
import { POLICY_DOCS, PolicyDocSchema } from '@/lib/agent/schemas';
import { readPolicy } from '@/lib/agent/policies';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ doc: string }> }
) {
  const { doc } = await params;
  const parsed = PolicyDocSchema.safeParse(doc);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Unknown policy doc. Allowed: ${POLICY_DOCS.join(', ')}` },
      { status: 400 }
    );
  }
  const text = await readPolicy(parsed.data);
  return NextResponse.json({ doc: parsed.data, text });
}
