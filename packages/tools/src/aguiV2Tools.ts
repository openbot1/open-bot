/**
 * AG-UI v2 tools for @open-bot/tools (v1.10, Đội T5).
 *
 * The agent drives generative UI v2 by tool call:
 *  - agui_v2_suggest       — pick the best component for a context
 *    (numbers -> chart, rows -> table, choices -> options,
 *    key-values -> card, inputs -> form, ...) with the reason (read)
 *  - agui_v2_validate      — validate a raw component request and
 *    negotiate it against client capabilities (fallback preview) (read)
 *  - agui_v2_request       — register a validated component as
 *    pending for a run (local action)
 *  - agui_v2_answer        — answer a pending component (card action
 *    / form submit / options pick / confirm) (local action)
 *  - agui_v2_pending       — pending components of a run (read)
 *  - agui_v2_capabilities  — what the default client can render
 *    (read)
 *
 * SAFETY: components are DATA ONLY — validated in the core module
 * before they reach any renderer; no HTML, no scripts, no URLs
 * except plain https:// links in table cells. These tools never
 * execute anything from a component.
 *
 * Factory:
 *   createAguiV2Tools(opts) -> Tool[]   (bound, usable)
 *   AGUI_V2_TOOLS                       (unbound placeholder)
 *
 * NOTE (v1.10 merge): exported from the tools package but NOT yet
 * wired into defaultToolFactory — the coordinator wires
 * createAguiV2Tools and recounts the 556 tool pin (see wave report).
 */
import type { Tool } from '@open-bot/core';
import {
  AgUiV2Registry,
  negotiateAgUiV2,
  suggestAgUiV2Component,
  validateAgUiV2Request,
  type AgUiV2ClientCapabilities,
  type AgUiV2ComponentKind,
  type AgUiV2Context,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getRecordArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export interface AguiV2ToolOptions {
  /** Registry accessor (the host binds its AgUiV2Registry). */
  getRegistry?: () => AgUiV2Registry | null;
  /** Default client capabilities used when the caller omits them. */
  defaultCapabilities?: AgUiV2ClientCapabilities;
}

/** What the default desktop client can render (all 8 kinds, interactive). */
export const AGUI_V2_DEFAULT_CAPABILITIES: AgUiV2ClientCapabilities = {
  kinds: ['confirm', 'options', 'form', 'table', 'progress', 'message', 'card', 'chart'],
  interactive: true,
  maxItems: 50,
};

function parseCapabilities(value: unknown): AgUiV2ClientCapabilities | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Argument "capabilities" must be an object with a "kinds" array.');
  }
  const kinds = (value as Record<string, unknown>)['kinds'];
  if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== 'string')) {
    throw new Error('Argument "capabilities.kinds" must be an array of kind names.');
  }
  const interactive = (value as Record<string, unknown>)['interactive'];
  if (interactive !== undefined && typeof interactive !== 'boolean') {
    throw new Error('Argument "capabilities.interactive" must be a boolean.');
  }
  return {
    kinds: kinds as AgUiV2ComponentKind[],
    ...(interactive !== undefined ? { interactive } : {}),
  };
}

export function createAguiV2Tools(opts: AguiV2ToolOptions = {}): Tool[] {
  let fallbackRegistry: AgUiV2Registry | null = null;
  const needRegistry = (): AgUiV2Registry => {
    const registry = opts.getRegistry?.() ?? fallbackRegistry;
    if (!registry) {
      fallbackRegistry = new AgUiV2Registry();
      return fallbackRegistry;
    }
    return registry;
  };
  const capabilitiesOf = (args: Record<string, unknown>): AgUiV2ClientCapabilities =>
    parseCapabilities(args['capabilities']) ?? opts.defaultCapabilities ?? AGUI_V2_DEFAULT_CAPABILITIES;

  const suggest: Tool = {
    definition: toolDef(
      'agui_v2_suggest',
      'Pick the best generative-UI component for a context (read): numbers -> chart, rows -> table, choices -> options, key-values -> card, inputs -> form, yes/no -> confirm, text -> message, fraction -> progress. Returns the validated request plus the reason it was picked.',
      {
        componentId: { type: 'string', description: 'Id for the suggested component.' },
        title: { type: 'string', description: 'Title shown on the component.' },
        runId: { type: 'string', description: 'Run the component belongs to.' },
        context: { type: 'object', description: 'Context: {kind, ...} — kind is numbers, rows, choices, confirm, inputs, keyValues, message or progress.' },
        blocking: { type: 'boolean', description: 'Whether the run waits for an answer (default false).' },
      },
      ['componentId', 'title', 'runId', 'context'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const componentId = getStringArg(args, 'componentId');
        const title = getStringArg(args, 'title');
        const runId = getStringArg(args, 'runId');
        const context = getRecordArg(args, 'context') as unknown as AgUiV2Context;
        const blocking = getOptionalBooleanArg(args, 'blocking');
        const suggestion = suggestAgUiV2Component({
          componentId, title, runId, context,
          ...(blocking === true ? { blocking: true } : {}),
        });
        return JSON.stringify({ suggestion }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validate: Tool = {
    definition: toolDef(
      'agui_v2_validate',
      'Validate a raw generative-UI v2 request and negotiate it against client capabilities (read): returns the validated request plus the fallback that would apply (chart -> table, card -> message) or why it cannot render.',
      {
        componentId: { type: 'string', description: 'Id for the component.' },
        kind: { type: 'string', description: 'Kind: confirm, options, form, table, progress, message, card or chart.' },
        title: { type: 'string', description: 'Title shown on the component.' },
        props: { type: 'object', description: 'Component props for the kind.' },
        runId: { type: 'string', description: 'Run the component belongs to.' },
        capabilities: { type: 'object', description: 'Client capabilities {kinds, interactive} (optional; defaults to the full desktop client).' },
      },
      ['componentId', 'kind', 'title', 'props', 'runId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const componentId = getStringArg(args, 'componentId');
        const kind = getStringArg(args, 'kind');
        const title = getStringArg(args, 'title');
        const props = getRecordArg(args, 'props');
        const runId = getStringArg(args, 'runId');
        const request = validateAgUiV2Request({ componentId, kind, title, props } as never, runId);
        const negotiation = negotiateAgUiV2(request, capabilitiesOf(args));
        return JSON.stringify({ request, negotiation }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const request: Tool = {
    definition: toolDef(
      'agui_v2_request',
      'Register a validated generative-UI v2 component as pending for a run (local action). Capabilities are negotiated first; a fallback is recorded on the component when one applies.',
      {
        componentId: { type: 'string', description: 'Id for the component.' },
        kind: { type: 'string', description: 'Kind: confirm, options, form, table, progress, message, card or chart.' },
        title: { type: 'string', description: 'Title shown on the component.' },
        props: { type: 'object', description: 'Component props for the kind.' },
        runId: { type: 'string', description: 'Run the component belongs to.' },
        capabilities: { type: 'object', description: 'Client capabilities {kinds, interactive} (optional; defaults to the full desktop client).' },
        blocking: { type: 'boolean', description: 'Whether the run waits for an answer (default false).' },
      },
      ['componentId', 'kind', 'title', 'props', 'runId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const componentId = getStringArg(args, 'componentId');
        const kind = getStringArg(args, 'kind');
        const title = getStringArg(args, 'title');
        const props = getRecordArg(args, 'props');
        const runId = getStringArg(args, 'runId');
        const blocking = getOptionalBooleanArg(args, 'blocking');
        const description = getOptionalStringArg(args, 'description');
        const request = validateAgUiV2Request(
          { componentId, kind, title, props, ...(description !== undefined ? { description } : {}) } as never,
          runId,
        );
        const record = needRegistry().request(
          { ...request, ...(blocking === true ? { blocking: true } : {}) },
          capabilitiesOf(args),
        );
        return JSON.stringify({ record }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const answer: Tool = {
    definition: toolDef(
      'agui_v2_answer',
      'Answer a pending generative-UI v2 component (local action): card action id, form values, options pick, confirm boolean — validated against the request shape. A second answer is rejected.',
      {
        componentId: { type: 'string', description: 'Id of the pending component.' },
        response: { type: 'object', description: 'Response object for the kind (e.g. {confirmed: true}, {selected: "a"}, {action: "save"}).' },
        action: { type: 'string', description: 'Action taken (e.g. confirm, dismiss, submit, or a card action id).' },
      },
      ['componentId', 'response'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const componentId = getStringArg(args, 'componentId');
        const response = getRecordArg(args, 'response');
        const action = getOptionalStringArg(args, 'action');
        const record = needRegistry().answer(componentId, {
          componentId,
          response,
          ...(action !== undefined ? { action } : {}),
        });
        return JSON.stringify({ record }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pending: Tool = {
    definition: toolDef(
      'agui_v2_pending',
      'Pending (unanswered, unexpired) generative-UI v2 components of a run, oldest first (read).',
      {
        runId: { type: 'string', description: 'Run to list pending components for.' },
      },
      ['runId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const runId = getStringArg(args, 'runId');
        const records = needRegistry().pendingForRun(runId);
        return JSON.stringify({ runId, pending: records, count: records.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const capabilities: Tool = {
    definition: toolDef(
      'agui_v2_capabilities',
      'What the default desktop client can render (read): all 8 component kinds, interactive, max 50 items per component.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        return JSON.stringify({ capabilities: opts.defaultCapabilities ?? AGUI_V2_DEFAULT_CAPABILITIES }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [suggest, validate, request, answer, pending, capabilities];
}

/** Unbound placeholder (the host binds a registry via createAguiV2Tools). */
export const AGUI_V2_TOOLS: Tool[] = createAguiV2Tools();

export const AGUI_V2_TOOL_NAMES = [
  'agui_v2_suggest',
  'agui_v2_validate',
  'agui_v2_request',
  'agui_v2_answer',
  'agui_v2_pending',
  'agui_v2_capabilities',
] as const;

export function isAguiV2ToolName(name: string): name is (typeof AGUI_V2_TOOL_NAMES)[number] {
  return (AGUI_V2_TOOL_NAMES as readonly string[]).includes(name);
}
