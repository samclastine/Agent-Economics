import { ChatOpenAICompletions } from '@langchain/openai';

/**
 * ChatOpenAI (completions API) tuned for the Reflection API.
 *
 * Reflection requires `reasoning_content` on every assistant message sent back
 * in a conversation. LangChain preserves provider reasoning in
 * `additional_kwargs.reasoning_content`, but drops it during OpenAI message
 * conversion. We hook `completionWithRetry` — the single funnel for all
 * chat.completions calls — and inject the field (a placeholder when the
 * original reasoning is unavailable, e.g. restored checkpoints).
 */
export class ReflectionChatOpenAI extends ChatOpenAICompletions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override completionWithRetry(request: any, requestOptions?: any): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async completionWithRetry(request: any, requestOptions?: any) {
    const messages = request?.messages as Record<string, unknown>[] | undefined;
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m?.role === 'assistant' && m.reasoning_content === undefined) {
          m.reasoning_content = ' ';
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return super.completionWithRetry(request as any, requestOptions as any);
  }
}
