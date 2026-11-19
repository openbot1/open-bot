/**
 * A2A v1.0 delegation (v11 generation) — the safe path to a peer.
 *
 * Delegating work to a peer agent goes through exactly one gate:
 *
 *   1. Registry check (registry.ts): peer registered + allowlisted +
 *      card valid + signature verified + not suspended/blocklisted.
 *   2. Guard scan (guard.ts): the outbound message is scanned for
 *      secrets; the peer's replies are scanned turn-by-turn by the
 *      server-side session guard (or here, when the peer is remote).
 *   3. Sensitive-action confirmation: when the peer's reply asks for
 *      a sensitive action (purchase, payment, send, delete, publish,
 *      grant access, run a command), the delegation PAUSES and waits
 *      for the user's explicit confirmation. The `confirm` callback
 *      is supplied by the host (UI prompt). No confirmation callback
 *      = every sensitive action is denied.
 *   4. Audit: every step is written to the audit log.
 *
 * A delegation that fails any gate returns a denial result — it never
 * throws for a policy reason, so callers can show the user why.
 */

import { V11A2aClient } from './client';
import { V11AuditLog } from './audit';
import { scanV11PeerMessage, type V11GuardVerdict, type V11SensitiveAction } from './guard';
import { V11PeerRegistry } from './registry';
import {
  V11A2aError,
  v11TextMessage,
  type V11Message,
  type V11SendResult,
  type V11Task,
} from './types';

/** What the user was asked to confirm, and what they decided. */
export interface V11ConfirmationRequest {
  peerId: string;
  taskId?: string;
  actions: V11SensitiveAction[];
  /** The peer's words that triggered the request (guard-cleaned). */
  summary: string;
}

/** Host-supplied confirmation prompt. Return true = user approved. */
export type V11ConfirmCallback = (request: V11ConfirmationRequest) => Promise<boolean> | boolean;

/** Options for one delegation. */
export interface V11DelegateOptions {
  peerId: string;
  message: V11Message;
  /** Stream instead of a single reply. Default false. */
  stream?: boolean;
  /** Confirmation prompt for sensitive actions. Default: deny all. */
  confirm?: V11ConfirmCallback;
  /** Client factory override (tests / custom transports). */
  clientFactory?: (peerId: string) => V11A2aClient;
}

/** Outcome of a delegation attempt. */
export type V11DelegateResult =
  | { allowed: true; peerId: string; result: V11SendResult; guard: V11GuardVerdict }
  | { allowed: false; peerId: string; reasons: string[]; guard?: V11GuardVerdict };

/** Default confirmation: deny everything (fail-closed). */
export function denyAllV11Confirmations(): boolean {
  return false;
}

/**
 * Delegate one message to an allowlisted, verified peer.
 *
 * The caller supplies a `clientFactory` that builds a connected
 * V11A2aClient for the peer (loopback in tests, HTTP in production).
 * When no factory is given, delegation is denied — the module never
 * invents a transport on its own.
 */
export async function delegateV11ToPeer(
  registry: V11PeerRegistry,
  options: V11DelegateOptions,
  audit?: V11AuditLog,
): Promise<V11DelegateResult> {
  const log = audit ?? registry.auditLog;
  const { peerId } = options;
  log.append('delegate.attempt', `Delegation attempt to ${peerId}`, { peerId });

  // Gate 1: registry + allowlist + card + signature.
  const check = registry.checkDelegation(peerId);
  if (!check.allowed) {
    registry.recordDelegationFailure(peerId);
    log.append('delegate.denied', `Delegation to ${peerId} denied: ${check.reasons.join('; ')}`, {
      peerId,
      data: { reasons: check.reasons },
    });
    return { allowed: false, peerId, reasons: check.reasons };
  }
  const peer = check.peer as NonNullable<typeof check.peer>;

  // Gate 2: outbound secret scan is enforced by the client itself,
  // but scan the reply here as well (defence in depth for remote
  // peers whose servers do not run our guard).
  if (!options.clientFactory) {
    const reasons = ['no client factory supplied — cannot reach peer'];
    log.append('delegate.denied', `Delegation to ${peerId} denied: ${reasons[0]}`, { peerId });
    return { allowed: false, peerId, reasons };
  }
  let client: V11A2aClient;
  try {
    client = options.clientFactory(peerId);
    await client.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    registry.recordDelegationFailure(peerId);
    log.append('delegate.denied', `Delegation to ${peerId} denied at connect: ${reason}`, { peerId });
    return { allowed: false, peerId, reasons: [`could not connect to peer: ${reason}`] };
  }

  let result: V11SendResult;
  try {
    if (options.stream) {
      const streamed = await client.sendStreamingMessage(options.message);
      result = streamed.result;
    } else {
      result = await client.sendMessage(options.message);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    registry.recordDelegationFailure(peerId);
    if (err instanceof V11A2aError) {
      registry.recordGuardBlock(peerId, `peer call failed with guard code ${err.code}`);
    }
    log.append('delegate.denied', `Delegation to ${peerId} failed: ${reason}`, { peerId });
    return { allowed: false, peerId, reasons: [`peer call failed: ${reason}`] };
  }

  // Gate 2 (reply side): scan what the peer sent back.
  const task: V11Task | undefined = result.kind === 'task' ? result.task : undefined;
  const replyText =
    result.kind === 'message'
      ? result.message.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('\n')
      : task?.lastMessage
        ? task.lastMessage.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('\n')
        : '';
  const guard = scanV11PeerMessage(replyText);
  if (guard.decision === 'block') {
    registry.recordGuardBlock(peerId, `peer reply blocked: ${guard.findings.map((f) => f.code).join(', ')}`);
    log.append('guard.block', `Peer ${peerId} reply blocked: ${guard.findings.map((f) => f.code).join(', ')}`, {
      peerId,
      taskId: task?.id,
      data: { score: guard.score, codes: guard.findings.map((f) => f.code) },
    });
    return {
      allowed: false,
      peerId,
      reasons: [`peer reply blocked by injection guard: ${guard.findings.map((f) => f.code).join(', ')}`],
      guard,
    };
  }
  if (guard.decision === 'sanitise') {
    log.append('guard.sanitise', `Peer ${peerId} reply sanitised`, {
      peerId,
      taskId: task?.id,
      data: { codes: guard.findings.map((f) => f.code) },
    });
  }

  // Gate 3: sensitive actions need the user's explicit confirmation.
  if (guard.needsConfirmation) {
    const confirm = options.confirm ?? denyAllV11Confirmations;
    log.append('confirm.requested', `Sensitive action requested by ${peerId}: ${guard.sensitiveActions.join(', ')}`, {
      peerId,
      taskId: task?.id,
      data: { actions: guard.sensitiveActions },
    });
    const approved = await confirm({
      peerId,
      ...(task ? { taskId: task.id } : {}),
      actions: guard.sensitiveActions,
      summary: guard.cleanedText.slice(0, 500),
    });
    if (!approved) {
      registry.recordDelegationFailure(peerId);
      log.append('confirm.denied', `User denied sensitive action from ${peerId}: ${guard.sensitiveActions.join(', ')}`, {
        peerId,
        taskId: task?.id,
      });
      return {
        allowed: false,
        peerId,
        reasons: [`sensitive action denied by user: ${guard.sensitiveActions.join(', ')}`],
        guard,
      };
    }
    log.append('confirm.approved', `User approved sensitive action from ${peerId}: ${guard.sensitiveActions.join(', ')}`, {
      peerId,
      taskId: task?.id,
    });
  }

  registry.recordDelegationSuccess(peerId);
  log.append('delegate.allowed', `Delegation to ${peerId} completed (task ${task?.id ?? 'direct message'})`, {
    peerId,
    taskId: task?.id,
  });
  void peer;
  return { allowed: true, peerId, result, guard };
}

/** Build a delegation message from plain text. */
export function v11DelegationMessage(text: string, contextId?: string): V11Message {
  return v11TextMessage('user', text, contextId ? { contextId } : {});
}
