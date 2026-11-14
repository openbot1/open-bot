/**
 * Minimal scaffold harness (v1.04, T3e — Harness Engineering).
 *
 * The Harness Engineering paper (arXiv 2609.00006) closes with a
 * ~90-line scaffold: the smallest runnable agent loop, written to be
 * READ, not to be shipped. This is open-bot's version of it — same
 * idea, written fresh: a model function, a tool table, a loop, and a
 * stop condition. Nothing else. Every production subsystem in
 * `packages/core/src/harness/` (event sourcing, stuck detection,
 * compaction, ACP hosting, …) is a layer on top of this shape.
 *
 * HOW TO READ IT (one paragraph per part — the doc
 * `docs/harness-scaffold-v104.md` explains each line):
 * - `ScaffoldMessage` — the conversation is a list of messages.
 *   That list IS the agent's memory; there is no other state.
 * - `ScaffoldModel` — the brain, injected: any function from
 *   messages to a reply. A test passes a fake; production passes a
 *   provider call. The harness never knows which model it is.
 * - `ScaffoldTool` — a tool is a name plus a function. No registry,
 *   no schema validation, no permissions: the scaffold trusts its
 *   tools, and says so.
 * - `runScaffoldHarness` — the loop: ask the model, run the tool it
 *   asked for (or stop when it answers in text), append the result
 *   as a `tool` message, repeat until `maxSteps`. Every exit has a
 *   named reason (`final` / `max-steps` / `unknown-tool`).
 */

export interface ScaffoldMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ScaffoldToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScaffoldModelReply {
  /** Final answer (when present, the loop stops after this turn). */
  text?: string;
  /** Tool the model wants to call (when present, the loop runs it). */
  toolCall?: ScaffoldToolCall;
}

export type ScaffoldModel = (messages: ScaffoldMessage[]) => Promise<ScaffoldModelReply>;

export interface ScaffoldTool {
  name: string;
  description?: string;
  run: (args: Record<string, unknown>) => string | Promise<string>;
}

export type ScaffoldFinishReason = 'final' | 'max-steps' | 'unknown-tool';

export interface ScaffoldResult {
  messages: ScaffoldMessage[];
  /** Model turns taken (a turn = one model call). */
  steps: number;
  finishReason: ScaffoldFinishReason;
  /** The final answer, when the run ended with one. */
  finalText?: string;
}

export interface ScaffoldOptions {
  tools?: ScaffoldTool[];
  /** Max model turns. Default 10. */
  maxSteps?: number;
}

export async function runScaffoldHarness(
  model: ScaffoldModel,
  prompt: string,
  opts: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
  const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const maxSteps = opts.maxSteps ?? 10;
  const messages: ScaffoldMessage[] = [{ role: 'user', content: prompt }];
  let steps = 0;
  while (steps < maxSteps) {
    steps++;
    const reply = await model(messages);
    if (!reply.toolCall) {
      const finalText = reply.text ?? '';
      messages.push({ role: 'assistant', content: finalText });
      return { messages, steps, finishReason: 'final', finalText };
    }
    const tool = tools.get(reply.toolCall.name);
    if (!tool) {
      return { messages, steps, finishReason: 'unknown-tool' };
    }
    messages.push({
      role: 'assistant',
      content: `[tool ${tool.name} ${JSON.stringify(reply.toolCall.args)}]`,
    });
    const output = await tool.run(reply.toolCall.args);
    messages.push({ role: 'tool', content: output });
  }
  return { messages, steps, finishReason: 'max-steps' };
}
