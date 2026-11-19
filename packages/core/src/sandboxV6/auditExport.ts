/**
 * Sandbox v6 — audit export + verification (v1.38, Team T3).
 *
 * The audit log lives in one JSONL file per bot, plus rotated
 * files when it grows. Export bundles a bot's whole audit
 * history — live log + rotated logs, oldest first — into one
 * document for review, backup or handoff:
 *
 *  - `exportSandboxV6Audit()` returns the entries plus a
 *    verification verdict (hash chain OK / broken at seq N,
 *    and any entry whose sequence is missing).
 *  - `verifySandboxV6AuditFiles()` checks a set of files
 *    without loading them into the service (used by the
 *    export and by tests).
 *  - `renderSandboxV6AuditMarkdown()` renders a bundle as a
 *    readable table (command, bot, time, exit, duration).
 *
 * Export never includes secret values: entries are already
 * scrubbed at write time, and the exporter re-scrubs with
 * the store's current values as a second pass (a value that
 * was registered after an entry was written is still caught).
 * Exported entries are a *copy* — the live log is never
 * modified by an export.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSandboxV6AuditFile, scrubSandboxV6Secrets, verifySandboxV6AuditChain } from './execAudit';
import type { SandboxV6AuditEntry } from './types';
import { formatSandboxV6Duration } from './types';

/** One bot's exported audit history. */
export interface SandboxV6AuditExport {
  botId: string;
  /** Files the export was read from (oldest first). */
  files: string[];
  entries: SandboxV6AuditEntry[];
  /** True when every file's chain verifies and sequences are continuous. */
  chainOk: boolean;
  /** Sequence numbers that failed verification. */
  brokenAt: number[];
  /** Sequence numbers missing from the history (gap = lost or rotated-away entries). */
  missingSeq: number[];
  exportedAtMs: number;
}

/**
 * Read + verify a set of audit files (oldest first) and merge
 * them into one ordered history. Missing files are skipped;
 * corrupt lines are skipped by the reader (the chain check
 * flags the resulting gap).
 */
export function verifySandboxV6AuditFiles(
  botId: string,
  files: string[],
  opts: { scrubSecrets?: string[] } = {},
): SandboxV6AuditExport {
  const entries: SandboxV6AuditEntry[] = [];
  const readFiles: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    readFiles.push(file);
    for (const entry of readSandboxV6AuditFile(file)) {
      if (entry.botId !== botId) continue;
      entries.push(entry);
    }
  }
  // Order by (startedAtMs, seq) — rotated files are older,
  // but entries carry their own sequence, so sort to be sure.
  entries.sort((a, b) => a.startedAtMs - b.startedAtMs || a.seq - b.seq);
  const scrubbed =
    opts.scrubSecrets !== undefined && opts.scrubSecrets.length > 0
      ? entries.map((e) => ({
          ...e,
          command: scrubSandboxV6Secrets(e.command, opts.scrubSecrets ?? []),
          args: e.args.map((a) => scrubSandboxV6Secrets(a, opts.scrubSecrets ?? [])),
          detail: scrubSandboxV6Secrets(e.detail, opts.scrubSecrets ?? []),
        }))
      : entries;
  // Verify the chain PER FILE: rotation restarts the sequence
  // at 1 with an empty prevHash, so a merged check would flag
  // every rotation boundary as broken. Gaps are likewise
  // detected per file, not across files.
  const brokenAt: number[] = [];
  const missingSeq: number[] = [];
  for (const file of readFiles) {
    const fileEntries = readSandboxV6AuditFile(file)
      .filter((e) => e.botId === botId)
      .sort((a, b) => a.seq - b.seq);
    for (const seq of verifySandboxV6AuditChain(fileEntries)) {
      brokenAt.push(seq);
    }
    for (let i = 1; i < fileEntries.length; i += 1) {
      const prev = fileEntries[i - 1];
      const cur = fileEntries[i];
      if (prev === undefined || cur === undefined) continue;
      if (cur.seq !== prev.seq + 1) {
        for (let s = prev.seq + 1; s < cur.seq; s += 1) missingSeq.push(s);
      }
    }
  }
  return {
    botId,
    files: readFiles,
    entries: scrubbed,
    chainOk: brokenAt.length === 0 && missingSeq.length === 0,
    brokenAt,
    missingSeq,
    exportedAtMs: Date.now(),
  };
}

/** List a bot's audit files (rotated first, then the live log) from a bot dir. */
export function sandboxV6AuditFilesForBot(botDir: string): string[] {
  const auditDir = path.join(botDir, 'audit');
  let names: string[] = [];
  try {
    names = fs.readdirSync(auditDir);
  } catch {
    return [];
  }
  const rotated = names
    .filter((n) => n.startsWith('audit-') && n.endsWith('.jsonl'))
    .sort()
    .map((n) => path.join(auditDir, n));
  const live = path.join(auditDir, 'audit.jsonl');
  return fs.existsSync(live) ? [...rotated, live] : rotated;
}

/** Render an audit export as markdown (table, newest last). */
export function renderSandboxV6AuditMarkdown(bundle: SandboxV6AuditExport): string {
  const lines: string[] = [];
  lines.push(`# Sandbox v6 audit export — bot \`${bundle.botId}\``);
  lines.push('');
  lines.push(`- Files: ${bundle.files.length} — entries: ${bundle.entries.length} — exported: ${new Date(bundle.exportedAtMs).toISOString()}`);
  lines.push(
    `- Hash chain: ${bundle.chainOk ? 'OK' : `BROKEN at seq ${bundle.brokenAt.join(', ') || '—'}; missing seq ${bundle.missingSeq.join(', ') || 'none'}`}`,
  );
  lines.push('');
  if (bundle.entries.length === 0) {
    lines.push('No audit entries.');
    return lines.join('\n');
  }
  lines.push('| seq | time | kind | command | exit | duration | detail |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const e of bundle.entries) {
    const cmd = e.command !== '' ? `\`${e.command}${e.args.length > 0 ? ` ${e.args.join(' ')}` : ''}\`` : '—';
    const detail = e.detail.replace(/\|/g, '\\|').slice(0, 200);
    lines.push(
      `| ${e.seq} | ${new Date(e.startedAtMs).toISOString()} | ${e.kind} | ${cmd} | ` +
        `${e.exitCode ?? '—'} | ${formatSandboxV6Duration(e.durationMs)} | ${detail} |`,
    );
  }
  return lines.join('\n');
}

/** Render an audit export as JSON (entries + verification). */
export function renderSandboxV6AuditJson(bundle: SandboxV6AuditExport): string {
  return JSON.stringify(bundle, null, 2);
}
