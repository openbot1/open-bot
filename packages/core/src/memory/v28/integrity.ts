/**
 * Memory v28 — integrity check (v1.44, Doi T1).
 *
 * Kiem tra tinh toan ven cua store v28 ma khong sua gi:
 *  1. Moi file block parse duoc frontmatter + hash trong
 *     frontmatter khop noi dung that (phat hien file bi sua
 *     tay ngoai git hoac ghi do).
 *  2. Khi co git: so version trong frontmatter khop so commit
 *     cham vao file (phat hien lich su lech).
 *  3. history.jsonl doc duoc, moi muc co du truong + hash khop.
 *  4. facts.jsonl doc duoc, khong co 2 snapshot cung id mau
 *     thuan thu tu (createdAt giam dan la bat thuong).
 *  5. ACL chi tro den block dang ton tai (khong tro block rac).
 *  6. Audit log + sleep state JSON doc duoc.
 *
 * Ket qua la bao cao (khong throw): `ok=false` khi co bat ky
 * check nao fail. Day la cong cu chan doan — khong tu sua
 * (sua tay bang git + rollback moi la duong chinh).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseV28BlockMeta } from './gitStore';
import type { V28Store } from './store';
import { hashContentV28, parseIsoV28 } from './types';

/** Mot muc kiem tra trong bao cao integrity. */
export interface V28IntegrityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Bao cao integrity. */
export interface V28IntegrityReport {
  ok: boolean;
  checkedAt: string;
  checks: V28IntegrityCheck[];
  errors: string[];
}

/** Ghi 1 muc check (kem ghi loi khi fail). */
function check(
  report: V28IntegrityReport,
  name: string,
  ok: boolean,
  detail: string,
): void {
  report.checks.push({ name, ok, detail });
  if (!ok) {
    report.ok = false;
    report.errors.push(`${name}: ${detail}`);
  }
}

/**
 * Chay toan bo check integrity tren store. Chi doc — khong
 * sua file nao.
 */
export function verifyV28Integrity(store: V28Store): V28IntegrityReport {
  const report: V28IntegrityReport = {
    ok: true,
    checkedAt: new Date().toISOString(),
    checks: [],
    errors: [],
  };
  const gitStore = store.gitStore;

  // 1. Block: parse + hash khop.
  const blocks = gitStore.listBlocks();
  let badHash = 0;
  let badMeta = 0;
  for (const meta of blocks) {
    const block = gitStore.readBlock(meta.label);
    if (!block) {
      badMeta += 1;
      continue;
    }
    const text = readFileSync(join(gitStore.blocksDir, `${meta.label}.md`), 'utf8');
    const parsed = parseV28BlockMeta(text, meta.label);
    if (!parsed) {
      badMeta += 1;
      continue;
    }
    if (parsed.hash !== hashContentV28(block.content) && parsed.hash !== '') {
      badHash += 1;
    }
    if (parsed.version !== meta.version) badMeta += 1;
  }
  check(report, 'blocks-parse', badMeta === 0, `${blocks.length} block, ${badMeta} meta lech`);
  check(report, 'blocks-hash', badHash === 0, `${blocks.length} block, ${badHash} hash khong khop noi dung`);

  // 2. Git: so commit cham vao file khong duoc it hon version (tru init).
  if (gitStore.gitAvailable()) {
    let mismatched = 0;
    for (const meta of blocks) {
      const history = gitStore.history(meta.label, 500);
      if (history.length < meta.version) mismatched += 1;
    }
    check(
      report,
      'git-history-count',
      mismatched === 0,
      `${blocks.length} block, ${mismatched} block co it commit hon version`,
    );
  } else {
    check(report, 'git-history-count', true, 'khong co git — bo qua check git (dung fallback JSONL)');
  }

  // 3. history.jsonl doc duoc + hash khop.
  const historyPath = gitStore.historyPath;
  if (existsSync(historyPath)) {
    let lines = 0;
    let badLines = 0;
    for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const entry = JSON.parse(line) as { label?: unknown; version?: unknown; hash?: unknown; content?: unknown };
        if (
          typeof entry.label !== 'string' ||
          typeof entry.version !== 'number' ||
          typeof entry.hash !== 'string' ||
          typeof entry.content !== 'string' ||
          entry.hash !== hashContentV28(entry.content)
        ) {
          badLines += 1;
        }
      } catch {
        badLines += 1;
      }
    }
    check(report, 'history-jsonl', badLines === 0, `${lines} muc, ${badLines} muc loi/lech hash`);
  } else {
    check(report, 'history-jsonl', true, 'chua co history.jsonl (store moi)');
  }

  // 4. facts.jsonl: doc duoc + thu tu snapshot theo id khong giam createdAt.
  const factsPath = store.facts.factsPath;
  if (existsSync(factsPath)) {
    let lines = 0;
    let badLines = 0;
    const lastCreated = new Map<string, number>();
    for (const line of readFileSync(factsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const fact = JSON.parse(line) as { id?: unknown; createdAt?: unknown; updatedAt?: unknown };
        if (typeof fact.id !== 'string' || typeof fact.createdAt !== 'string') {
          badLines += 1;
          continue;
        }
        const created = parseIsoV28(fact.createdAt);
        const prev = lastCreated.get(fact.id);
        if (created !== null && prev !== undefined && created < prev) badLines += 1;
        if (created !== null) lastCreated.set(fact.id, created);
      } catch {
        badLines += 1;
      }
    }
    check(report, 'facts-jsonl', badLines === 0, `${lines} snapshot, ${badLines} dong loi/thu tu bat thuong`);
  } else {
    check(report, 'facts-jsonl', true, 'chua co facts.jsonl (chua co fact)');
  }

  // 5. ACL chi tro block ton tai.
  const acl = store.shared.loadAcl();
  const labels = new Set(blocks.map((m) => m.label));
  const dangling = acl.filter((e) => !labels.has(e.label));
  check(
    report,
    'acl-targets',
    dangling.length === 0,
    `${acl.length} muc ACL, ${dangling.length} tro den block khong ton tai`,
  );

  // 6. Audit log + sleep state doc duoc.
  let auditBad = 0;
  const auditPath = join(gitStore.repoDir, 'audit.jsonl');
  if (existsSync(auditPath)) {
    for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line) as unknown;
      } catch {
        auditBad += 1;
      }
    }
  }
  check(report, 'audit-jsonl', auditBad === 0, `${auditBad} dong audit loi`);
  // Sleep state: loadSleepState nuot loi trong — kiem tra truc tiep
  // cau hinh dang giu trong RAM co du truong + kieu dung khong.
  const sleepConfig = store.sleep.config;
  const sleepOk =
    typeof sleepConfig.enabled === 'boolean' &&
    typeof sleepConfig.minIdleMinutes === 'number' &&
    sleepConfig.minIdleMinutes >= 1 &&
    typeof sleepConfig.maxFactsPerRun === 'number' &&
    sleepConfig.maxFactsPerRun >= 1 &&
    typeof sleepConfig.dedupeThreshold === 'number' &&
    sleepConfig.dedupeThreshold >= 0 &&
    sleepConfig.dedupeThreshold <= 1;
  check(report, 'sleep-config', sleepOk, sleepOk ? 'sleep config hop le' : 'sleep config thieu truong hoac sai kieu');


  return report;
}
