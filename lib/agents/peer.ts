import { buildAgent } from './factory';
import { getDb } from '@/lib/db/client';
import { agents, agentEvents } from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';
import { emitEvent } from '@/lib/events';
import { acquireRun, releaseRun, abortError } from '@/lib/run-control';

/** Bare pleasantries need no agent run — replying to them just fuels courtesy loops. */
const PLEASANTRY = /^(thanks|thank you|thx|you're welcome|you'?re welcome|got it|sounds good|ok(ay)?|great|perfect|awesome|appreciated?|noted|will do|looking forward)[\s!.…,—-]*$/i;

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

/**
 * Agent-to-agent marketplace mail. Delivers `text` to the recipient agent:
 *  - emits `peer.message` so the recipient's chat panel shows the incoming mail,
 *  - streams the recipient's Deep Agent on its dedicated `:inbox` checkpoint
 *    thread — token deltas (`peer.delta`, ephemeral), tool calls (`peer.tool`)
 *    and the final reply (`peer.reply`) all render live in the chat panel,
 *  - mirrors the reply as `peer.inbound` in the sender's panel (display only —
 *    the sender's agent is NOT invoked, so conversations can't loop).
 */
export async function sendPeerMessage(opts: {
  fromAgentId: string;
  toAgentId: string;
  text: string;
  jobId?: string | null;
  relayDepth?: number;
  /** Emit the mailbox event but do not run the recipient's agent (tests/inspection). */
  deliverOnly?: boolean;
}): Promise<void> {
  const db = getDb();
  const [from, to] = await Promise.all([
    db.query.agents.findFirst({ where: eq(agents.id, opts.fromAgentId) }),
    db.query.agents.findFirst({ where: eq(agents.id, opts.toAgentId) }),
  ]);
  const fromName = from?.name ?? 'Agent';
  const toName = to?.name ?? 'Agent';
  if (!to) return;
  const storedJobId = null;

  await emitEvent({
    type: 'peer.message', agentId: opts.toAgentId, jobId: storedJobId,
    payload: { fromAgentId: opts.fromAgentId, fromName, text: opts.text, job_id: opts.jobId ?? null },
  });

  if (opts.deliverOnly || process.env.A423_PEER_DELIVER_ONLY === 'true') return;

  // Circuit breaker: agents sometimes fall into "thanks / you're welcome" ping-pong.
  // Skip the agent run for bare pleasantries, and mute the pair entirely if they've
  // exchanged too many messages recently without a job driving the conversation.
  const isPleasantry = !opts.jobId && opts.text.trim().length < 100 && PLEASANTRY.test(opts.text.trim());
  // Job-scoped mail is a negotiation, not a courtesy loop. The relay depth below
  // already caps it, so do not let unrelated recent job mail mute a new offer.
  if (!isPleasantry && !opts.jobId) {
    const since = new Date(Date.now() - 10 * 60 * 1000);
    const recent = await db
      .select({ agentId: agentEvents.agentId, payloadJson: agentEvents.payloadJson })
      .from(agentEvents)
      .where(and(eq(agentEvents.type, 'peer.message'), gte(agentEvents.createdAt, since)));
    let n = 0;
    for (const row of recent) {
      const fromId = (row.payloadJson as Record<string, unknown> | null)?.fromAgentId;
      if ((row.agentId === opts.toAgentId && fromId === opts.fromAgentId)
        || (row.agentId === opts.fromAgentId && fromId === opts.toAgentId)) {
        n += 1;
      }
    }
    if (n >= 20) {
      await emitEvent({
        type: 'peer.muted', agentId: opts.toAgentId, jobId: storedJobId,
        payload: { fromAgentId: opts.fromAgentId, reason: `peer exchange cap (${n} msgs/10min)` },
      }).catch(() => undefined);
      return;
    }
  }
  if (isPleasantry) return;

  const { signal, controller } = acquireRun(`peer:${opts.toAgentId}`);
  const threadId = `agent:${opts.toAgentId}:inbox`;
  // Totals survive the streaming buffers so the final event can rebuild the
  // recipient's thinking/speaking blocks after a page reload.
  let fullReasoning = '';
  let fullSpeech = '';
  try {
    const agent = await buildAgent(opts.toAgentId);
    const stream = await agent.stream(
      {
        messages: [{
          role: 'user',
          content:
            `[Marketplace message from ${fromName} (${opts.fromAgentId})` +
            (opts.jobId ? ` about job ${opts.jobId}` : '') + `]\n\n${opts.text}\n\n` +
            `This is agent-to-agent marketplace mail from your counterparty — not from your owner. ` +
            (process.env.A423_CHAT_MODE === 'sdk'
              ? `Use a423_list_jobs first if you do not know the exact workflow ID, then a423_job_status to inspect it and a423_job_action for every job step. Never guess or reconstruct an ID. `
                + `For job offers use action="respond_to_offer" with decision=accept, reject or counter (counter needs usdCents). `
                + `Use action="accept_job_offer" to accept the current revision, "counter_offer" to revise a price, `
                + `"sign_worker_consent" for server-side worker consent, "fund_escrow" as the requester, `
                + `and "work_on_job" only after funding is confirmed. Negotiation is bounded: at most 4 quote revisions, `
                + `never counter your own offer, and as requester never exceed the original budget; decline or cancel if the price is too high. `
                + `Use message_agent for plain replies. Do not create unrelated new jobs.`
              : `Respond appropriately: use respond_to_offer for job offers, message_agent to reply or ask `
                + `questions, work_on_job only for FUNDED jobs assigned to you. Do not create unrelated new jobs.`),
        }],
      },
      { configurable: { thread_id: threadId }, streamMode: 'messages' as never },
    );

    // Stream tokens + reasoning + tool calls live into the recipient's chat panel.
    let deltaBuf = '';
    let reasonBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDeltas = () => {
      if (reasonBuf) {
        const text = reasonBuf;
        reasonBuf = '';
        void emitEvent({
          type: 'peer.reasoning', agentId: opts.toAgentId, jobId: storedJobId, ephemeral: true,
          payload: { text },
        });
      }
      if (!deltaBuf) return;
      const text = deltaBuf;
      deltaBuf = '';
      void emitEvent({
        type: 'peer.delta', agentId: opts.toAgentId, jobId: storedJobId, ephemeral: true,
        payload: { text },
      });
    };
    const scheduleFlush = () => {
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushDeltas(); }, 60);
    };
    const seenToolIds = new Set<string>();
    const seenToolNames = new Set<string>();
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
        // Tool results are part of the stream too — only assistant chunks are
        // the agent's own speech.
        if (!isAssistant(msg)) continue;
        const meta = isTuple ? (chunk[1] as { langgraph_step?: unknown } | undefined) : undefined;
        const step = meta?.langgraph_step;
        const text = chunkText(msg?.content);
        if (text) {
          if (lastSpeechStep !== undefined && step !== undefined && step !== lastSpeechStep && fullSpeech && !fullSpeech.endsWith('\n')) {
            fullSpeech += '\n\n';
            deltaBuf += '\n\n';
          }
          if (step !== undefined) lastSpeechStep = step;
          fullSpeech += text;
          deltaBuf += text;
          scheduleFlush();
        }
        const rc = msg?.additional_kwargs?.reasoning_content;
        if (typeof rc === 'string' && rc) {
          if (lastReasonStep !== undefined && step !== undefined && step !== lastReasonStep && fullReasoning && !fullReasoning.endsWith('\n')) {
            fullReasoning += '\n\n';
            reasonBuf += '\n\n';
          }
          if (step !== undefined) lastReasonStep = step;
          fullReasoning += rc;
          reasonBuf += rc;
          scheduleFlush();
        }
        for (const tc of msg?.tool_call_chunks ?? []) {
          const name = tc?.name;
          if (!name) continue;
          // One tool call streams across many chunks: dedupe by call id so
          // repeated calls to the same tool still show, falling back to name
          // dedupe for providers that omit ids.
          const id = typeof tc.id === 'string' ? tc.id : '';
          if (id) {
            if (seenToolIds.has(id)) continue;
            seenToolIds.add(id);
          } else {
            if (seenToolNames.has(name)) continue;
            seenToolNames.add(name);
          }
          await emitEvent({
            type: 'peer.tool', agentId: opts.toAgentId, jobId: storedJobId,
            payload: { name, args: tc.args ?? '' },
          });
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

    await emitEvent({
      type: 'peer.reply', agentId: opts.toAgentId, jobId: storedJobId,
      payload: { text: reply.slice(0, 2000), reasoning: fullReasoning, speech: fullSpeech },
    });
    if (reply.trim()) {
      await emitEvent({
        type: 'peer.inbound', agentId: opts.fromAgentId, jobId: storedJobId,
        payload: { fromAgentId: opts.toAgentId, fromName: toName, text: reply.slice(0, 2000) },
      });
    }

    // Negotiation relay: while the job is still being negotiated (quoted/accepted),
    // deliver the reply back to the sender's inbox so the conversation can continue.
    // Capped by relayDepth; once funded/working/settled the loop stops automatically.
    const depth = opts.relayDepth ?? 0;
    if (reply.trim() && opts.jobId && depth < 8) {
      let negotiating = false;
      try {
        const { getA423Bridge } = await import('@/lib/a423/bridge04');
        const bridge = await getA423Bridge();
        const a423Job = await bridge.app.workflow.get(opts.jobId, opts.toAgentId);
        negotiating = a423Job.state === 'quoted' || a423Job.state === 'accepted';
      } catch { /* not an A423 job, or the recipient is not a participant */ }
      if (negotiating) {
        void sendPeerMessage({
          fromAgentId: opts.toAgentId,
          toAgentId: opts.fromAgentId,
          jobId: opts.jobId,
          relayDepth: depth + 1,
          text: reply.slice(0, 2000),
        }).catch(() => undefined);
      }
    }
  } catch (e) {
    const cancelled = signal.aborted || (e instanceof Error && e.name === 'AbortError');
    // A newer mailbox message supersedes this run — the replacement run will
    // report the real outcome, so don't render a stale cancellation block.
    if (cancelled && signal.reason === 'superseded') return;
    await emitEvent({
      type: cancelled ? 'peer.cancelled' : 'peer.error', agentId: opts.toAgentId, jobId: storedJobId,
      payload: {
        error: e instanceof Error ? e.message : String(e),
        reasoning: fullReasoning,
        speech: fullSpeech,
      },
    }).catch(() => undefined);
  } finally {
    releaseRun(`peer:${opts.toAgentId}`, controller);
  }
}
