import { NextResponse } from 'next/server';
import { z } from 'zod';

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await req.json().catch(() => ({}));
  return schema.parse(body);
}

/** Demo auth: actor agent id from `x-agent-id` header or `agentId` body field. */
export function actorFrom(req: Request, bodyAgentId?: string | null): string {
  const h = req.headers.get('x-agent-id');
  const id = h ?? bodyAgentId ?? null;
  if (!id) throw new Error('missing actor agent id (send x-agent-id header)');
  return id;
}
