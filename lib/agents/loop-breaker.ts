/**
 * Detects runaway model output that never becomes a tool call.
 *
 * Some providers stream malformed function-call syntax as plain assistant text
 * (for example repeated `<rfl:parameter name="until">` blocks). LangChain's
 * tool-call middleware cannot see those because they are not tool calls, so the
 * chat route checks the assistant speech stream for pathological repetition.
 */

const WINDOW_CHARS = 32_000;
const MIN_LINE_CHARS = 8;
const MAX_LINE_CHARS = 1_000;
const REPEAT_THRESHOLD = 6;
const CHECK_EVERY_CHARS = 256;

export interface OutputLoop {
  kind: 'repeated-line' | 'repeated-parameter';
  sample: string;
  count: number;
}

/** How often the streaming route should re-run detection. */
export function nextLoopCheckLength(currentLength: number): number {
  return currentLength + CHECK_EVERY_CHARS;
}

export function detectOutputLoop(text: string): OutputLoop | null {
  if (!text || text.length < REPEAT_THRESHOLD * MIN_LINE_CHARS) return null;
  const window = text.slice(-WINDOW_CHARS);

  const lines = new Map<string, number>();
  for (const raw of window.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (line.length < MIN_LINE_CHARS || line.length > MAX_LINE_CHARS) continue;
    const count = (lines.get(line) ?? 0) + 1;
    if (count >= REPEAT_THRESHOLD) return { kind: 'repeated-line', sample: line, count };
    lines.set(line, count);
  }

  // Handles providers that stream parameters without newlines between blocks.
  const parameters = new Map<string, number>();
  for (const match of window.matchAll(/<rfl:parameter\b[^>]*\bname\s*=\s*"([^"]+)"/g)) {
    const name = match[1] ?? '';
    if (!name) continue;
    const count = (parameters.get(name) ?? 0) + 1;
    if (count >= REPEAT_THRESHOLD) {
      return { kind: 'repeated-parameter', sample: `<rfl:parameter name="${name}">`, count };
    }
    parameters.set(name, count);
  }

  return null;
}
