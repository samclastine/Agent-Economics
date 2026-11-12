import { ok, fail, parseBody } from '@/lib/api';
import { buildAgent } from '@/lib/agents/factory';
import { getDb } from '@/lib/db/client';
import { agentRuns } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { acquireRun, releaseRun, abortError } from '@/lib/run-control';
import { emitEvent } from '@/lib/events';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { governorStatus } from '@/lib/a423/governor';
import { getA423Bridge } from '@/lib/a423/bridge04';
import { detectOutputLoop, nextLoopCheckLength } from '@/lib/agents/loop-breaker';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Schema = z.object({
  message: z.string().min(1),
  clientId: z.string().optional(),
  session: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional(),
  newSession: z.boolean().optional(),
});

/** Extract plain text from a streamed message chunk (string or content-part array). */
function chunkText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? ''))
      .join('');
  }
  return '';
}

/** Message role/type across LangChain message classes and plain objects. */
function messageKind(msg: unknown): string {
  const m = msg as { _getType?: () => string; type?: string; role?: string } | undefined;
  if (!m) return '';
  if (typeof m._getType === 'function') return m._getType();
  return m.type ?? m.role ?? '';
}

const isAssistant = (msg: unknown) => {
  const kind = messageKind(msg);
  return kind === 'ai' || kind === 'assistant';
};

export async function POST(req: Request, ctx: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await ctx.params;
  if (process.env.A423_CHAT_MODE === 'sdk') {
    try {
      const bridge = await getA423Bridge();
      const bearer = req.headers.get('authorization');
      const credential = bearer ? bearer.replace(/^Bearer\s+/i, '') : await bridge.credentialFor(agentId);
      const payload = await bridge.authority.verifyCredential(credential);
      if (payload.sub !== agentId) return fail('agent session is not authenticated', 403);
    } catch {
      return fail('A423 identity session unavailable', 503);
    }
  }
  if (process.env.A423_REQUIRE_VERIFIED_AGENTS !== 'false') {
    let status;
    try {
      status = await governorStatus(agentId);
    } catch {
      return fail('identity governor is unavailable', 503);
    }
    if (!status.verified) return fail('agent is not verified by the governor', 403);
  }
  const body = await parseBody(req, Schema);
  // Checkpoint threads: the default `agent:{id}:chat` thread is the persistent
  // main session; `session` selects a named session thread and `newSession`
  // mints a fresh one — each gets independent checkpoints in the saver.
  const baseThread = `agent:${agentId}:chat`;
  const threadId = body.newSession
    ? `${baseThread}:${randomUUID()}`
    : body.session
      ? `${baseThread}:${body.session}`
      : baseThread;
  const runKey = `chat:${agentId}`;
  const { signal, controller } = acquireRun(runKey); // aborts any previous chat for this agent
  const db = getDb();
  let runId: string | null = null;
  // Totals survive the streaming buffers so the final event (and the HTTP
  // response fallback) can rebuild thinking/speaking blocks after a reload.
  let fullReasoning = '';
  let fullSpeech = '';
  try {
    // agent_runs.thread_id is UNIQUE — keep the checkpoint thread stable but
    // give each run row its own id.
    const [run] = await db.insert(agentRuns).values({ agentId, threadId: `${threadId}:${randomUUID()}`, status: 'RUNNING' }).returning();
    runId = run.id;
    await emitEvent({
      type: 'chat.user', agentId, runId: run.id,
      payload: { message: body.message, clientId: body.clientId ?? null, thread: threadId },
    });
    const agent = await buildAgent(agentId);
    if (body.newSession) {
      await emitEvent({ type: 'chat.session', agentId, runId: run.id, payload: { threadId } });
    }

    // Stream LLM tokens. 'messages' mode yields [messageChunk, metadata] tuples;
    // we forward text deltas as ephemeral chat.delta events (batched ~60ms, no
    // DB writes). Only assistant chunks are speech: tool results also arrive in
    // this stream and must not be rendered as the agent's own words.
    const stream = await agent.stream(
      { messages: [{ role: 'user', content: body.message }] },
      { configurable: { thread_id: threadId }, streamMode: 'messages' as never },
    );

    let deltaBuf = '';
    let reasonBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDeltas = () => {
      if (reasonBuf) {
        const text = reasonBuf;
        reasonBuf = '';
        void emitEvent({
          type: 'chat.reasoning', agentId, runId: run.id, ephemeral: true,
          payload: { text, clientId: body.clientId ?? null, thread: threadId },
        });
      }
      if (!deltaBuf) return;
      const text = deltaBuf;
      deltaBuf = '';
      void emitEvent({
        type: 'chat.delta', agentId, runId: run.id, ephemeral: true,
        payload: { text, clientId: body.clientId ?? null, thread: threadId },
      });
    };
    const scheduleFlush = () => {
      if (!flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; flushDeltas(); }, 60);
      }
    };
    let nextSpeechLoopCheck = 0;
    let nextReasonLoopCheck = 0;
    const checkLoop = (text: string, stream: 'speech' | 'reasoning') => {
      const next = stream === 'speech' ? nextSpeechLoopCheck : nextReasonLoopCheck;
      if (text.length < next) return;
      if (stream === 'speech') nextSpeechLoopCheck = nextLoopCheckLength(text.length);
      else nextReasonLoopCheck = nextLoopCheckLength(text.length);
      const loop = detectOutputLoop(text);
      if (!loop) return;
      const err = new Error(
        `agent output loop detected in ${stream} (${loop.count} repeated ${loop.kind === 'repeated-parameter' ? 'parameter blocks' : 'lines'}: ${loop.sample.slice(0, 80)})`,
      );
      err.name = 'A423LoopBreakerError';
      throw err;
    };
    const pushDelta = (text: string) => {
      if (!text) return;
      fullSpeech += text;
      deltaBuf += text;
      scheduleFlush();
      checkLoop(fullSpeech, 'speech');
    };
    const pushReasoning = (text: string) => {
      if (!text) return;
      fullReasoning += text;
      reasonBuf += text;
      scheduleFlush();
      checkLoop(fullReasoning, 'reasoning');
    };

    const seenToolIds = new Set<string>();
    const seenToolNames = new Set<string>();
    // Reasoning/text can span several model steps (before and after tool calls).
    // Insert a blank line when the graph step changes so blocks stay readable.
    let lastSpeechStep: unknown;
    let lastReasonStep: unknown;
    try {
      for await (const chunk of stream as AsyncIterable<unknown>) {
        if (signal.aborted) throw abortError();
        const isTuple = Array.isArray(chunk);
        const msg = (isTuple ? chunk[0] : chunk) as {
          content?: unknown;
          additional_kwargs?: { reasoning_content?: unknown };
          tool_call_chunks?: { id?: string; name?: string; args?: string }[];
        } | undefined;
        if (!isAssistant(msg)) continue;
        const meta = isTuple ? (chunk[1] as { langgraph_step?: unknown } | undefined) : undefined;
        const step = meta?.langgraph_step;

        const text = chunkText(msg?.content);
        if (text) {
          if (lastSpeechStep !== undefined && step !== undefined && step !== lastSpeechStep && fullSpeech && !fullSpeech.endsWith('\n')) pushDelta('\n\n');
          if (step !== undefined) lastSpeechStep = step;
          pushDelta(text);
        }
        const rc = msg?.additional_kwargs?.reasoning_content;
        if (typeof rc === 'string' && rc) {
          if (lastReasonStep !== undefined && step !== undefined && step !== lastReasonStep && fullReasoning && !fullReasoning.endsWith('\n')) pushReasoning('\n\n');
          if (step !== undefined) lastReasonStep = step;
          pushReasoning(rc);
        }
        for (const tc of msg?.tool_call_chunks ?? []) {
          const name = tc?.name;
          if (!name) continue;
          // One tool call is streamed across many chunks. Dedupe by call id
          // when present so repeated calls to the same tool still show up;
          // fall back to name dedupe for providers that omit ids.
          const id = typeof tc.id === 'string' ? tc.id : '';
          if (id) {
            if (seenToolIds.has(id)) continue;
            seenToolIds.add(id);
          } else {
            if (seenToolNames.has(name)) continue;
            seenToolNames.add(name);
          }
          await emitEvent({
            type: 'chat.tool', agentId, runId: run.id,
            payload: { name, args: tc.args ?? '', thread: threadId },
          }).catch(() => undefined);
        }
      }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushDeltas();
    } catch (e) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushDeltas();
      throw e;
    }

    if (signal.aborted) throw abortError();

    // Canonical reply = last assistant message with text in checkpointed state.
    const state = (await agent.getState({ configurable: { thread_id: threadId } } as never)) as
      | { values?: { messages?: unknown[] } }
      | undefined;
    const msgs = state?.values?.messages ?? [];
    const last = [...msgs].reverse().find((m) => isAssistant(m) && chunkText((m as { content?: unknown }).content).trim().length > 0);
    const reply = last ? chunkText((last as { content?: unknown }).content) : '';
    await db.update(agentRuns).set({ status: 'COMPLETED', completedAt: new Date() }).where(eq(agentRuns.id, run.id));
    await emitEvent({
      type: 'chat.reply', agentId, runId: run.id,
      payload: {
        reply,
        reasoning: fullReasoning,
        speech: fullSpeech,
        clientId: body.clientId ?? null,
        thread: threadId,
      },
    });
    return ok({ reply, reasoning: fullReasoning, speech: fullSpeech, runId: run.id, threadId });
  } catch (e) {
    const cancelled = signal.aborted || (e instanceof Error && e.name === 'AbortError');
    const superseded = cancelled && signal.reason === 'superseded';
    const loopLimited = e instanceof Error && (
      e.name === 'ToolCallLimitExceededError'
      || e.name === 'ModelCallLimitMiddlewareError'
      || e.name === 'A423LoopBreakerError'
    );
    const message = loopLimited
      ? `Agent stopped to prevent a tool-call loop: ${e.message}`
      : e instanceof Error ? e.message : String(e);
    if (runId) {
      await db.update(agentRuns)
        .set({ status: cancelled ? 'CANCELLED' : 'FAILED', completedAt: new Date(), error: message })
        .where(eq(agentRuns.id, runId)).catch(() => undefined);
    }
    // A newer turn replaced this one; the replacement owns the live UI.
    if (!superseded) {
      await emitEvent({
        type: cancelled ? 'chat.cancelled' : 'chat.error', agentId,
        payload: {
          error: message,
          ...(loopLimited ? { code: 'AGENT_LOOP_BREAKER' } : {}),
          reasoning: fullReasoning,
          speech: fullSpeech,
          clientId: body.clientId ?? null,
          thread: threadId,
        },
      }).catch(() => undefined);
    }
    return fail(superseded ? 'superseded by a newer message' : (cancelled ? 'run cancelled by user' : message), cancelled ? 499 : 400);
  } finally {
    releaseRun(runKey, controller);
  }
}
