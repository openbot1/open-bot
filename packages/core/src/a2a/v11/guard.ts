/**
 * A2A v1.0 multi-turn prompt-injection guard (v11 generation).
 *
 * Lesson from Palo Alto Unit 42 (31/10/2025): a malicious agent
 * reached over an A2A session can inject instructions across several
 * turns, leak the victim's system prompt / tool list / history, and
 * trigger unauthorised purchases. This module is the local defence:
 *
 *  1. SCAN — every inbound peer message is scanned, turn by turn,
 *     against instruction-injection patterns (imperatives aimed at
 *     the agent, fake system/user turns, "ignore previous
 *     instructions", credential / secret exfiltration requests,
 *     purchase / payment / send-money triggers, attempts to make the
 *     agent reveal its system prompt, tools, or history).
 *  2. SANITISE — suspicious spans are stripped or neutralised; the
 *     cleaned text is what downstream code ever sees. Nothing is
 *     silently dropped: every action is recorded in the verdict.
 *  3. QUARANTINE — a message that scores at/above the block
 *     threshold is rejected outright (never delivered to the model),
 *     and the peer's trust score drops. Repeated blocks suspend the
 *     peer (registry.ts enforces the suspension).
 *  4. SECRETS — outbound text is scanned for secret-shaped values
 *     (API keys, tokens, private keys, passwords) before it leaves
 *     for a peer; a hit blocks the send. The local system prompt,
 *     tool list, and history are NEVER serialised into a peer-bound
 *     payload — the guard has no API to do that on purpose.
 *  5. SENSITIVE ACTIONS — any peer-requested action that changes
 *     outside state (purchase, payment, send, delete, publish,
 *     grant access) is classified `needs-confirmation` and must be
 *     approved by the user; the guard never auto-approves.
 *
 * The guard is deliberately heuristic + deterministic (no model
 * calls): it must run on every message, fast, offline, and with the
 * same verdict every time for the same input.
 */

/** How bad a scanned message is. */
export type V11GuardDecision = 'allow' | 'sanitise' | 'block';

/** One suspicious span found in a message. */
export interface V11GuardFinding {
  /** Short code, e.g. `ignore-instructions`. */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** 1..10 — how strongly this pattern indicates an injection. */
  severity: number;
  /** The matched text (truncated, never a secret). */
  match?: string;
  /** Character offset of the match in the original text. */
  index?: number;
}

/** Verdict for one scanned message. */
export interface V11GuardVerdict {
  decision: V11GuardDecision;
  /** 0..100 — sum of finding severities, capped. */
  score: number;
  findings: V11GuardFinding[];
  /** Text safe to forward downstream (empty when blocked). */
  cleanedText: string;
  /** True when the message asks for a sensitive outside action. */
  needsConfirmation: boolean;
  /** Sensitive actions the message requests, if any. */
  sensitiveActions: V11SensitiveAction[];
  /** True when the message tries to exfiltrate secrets / internals. */
  exfiltrationAttempt: boolean;
}

/** Sensitive outside actions a peer may request. */
export type V11SensitiveAction =
  | 'purchase'
  | 'payment'
  | 'send-message'
  | 'send-email'
  | 'delete'
  | 'publish'
  | 'grant-access'
  | 'run-command'
  | 'share-secret';

/** Score at/above which a message is blocked outright. */
export const V11_GUARD_BLOCK_SCORE = 20;
/** Score at/above which a message is sanitised before delivery. */
export const V11_GUARD_SANITISE_SCORE = 8;

/** One injection pattern: regex + finding metadata. */
interface V11GuardPattern {
  code: string;
  message: string;
  severity: number;
  pattern: RegExp;
  sensitiveAction?: V11SensitiveAction;
  exfiltration?: boolean;
}

const V11_INJECTION_PATTERNS: V11GuardPattern[] = [
  {
    code: 'ignore-instructions',
    message: 'Tries to override prior instructions ("ignore previous instructions").',
    severity: 10,
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
  },
  {
    code: 'disregard-system',
    message: 'Tries to disregard the system prompt.',
    severity: 10,
    pattern: /disregard\s+(the\s+)?(system|your)\s+(prompt|instructions|message|role)/i,
  },
  {
    code: 'new-system-prompt',
    message: 'Tries to install a new system prompt / persona.',
    severity: 9,
    pattern: /you\s+are\s+now\s+(a|an|the)\s+/i,
  },
  {
    code: 'fake-system-turn',
    message: 'Fakes a system/developer turn inside peer text.',
    severity: 9,
    pattern: /(\[system\]|\[developer\]|system\s*:\s*|developer\s*:)/i,
  },
  {
    code: 'reveal-system-prompt',
    message: 'Asks for the system prompt or hidden instructions.',
    severity: 9,
    pattern: /(reveal|show|print|repeat|output|disclose|leak)\s+(your\s+)?(system\s+prompt|hidden\s+instructions?|initial\s+instructions?|developer\s+message)/i,
    exfiltration: true,
  },
  {
    code: 'reveal-tools',
    message: 'Asks for the internal tool list / capabilities.',
    severity: 7,
    pattern: /(list|show|reveal|describe)[\s\S]{0,80}?\b(tools?|functions?|capabilities|available\s+actions)\b/i,
    exfiltration: true,
  },
  {
    code: 'reveal-history',
    message: 'Asks for conversation history / prior turns.',
    severity: 7,
    pattern: /(show|send|forward|dump|paste|repeat)[\s\S]{0,80}?\b(conversation\s+history|chat\s+history|previous\s+(messages?|turns?)|full\s+transcript)\b/i,
    exfiltration: true,
  },
  {
    code: 'reveal-secrets',
    message: 'Asks for secrets, keys, tokens or passwords.',
    severity: 10,
    pattern: /((api[\s_-]?key|secret|password|access[\s_-]?token|private[\s_-]?key|auth[\s_-]?token|bearer[\s_-]?token|credentials?)[\s\S]{0,40}(show|send|share|paste|reveal|give|provide|leak|include)|(show|send|share|paste|reveal|give|provide|leak|include)[\s\S]{0,40}(api[\s_-]?key|secret|password|access[\s_-]?token|private[\s_-]?key|auth[\s_-]?token|bearer[\s_-]?token|credentials?))/i,
    exfiltration: true,
  },
  {
    code: 'jailbreak-roleplay',
    message: 'Jailbreak / roleplay framing ("pretend you have no rules").',
    severity: 8,
    pattern: /(pretend|act\s+as\s+if|roleplay|role-play)\b[\s\S]{0,60}(no\s+(rules|restrictions|limits)|unrestricted|without\s+(rules|limits)|do\s+anything)/i,
  },
  {
    code: 'instruction-override',
    message: 'Direct imperative aimed at the agent ("you must ...").',
    severity: 6,
    pattern: /\byou\s+must\s+(now\s+)?(do|run|execute|send|buy|pay|delete|share|reveal|ignore|forget)\b/i,
  },
  {
    code: 'purchase',
    message: 'Requests a purchase / order.',
    severity: 5,
    pattern: /\b(buy|purchase|order|checkout|add\s+to\s+cart)\b[\s\S]{0,80}/i,
    sensitiveAction: 'purchase',
  },
  {
    code: 'payment',
    message: 'Requests a payment / money transfer.',
    severity: 6,
    pattern: /\b(pay|payment|transfer|send\s+money|wire|venmo|paypal)\b[\s\S]{0,60}(\$|€|£|usd|eur|amount)/i,
    sensitiveAction: 'payment',
  },
  {
    code: 'send-message',
    message: 'Requests sending a message / email as the user.',
    severity: 5,
    pattern: /\b(send|email|message|dm|post)\b[\s\S]{0,40}\b(as\s+me|on\s+my\s+behalf|to\s+\S+@\S+|to\s+my\s+contacts?)\b/i,
    sensitiveAction: 'send-message',
  },
  {
    code: 'delete-data',
    message: 'Requests deleting data.',
    severity: 5,
    pattern: /\b(delete|remove|erase|wipe|drop)\b[\s\S]{0,40}\b(all|everything|database|files?|messages?|history)\b/i,
    sensitiveAction: 'delete',
  },
  {
    code: 'publish',
    message: 'Requests publishing content publicly.',
    severity: 4,
    pattern: /\b(publish|post\s+publicly|share\s+publicly|tweet)\b/i,
    sensitiveAction: 'publish',
  },
  {
    code: 'grant-access',
    message: 'Requests granting access / permissions.',
    severity: 6,
    pattern: /\b(grant|give|allow)\s+(me|us|the\s+agent)\s+(access|permission|admin|root|sudo)\b/i,
    sensitiveAction: 'grant-access',
  },
  {
    code: 'run-command',
    message: 'Requests running a shell / system command.',
    severity: 6,
    pattern: /\b(run|execute|exec)\b[\s\S]{0,30}\b(command|shell|script|rm\s+-rf|sudo|curl|wget)\b/i,
    sensitiveAction: 'run-command',
  },
  {
    code: 'hidden-instruction',
    message: 'Hidden instruction smuggled in markup / code fence / comment.',
    severity: 8,
    pattern: /(<!--[\s\S]{0,200}?-->|```[\s\S]{0,200}?(ignore|disregard|system)[\s\S]{0,200}?```)/i,
  },
  {
    code: 'base64-instruction',
    message: 'Long base64 blob that may hide an instruction payload.',
    severity: 5,
    pattern: /\b[A-Za-z0-9+/]{80,}={0,2}\b/,
  },
];

/** Secret-shaped values that must never leave for a peer. */
const V11_SECRET_PATTERNS: { code: string; pattern: RegExp }[] = [
  { code: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { code: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { code: 'github-token', pattern: /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { code: 'generic-api-key', pattern: /\b(api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/i },
  { code: 'private-key', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  { code: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'password-assignment', pattern: /\bpassword\s*[:=]\s*['"][^'"]{4,}['"]/i },
];

/**
 * Scan one inbound peer message. Pure + deterministic: same input,
 * same verdict, no model calls, no network.
 */
export function scanV11PeerMessage(text: string): V11GuardVerdict {
  const input = typeof text === 'string' ? text : '';
  const findings: V11GuardFinding[] = [];
  const sensitiveActions: V11SensitiveAction[] = [];
  let exfiltrationAttempt = false;

  for (const rule of V11_INJECTION_PATTERNS) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(input);
    if (!match) continue;
    findings.push({
      code: rule.code,
      message: rule.message,
      severity: rule.severity,
      match: match[0].slice(0, 120),
      index: match.index,
    });
    if (rule.sensitiveAction && !sensitiveActions.includes(rule.sensitiveAction)) {
      sensitiveActions.push(rule.sensitiveAction);
    }
    if (rule.exfiltration) exfiltrationAttempt = true;
  }

  const score = Math.min(
    100,
    findings.reduce((sum, f) => sum + f.severity, 0),
  );
  const needsConfirmation = sensitiveActions.length > 0;

  if (score >= V11_GUARD_BLOCK_SCORE) {
    return {
      decision: 'block',
      score,
      findings,
      cleanedText: '',
      needsConfirmation,
      sensitiveActions,
      exfiltrationAttempt,
    };
  }
  if (score >= V11_GUARD_SANITISE_SCORE) {
    return {
      decision: 'sanitise',
      score,
      findings,
      cleanedText: sanitiseV11PeerText(input, findings),
      needsConfirmation,
      sensitiveActions,
      exfiltrationAttempt,
    };
  }
  return {
    decision: 'allow',
    score,
    findings,
    cleanedText: input,
    needsConfirmation,
    sensitiveActions,
    exfiltrationAttempt,
  };
}

/**
 * Neutralise suspicious spans: replace each matched span with a
 * `[removed: <code>]` marker so the model sees that something was
 * taken out instead of silently reading a doctored sentence.
 */
export function sanitiseV11PeerText(text: string, findings: V11GuardFinding[]): string {
  let out = text;
  // Longest matches first so nested spans do not leave fragments.
  const sorted = [...findings]
    .filter((f) => f.match !== undefined)
    .sort((a, b) => (b.match?.length ?? 0) - (a.match?.length ?? 0));
  for (const finding of sorted) {
    if (!finding.match) continue;
    const idx = out.indexOf(finding.match);
    if (idx === -1) continue;
    out = `${out.slice(0, idx)}[removed: ${finding.code}]${out.slice(idx + finding.match.length)}`;
  }
  // Strip HTML comments entirely — a classic smuggling channel.
  out = out.replace(/<!--[\s\S]*?-->/g, '[removed: hidden-instruction]');
  return out;
}

/** True when outbound text contains a secret-shaped value. */
export interface V11SecretScan {
  blocked: boolean;
  codes: string[];
}

/** Scan outbound text for secrets. Blocks the send when any hit. */
export function scanV11OutboundText(text: string): V11SecretScan {
  const codes: string[] = [];
  for (const rule of V11_SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) codes.push(rule.code);
  }
  return { blocked: codes.length > 0, codes };
}

/**
 * Multi-turn session guard: tracks a whole A2A session, not just one
 * message. A single turn may look innocent while the SESSION is an
 * injection (Unit 42's multi-turn finding). The session score is the
 * running sum of per-turn scores; crossing the session threshold
 * blocks the session even when the latest turn alone would pass.
 */
export class V11SessionGuard {
  private readonly turns: { text: string; verdict: V11GuardVerdict }[] = [];
  private sessionScore = 0;
  private blocked = false;

  /** Session score at/above which the whole session is blocked. */
  static readonly SESSION_BLOCK_SCORE = 30;

  /** Scan one turn and update the session. */
  scanTurn(text: string): V11GuardVerdict {
    if (this.blocked) {
      return {
        decision: 'block',
        score: this.sessionScore,
        findings: [
          {
            code: 'session-blocked',
            message: 'Session already blocked by earlier turns.',
            severity: 10,
          },
        ],
        cleanedText: '',
        needsConfirmation: false,
        sensitiveActions: [],
        exfiltrationAttempt: false,
      };
    }
    const verdict = scanV11PeerMessage(text);
    this.turns.push({ text, verdict });
    this.sessionScore += verdict.score;
    if (
      verdict.decision === 'block' ||
      this.sessionScore >= V11SessionGuard.SESSION_BLOCK_SCORE
    ) {
      this.blocked = true;
      if (verdict.decision !== 'block') {
        return {
          ...verdict,
          decision: 'block',
          cleanedText: '',
          findings: [
            ...verdict.findings,
            {
              code: 'session-threshold',
              message: `Session injection score ${this.sessionScore} reached the block threshold ${V11SessionGuard.SESSION_BLOCK_SCORE}.`,
              severity: 10,
            },
          ],
        };
      }
    }
    return verdict;
  }

  get turnCount(): number {
    return this.turns.length;
  }

  get totalScore(): number {
    return this.sessionScore;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  /** History of per-turn verdicts (for audit, no raw secrets). */
  history(): { decision: V11GuardDecision; score: number; codes: string[] }[] {
    return this.turns.map((t) => ({
      decision: t.verdict.decision,
      score: t.verdict.score,
      codes: t.verdict.findings.map((f) => f.code),
    }));
  }

  reset(): void {
    this.turns.length = 0;
    this.sessionScore = 0;
    this.blocked = false;
  }
}
