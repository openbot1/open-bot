/**
 * Router local v117 tools (v1.40, Doi T3) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * 13 tools (ham thuan tren state in-memory mac dinh; host co the
 * truyen state rieng qua createRouterLocalV117Tools):
 * - `router_local_midchat_route` — route mot message giua cuoc tro
 *   chuyen: leo len model manh/da phuong thuc khi gap anh hoac code
 *   kho, ha xuong model nhe/re khi noi dung de; tra ly do chon model.
 * - `router_local_midchat_policy_get` / `router_local_midchat_policy_set`
 *   — xem/dat policy (nguong leo/ha, model ung vien, cooldown).
 * - `router_local_midchat_tree_set` / `router_local_midchat_tree_get`
 *   — dat/xem cay router long nhau (router tro toi router).
 * - `router_local_risk_score` — cham rui ro LOW/MEDIUM/HIGH/UNKNOWN
 *   cho mot tool call (annotation + noi dung call + field inline
 *   security_risk neu co).
 * - `router_local_risk_annotate` — dang ky annotation cho mot tool.
 * - `router_local_tool_call_gate` — cham risk + ap confirmation policy
 *   trong mot lan goi: tra pending id neu phai doi user xac nhan.
 * - `router_local_confirm_policy_get` / `router_local_confirm_policy_set`
 *   — xem/dat policy xac nhan (AlwaysConfirm / NeverConfirm /
 *   ConfirmRisky + threshold + TTL).
 * - `router_local_confirm_pending` — danh sach cho xac nhan
 *   (WAITING_FOR_CONFIRMATION).
 * - `router_local_confirm_decide` — approve/reject mot yeu cau cho.
 * - `router_local_audit_log` — log hop nhat route + risk + confirm
 *   (de audit vi sao model duoc chon, tool duoc cham bao nhieu, ai
 *   duyet/tu choi).
 * - `router_local_midchat_cost_report` — bao cao token/tiet kiem theo
 *   session (bao nhieu token chay bang model nhe thay vi model manh).
 * - `router_local_risk_catalog` — catalog annotation builtin cho cac
 *   tool pho bien (de host khoi can dang ky tay).
 * - `router_local_risk_score_batch` — cham rui ro cho nhieu tool call
 *   cung luc (toi da 32).
 * - `router_local_confirm_tool_override` — dat/xem override xac nhan
 *   theo tung tool (always/never/default).
 *
 * Khong goi model that, khong thuc thi tool, khong doc/gui credential.
 */

import type { Tool } from '@open-bot/core';
import {
  ConfirmationGate,
  MidChatRouter,
  MidChatSessionManager,
  RiskScorer,
  defaultConfirmPolicy,
  defaultMidChatPolicy,
  parseInlineSecurityRisk,
  riskAtLeast,
  scoreToolCallRisk,
  validateRouterNode,
  type ConfirmPolicy,
  type ConfirmPolicyMode,
  type MidChatCandidate,
  type MidChatPolicy,
  type MidChatRouterNode,
  type MidChatTier,
  type SecurityRisk,
  type ToolAnnotations,
  type ToolConfirmOverride,
} from '@open-bot/core';

export const ROUTER_LOCAL_V117_TOOL_NAMES = [
  'router_local_midchat_route',
  'router_local_midchat_policy_get',
  'router_local_midchat_policy_set',
  'router_local_midchat_tree_set',
  'router_local_midchat_tree_get',
  'router_local_risk_score',
  'router_local_risk_annotate',
  'router_local_tool_call_gate',
  'router_local_confirm_policy_get',
  'router_local_confirm_policy_set',
  'router_local_confirm_pending',
  'router_local_confirm_decide',
  'router_local_audit_log',
  'router_local_midchat_cost_report',
  'router_local_risk_catalog',
  'router_local_risk_score_batch',
  'router_local_confirm_tool_override',
] as const;

export function isRouterLocalV117ToolName(name: string): boolean {
  return (ROUTER_LOCAL_V117_TOOL_NAMES as readonly string[]).includes(name);
}

/** State dung chung cua bo tool (host co the truyen state rieng). */
export interface RouterLocalV117State {
  router: MidChatRouter;
  scorer: RiskScorer;
  gate: ConfirmationGate;
  sessions: MidChatSessionManager;
}

export function createDefaultRouterLocalV117State(): RouterLocalV117State {
  return {
    router: new MidChatRouter(),
    scorer: new RiskScorer(),
    gate: new ConfirmationGate(),
    sessions: new MidChatSessionManager(),
  };
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

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function getNumberArg(args: Record<string, unknown>, name: string, required = true, fallback = 0): number {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getObjectArg(args: Record<string, unknown>, name: string, required = true): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getOptionalObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

const SECURITY_RISK_VALUES: readonly string[] = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'];
const CONFIRM_MODES: readonly string[] = ['AlwaysConfirm', 'NeverConfirm', 'ConfirmRisky'];
const MID_CHAT_TIERS: readonly string[] = ['light', 'standard', 'strong', 'multimodal'];

function parseAnnotations(raw: Record<string, unknown>): ToolAnnotations {
  const out: ToolAnnotations = {};
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'boolean') throw new Error(`Annotation "${key}" phai la boolean.`);
      out[key] = value;
    }
  }
  return out;
}

function parseCandidates(raw: unknown): MidChatCandidate[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('candidates phai la array khong rong.');
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`candidates[${index}] phai la object.`);
    }
    const c = item as Record<string, unknown>;
    if (typeof c.modelId !== 'string' || c.modelId.trim() === '') {
      throw new Error(`candidates[${index}].modelId phai la string khong rong.`);
    }
    if (typeof c.tier !== 'string' || !MID_CHAT_TIERS.includes(c.tier)) {
      throw new Error(`candidates[${index}].tier phai la mot trong: ${MID_CHAT_TIERS.join(', ')}.`);
    }
    const cost = typeof c.costPer1kTokensUsd === 'number' ? c.costPer1kTokensUsd : 0;
    const quality = typeof c.quality === 'number' ? c.quality : 0.5;
    const maxContext = typeof c.maxContextTokens === 'number' ? Math.floor(c.maxContextTokens) : 32768;
    if (cost < 0) throw new Error(`candidates[${index}].costPer1kTokensUsd khong duoc am.`);
    if (quality < 0 || quality > 1) throw new Error(`candidates[${index}].quality phai la so 0..1.`);
    if (maxContext < 1) throw new Error(`candidates[${index}].maxContextTokens phai >= 1.`);
    return {
      modelId: c.modelId,
      tier: c.tier as MidChatTier,
      costPer1kTokensUsd: cost,
      quality,
      multimodal: c.multimodal === true,
      maxContextTokens: maxContext,
      label: typeof c.label === 'string' ? c.label : undefined,
    };
  });
}

function parseTreeNode(raw: unknown): MidChatRouterNode {
  const errors = validateRouterNode(raw);
  if (errors.length > 0) throw new Error(`Cay router khong hop le: ${errors.join(' ')}`);
  return raw as MidChatRouterNode;
}

/** Ghep field inline security_risk vao args de scorer doi chieu. */
function withInlineRisk(toolArgs: Record<string, unknown>, securityRisk?: string): Record<string, unknown> {
  if (securityRisk === undefined) return toolArgs;
  const parsed = parseInlineSecurityRisk(securityRisk);
  if (parsed === null) throw new Error(`securityRisk phai la mot trong: ${SECURITY_RISK_VALUES.join(', ')}.`);
  return { ...toolArgs, security_risk: parsed };
}

export function createRouterLocalV117Tools(state: RouterLocalV117State = createDefaultRouterLocalV117State()): Tool[] {
  const { router, scorer, gate, sessions } = state;

  const midchatRouteTool: Tool = {
    definition: toolDef(
      'router_local_midchat_route',
      'Route one message mid-conversation: escalate to a strong/multimodal model only for images or hard code/reasoning, downgrade to a cheap/light model for easy content, otherwise stay. Returns the chosen model, direction, difficulty and the reason for the choice (logged for audit).',
      {
        content: { type: 'string', description: 'Message content to route on.' },
        currentModelId: { type: 'string', description: 'Model currently in use (default: policy defaultModelId).' },
        hasImage: { type: 'boolean', description: 'Whether the message carries an image attachment (default false).' },
        sessionId: { type: 'string', description: 'Optional conversation session id — route inside that session (auto-created) so each conversation escalates/downgrades independently.' },
      },
      ['content'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const content = getStringArg(args, 'content');
        if (content.trim() === '') return errorResult('content khong duoc rong.');
        const currentModelId = getOptionalStringArg(args, 'currentModelId');
        const hasImage = getBoolArg(args, 'hasImage', false);
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const decision = sessionId !== undefined
          ? sessions.route(sessionId, content, currentModelId, { hasImage })
          : router.route(content, currentModelId, { hasImage });
        return okResult({
          id: decision.id,
          sessionId: sessionId ?? null,
          chosenModelId: decision.chosenModelId,
          previousModelId: decision.previousModelId,
          direction: decision.direction,
          difficulty: decision.difficulty,
          signals: {
            hasImage: decision.signals.hasImage,
            hasCodeBlock: decision.signals.hasCodeBlock,
            codeLines: decision.signals.codeLines,
            codeLanguage: decision.signals.codeLanguage,
            reasoningHits: decision.signals.reasoningHits,
            multiStep: decision.signals.multiStep,
            questionCount: decision.signals.questionCount,
            isShortChat: decision.signals.isShortChat,
          },
          reasons: decision.reasons,
          nodePath: decision.nodePath,
          turnsSinceEscalation: router.getTurnsSinceEscalation(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const midchatPolicyGetTool: Tool = {
    definition: toolDef(
      'router_local_midchat_policy_get',
      'Show the current mid-chat routing policy: escalate/de-escalate thresholds, model ids per tier, cooldown turns and the candidate model list.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const policy = router.getPolicy();
        return okResult({
          policy,
          treeSet: router.getTree() !== null,
          turnsSinceEscalation: router.getTurnsSinceEscalation(),
          decisionsLogged: router.getLogStore().size(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const midchatPolicySetTool: Tool = {
    definition: toolDef(
      'router_local_midchat_policy_set',
      'Set the mid-chat routing policy (partial update). deescalateThreshold must stay below escalateThreshold. Pass candidates to replace the candidate model list.',
      {
        escalateThreshold: { type: 'number', description: 'Difficulty >= this escalates (0..1, default 0.65).' },
        deescalateThreshold: { type: 'number', description: 'Difficulty <= this de-escalates (0..1, default 0.30).' },
        defaultModelId: { type: 'string', description: 'Default model id.' },
        lightModelId: { type: 'string', description: 'Light/cheap model id for easy content.' },
        strongModelId: { type: 'string', description: 'Strong model id for hard content.' },
        multimodalModelId: { type: 'string', description: 'Multimodal model id for images.' },
        minTurnsAfterEscalate: { type: 'number', description: 'Min messages after an escalation before a downgrade is allowed (default 2).' },
        candidates: { type: 'array', items: { type: 'object' }, description: 'Candidate models: [{modelId, tier, costPer1kTokensUsd?, quality?, multimodal?, maxContextTokens?, label?}].' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const partial: Partial<MidChatPolicy> = {};
        for (const key of ['escalateThreshold', 'deescalateThreshold'] as const) {
          if (args[key] !== undefined) partial[key] = getNumberArg(args, key);
        }
        for (const key of ['defaultModelId', 'lightModelId', 'strongModelId', 'multimodalModelId'] as const) {
          if (args[key] !== undefined) partial[key] = getStringArg(args, key);
        }
        if (args.minTurnsAfterEscalate !== undefined) {
          partial.minTurnsAfterEscalate = getNumberArg(args, 'minTurnsAfterEscalate');
        }
        if (args.candidates !== undefined) {
          partial.candidates = parseCandidates(args.candidates);
        }
        const policy = router.setPolicy(partial);
        return okResult({ policy });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const midchatTreeSetTool: Tool = {
    definition: toolDef(
      'router_local_midchat_tree_set',
      'Set a nested router tree (router nodes pointing to routers, ending in model leaves). Branches match on hasImage/hasCode/minDifficulty/maxDifficulty; unmatched messages fall through to the fallback node. Pass null to clear the tree and go back to threshold policy.',
      {
        tree: { type: 'object', description: 'Router tree node: {kind:"model",modelId} or {kind:"router",id,branches:[{predicate,node}],fallback}. Null clears the tree.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        if (args.tree === null || args.tree === undefined) {
          router.setTree(null);
          return okResult({ tree: null, note: 'Da xoa cay router — dung lai policy nguong phang.' });
        }
        const node = parseTreeNode(args.tree);
        router.setTree(node);
        return okResult({ tree: router.getTree(), note: 'Cay router da dat — route se giai qua cay thay vi nguong phang.' });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const midchatTreeGetTool: Tool = {
    definition: toolDef(
      'router_local_midchat_tree_get',
      'Show the current nested router tree (null when threshold policy is in use) plus the recent routing decisions with their tree paths.',
      {
        limit: { type: 'number', description: 'Max recent decisions to show (default 5).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const limit = getNumberArg(args, 'limit', false, 5);
        if (limit < 0) return errorResult('limit khong duoc am.');
        const decisions = router.getLogStore().list().slice(0, limit).map((d) => ({
          id: d.id,
          direction: d.direction,
          chosenModelId: d.chosenModelId,
          difficulty: d.difficulty,
          nodePath: d.nodePath,
          reasons: d.reasons,
        }));
        return okResult({ tree: router.getTree(), decisions });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const riskScoreTool: Tool = {
    definition: toolDef(
      'router_local_risk_score',
      'Score the security risk of one tool call (LOW/MEDIUM/HIGH/UNKNOWN) from its annotations (readOnlyHint/destructiveHint/...) and call content, plus an optional inline security_risk self-assessment from the LLM. Unregistered tools score UNKNOWN (fail-closed) unless a dangerous pattern is found.',
      {
        toolName: { type: 'string', description: 'Tool name, e.g. shell_exec, file_read.' },
        toolArgs: { type: 'object', description: 'Tool call arguments (optional).' },
        annotations: { type: 'object', description: 'Optional annotations for this call only: {readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint?}.' },
        securityRisk: { type: 'string', description: 'Optional inline LLM self-assessment: LOW, MEDIUM, HIGH or UNKNOWN.' },
      },
      ['toolName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolName = getStringArg(args, 'toolName');
        const toolArgs = getOptionalObjectArg(args, 'toolArgs') ?? {};
        const securityRisk = getOptionalStringArg(args, 'securityRisk');
        const withInline = withInlineRisk(toolArgs, securityRisk);
        const inlineAnnotations = getOptionalObjectArg(args, 'annotations');
        const record = inlineAnnotations !== undefined
          ? scoreToolCallRisk(toolName, parseAnnotations(inlineAnnotations), withInline)
          : scorer.score(toolName, withInline);
        return okResult({
          id: 'id' in record ? record.id : undefined,
          toolName: record.toolName,
          risk: record.risk,
          score: record.score,
          factors: record.factors,
          inlineRisk: record.inlineRisk,
          inlineAgrees: record.inlineAgrees,
          suggestedAction: record.suggestedAction,
          registeredAnnotations: scorer.getAnnotations(toolName) ?? null,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const riskAnnotateTool: Tool = {
    definition: toolDef(
      'router_local_risk_annotate',
      'Register MCP-style annotations for a tool so later risk scoring knows it: readOnlyHint (read-only), destructiveHint (deletes/mutates), idempotentHint (safe to retry), openWorldHint (talks to the outside world).',
      {
        toolName: { type: 'string', description: 'Tool name to annotate.' },
        readOnlyHint: { type: 'boolean', description: 'True when the tool only reads.' },
        destructiveHint: { type: 'boolean', description: 'True when the tool deletes or destroys data.' },
        idempotentHint: { type: 'boolean', description: 'True when calling twice is safe.' },
        openWorldHint: { type: 'boolean', description: 'True when the tool talks to the outside world.' },
      },
      ['toolName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolName = getStringArg(args, 'toolName');
        const annotations = parseAnnotations(args);
        if (Object.keys(annotations).length === 0) {
          return errorResult('Can it nhat 1 annotation (readOnlyHint/destructiveHint/idempotentHint/openWorldHint).');
        }
        const saved = scorer.registerAnnotations(toolName, annotations);
        return okResult({ toolName, annotations: saved, registeredTools: scorer.registeredTools() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toolCallGateTool: Tool = {
    definition: toolDef(
      'router_local_tool_call_gate',
      'Score a tool call and apply the confirmation policy in one step: LOW/MEDIUM calls under the threshold are auto-allowed; HIGH/UNKNOWN calls (or all calls under AlwaysConfirm) pause as WAITING_FOR_CONFIRMATION and return a pending id for router_local_confirm_decide.',
      {
        toolName: { type: 'string', description: 'Tool name, e.g. shell_exec, file_read.' },
        toolArgs: { type: 'object', description: 'Tool call arguments (optional).' },
        annotations: { type: 'object', description: 'Optional annotations for this call only.' },
        securityRisk: { type: 'string', description: 'Optional inline LLM self-assessment: LOW, MEDIUM, HIGH or UNKNOWN.' },
      },
      ['toolName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolName = getStringArg(args, 'toolName');
        const toolArgs = getOptionalObjectArg(args, 'toolArgs') ?? {};
        const securityRisk = getOptionalStringArg(args, 'securityRisk');
        const withInline = withInlineRisk(toolArgs, securityRisk);
        const inlineAnnotations = getOptionalObjectArg(args, 'annotations');
        const risk = inlineAnnotations !== undefined
          ? scoreToolCallRisk(toolName, parseAnnotations(inlineAnnotations), withInline)
          : scorer.score(toolName, withInline);
        const result = gate.submit(toolName, withInline, risk.risk, risk.score);
        return okResult({
          toolName,
          risk: risk.risk,
          score: risk.score,
          factors: risk.factors,
          inlineRisk: risk.inlineRisk,
          inlineAgrees: risk.inlineAgrees,
          suggestedAction: risk.suggestedAction,
          requiresConfirmation: result.requiresConfirmation,
          pendingId: result.pending?.id ?? null,
          pending: result.pending ?? null,
          reason: result.reason,
          policy: gate.getPolicy(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const confirmPolicyGetTool: Tool = {
    definition: toolDef(
      'router_local_confirm_policy_get',
      'Show the current confirmation policy (AlwaysConfirm / NeverConfirm / ConfirmRisky + threshold + TTL) and how many confirmations are waiting.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return okResult({
          policy: gate.getPolicy(),
          pendingCount: gate.pendingCount(),
          decisionsLogged: gate.getDecisionLog().length,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const confirmPolicySetTool: Tool = {
    definition: toolDef(
      'router_local_confirm_policy_set',
      'Set the confirmation policy. ConfirmRisky pauses only tool calls at or above threshold (default HIGH; UNKNOWN counts as HIGH, fail-closed).',
      {
        mode: { type: 'string', description: 'AlwaysConfirm, NeverConfirm or ConfirmRisky.' },
        threshold: { type: 'string', description: 'Risk threshold for ConfirmRisky: LOW, MEDIUM, HIGH or UNKNOWN (default HIGH).' },
        ttlMs: { type: 'number', description: 'How long a pending confirmation waits before expiring (ms, default 600000).' },
        maxPending: { type: 'number', description: 'Max pending confirmations at once (default 50).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const partial: Partial<ConfirmPolicy> = {};
        const mode = getOptionalStringArg(args, 'mode');
        if (mode !== undefined) {
          if (!CONFIRM_MODES.includes(mode)) {
            return errorResult(`mode phai la mot trong: ${CONFIRM_MODES.join(', ')}.`);
          }
          partial.mode = mode as ConfirmPolicyMode;
        }
        const threshold = getOptionalStringArg(args, 'threshold');
        if (threshold !== undefined) {
          if (!SECURITY_RISK_VALUES.includes(threshold)) {
            return errorResult(`threshold phai la mot trong: ${SECURITY_RISK_VALUES.join(', ')}.`);
          }
          partial.threshold = threshold as SecurityRisk;
        }
        if (args.ttlMs !== undefined) partial.ttlMs = getNumberArg(args, 'ttlMs');
        if (args.maxPending !== undefined) partial.maxPending = getNumberArg(args, 'maxPending');
        const policy = gate.setPolicy(partial);
        return okResult({ policy });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const confirmPendingTool: Tool = {
    definition: toolDef(
      'router_local_confirm_pending',
      'List tool calls waiting for user confirmation (WAITING_FOR_CONFIRMATION), oldest first. Pass id to fetch one pending request (including already decided ones). Expired pendings are swept first.',
      {
        id: { type: 'string', description: 'Pending confirmation id to fetch one entry.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        gate.sweepExpired();
        const id = getOptionalStringArg(args, 'id');
        if (id !== undefined) {
          const pending = gate.getPending(id);
          if (!pending) return errorResult(`Khong co yeu cau xac nhan nao co id "${id}".`);
          return okResult({ pending });
        }
        return okResult({ total: gate.pendingCount(), pending: gate.listPending() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const confirmDecideTool: Tool = {
    definition: toolDef(
      'router_local_confirm_decide',
      'Approve or reject a pending tool call (WAITING_FOR_CONFIRMATION). Approving unblocks the agent loop to run the tool; rejecting blocks it. The decision is logged for audit.',
      {
        id: { type: 'string', description: 'Pending confirmation id (e.g. confirm-1).' },
        decision: { type: 'string', description: 'approve or reject.' },
        by: { type: 'string', description: 'Who decided (default "user").' },
        reason: { type: 'string', description: 'Reason for a rejection (optional).' },
      },
      ['id', 'decision'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const id = getStringArg(args, 'id');
        const decision = getStringArg(args, 'decision');
        if (decision !== 'approve' && decision !== 'reject') {
          return errorResult('decision phai la "approve" hoac "reject".');
        }
        const by = getOptionalStringArg(args, 'by');
        const reason = getOptionalStringArg(args, 'reason');
        const pending = decision === 'approve'
          ? gate.approve(id, by)
          : gate.reject(id, by, reason);
        return okResult({ pending });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditLogTool: Tool = {
    definition: toolDef(
      'router_local_audit_log',
      'Merged audit log: routing decisions (why a model was chosen), risk scores (why a tool call scored what it did) and confirmation decisions (who approved/rejected what), newest first. Filter by kind: route, risk, confirm or all.',
      {
        kind: { type: 'string', description: 'route, risk, confirm or all (default all).' },
        limit: { type: 'number', description: 'Max entries to return (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const kind = getOptionalStringArg(args, 'kind') ?? 'all';
        if (!['route', 'risk', 'confirm', 'all'].includes(kind)) {
          return errorResult('kind phai la route, risk, confirm hoac all.');
        }
        const limit = getNumberArg(args, 'limit', false, 20);
        if (limit < 0) return errorResult('limit khong duoc am.');
        const entries: Array<Record<string, unknown>> = [];
        if (kind === 'route' || kind === 'all') {
          for (const d of router.getLogStore().list()) {
            entries.push({
              kind: 'route',
              at: d.decidedAt,
              id: d.id,
              summary: `${d.previousModelId} -> ${d.chosenModelId} (${d.direction}, difficulty ${d.difficulty})`,
              reasons: d.reasons,
              nodePath: d.nodePath,
            });
          }
        }
        if (kind === 'risk' || kind === 'all') {
          for (const r of scorer.getHistory()) {
            entries.push({
              kind: 'risk',
              at: r.scoredAt,
              id: r.id,
              summary: `${r.toolName}: ${r.risk}${r.score === null ? '' : ` (score ${r.score})`}`,
              factors: r.factors,
              inlineRisk: r.inlineRisk,
              inlineAgrees: r.inlineAgrees,
            });
          }
        }
        if (kind === 'confirm' || kind === 'all') {
          for (const c of gate.getDecisionLog()) {
            entries.push({
              kind: 'confirm',
              at: c.decidedAt,
              id: c.id,
              summary: `${c.toolName}: ${c.decision}${c.decidedBy ? ` by ${c.decidedBy}` : ''}`,
              pendingId: c.pendingId,
              risk: c.risk,
              reason: c.reason,
            });
          }
        }
        entries.sort((a, b) => (b.at as number) - (a.at as number));
        return okResult({ total: entries.length, entries: entries.slice(0, limit) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const midchatCostReportTool: Tool = {
    definition: toolDef(
      'router_local_midchat_cost_report',
      'Cost/savings report for mid-chat routing: tokens served per model, how many tokens ran on cheap/light models instead of always running the strong model, escalations vs de-escalations. Pass sessionId for one conversation, omit for the aggregate of all sessions.',
      {
        sessionId: { type: 'string', description: 'Conversation session id (optional — omit for all sessions).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const report = sessions.costReport(sessionId);
        return okResult({
          report,
          sessions: sessions.listSessions(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const riskCatalogTool: Tool = {
    definition: toolDef(
      'router_local_risk_catalog',
      'List the built-in annotation catalog for well-known tools (file_read, shell_exec, http_post, git_push, ...) that the risk scorer seeds by default, so hosts do not have to register them by hand.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const tools = scorer.catalogTools().map((toolName) => ({
          toolName,
          annotations: scorer.getAnnotations(toolName) ?? null,
        }));
        return okResult({
          total: tools.length,
          seeded: scorer.isBuiltinSeeded(),
          tools,
          note: 'Catalog la y kien bao thu — host co the ghi de bang router_local_risk_annotate.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const riskScoreBatchTool: Tool = {
    definition: toolDef(
      'router_local_risk_score_batch',
      'Score the security risk of many tool calls at once (max 32): each entry is {toolName, toolArgs?, annotations?, securityRisk?}. Returns the risk, score and factors per call.',
      {
        calls: { type: 'array', items: { type: 'object' }, description: 'Tool calls: [{toolName, toolArgs?, annotations?, securityRisk?}].' },
      },
      ['calls'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const raw = args.calls;
        if (!Array.isArray(raw)) throw new Error('Argument "calls" must be an array.');
        if (raw.length === 0) return errorResult('calls khong duoc rong.');
        if (raw.length > 32) return errorResult('Toi da 32 call moi lan goi.');
        const results = raw.map((item, index) => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error(`calls[${index}] phai la object.`);
          }
          const call = item as Record<string, unknown>;
          if (typeof call.toolName !== 'string' || call.toolName.trim() === '') {
            throw new Error(`calls[${index}].toolName phai la string khong rong.`);
          }
          const toolArgs = (call.toolArgs !== undefined && call.toolArgs !== null
            && typeof call.toolArgs === 'object' && !Array.isArray(call.toolArgs))
            ? call.toolArgs as Record<string, unknown>
            : {};
          const securityRisk = typeof call.securityRisk === 'string' ? call.securityRisk : undefined;
          const withInline = withInlineRisk(toolArgs, securityRisk);
          const inlineAnnotations = (call.annotations !== undefined && call.annotations !== null
            && typeof call.annotations === 'object' && !Array.isArray(call.annotations))
            ? call.annotations as Record<string, unknown>
            : undefined;
          const record = inlineAnnotations !== undefined
            ? scoreToolCallRisk(call.toolName, parseAnnotations(inlineAnnotations), withInline)
            : scorer.score(call.toolName, withInline);
          return {
            toolName: record.toolName,
            risk: record.risk,
            score: record.score,
            factors: record.factors,
            inlineRisk: record.inlineRisk,
            inlineAgrees: record.inlineAgrees,
            suggestedAction: record.suggestedAction,
          };
        });
        const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, UNKNOWN: 0 };
        for (const r of results) counts[r.risk] += 1;
        return okResult({ total: results.length, counts, results });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const confirmToolOverrideTool: Tool = {
    definition: toolDef(
      'router_local_confirm_tool_override',
      'Set or view a per-tool confirmation override: always (always pause this tool, even when LOW), never (never pause this trusted tool), default (use the global policy). Pass override to set, omit to just view.',
      {
        toolName: { type: 'string', description: 'Tool name, e.g. shell_exec.' },
        override: { type: 'string', description: 'always, never or default.' },
      },
      ['toolName'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolName = getStringArg(args, 'toolName');
        const override = getOptionalStringArg(args, 'override');
        if (override !== undefined) {
          if (!['always', 'never', 'default'].includes(override)) {
            return errorResult('override phai la always, never hoac default.');
          }
          gate.setToolOverride(toolName, override as ToolConfirmOverride);
        }
        return okResult({
          toolName,
          override: gate.getToolOverride(toolName),
          overrides: gate.listToolOverrides(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    midchatRouteTool,
    midchatPolicyGetTool,
    midchatPolicySetTool,
    midchatTreeSetTool,
    midchatTreeGetTool,
    riskScoreTool,
    riskAnnotateTool,
    toolCallGateTool,
    confirmPolicyGetTool,
    confirmPolicySetTool,
    confirmPendingTool,
    confirmDecideTool,
    auditLogTool,
    midchatCostReportTool,
    riskCatalogTool,
    riskScoreBatchTool,
    confirmToolOverrideTool,
  ];
}

/** Unbound placeholders for ALL_TOOLS (bound by createDefaultTools when wired). */
export const ROUTER_LOCAL_V117_TOOLS: Tool[] = createRouterLocalV117Tools();

/** Re-export huu ich cho test/host. */
export { defaultConfirmPolicy, defaultMidChatPolicy, parseInlineSecurityRisk, riskAtLeast };
