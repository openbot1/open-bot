/**
 * Memory v28 — export/import bundle (v1.44, Doi T1).
 *
 * Bundle la thu muc portable de sao luu / chuyen memory v28
 * giua 2 may (khong can copy ca repo git):
 *   <bundle>/
 *     manifest.json   <- phien ban, thoi gian, so luong, hash SHA-256 tung file
 *     blocks/*.md     <- file block (frontmatter + body, giong trong git store)
 *     facts.json      <- mang fact bi-temporal (day du, ke ca da vo hieu)
 *     acl.json        <- mang ACL entry
 *
 * Export khong bao gom lich su git day du (chi snapshot hien
 * tai + toan bo fact) — de chuyen may nhanh; lich su chi tiet
 * van nam trong repo git goc. Import kiem tra hash manifest
 * truoc khi ghi: file nao lech hash thi bo qua + ghi loi, cac
 * file khac van nhap binh thuong. Block da co dung hash thi
 * bo qua; block da co khac hash thi ghi de thanh version moi
 * (qua git store — lich su cu van giu).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseV28Frontmatter, renderV28BlockFile } from './gitStore';
import type { V28Store } from './store';
import {
  errV28,
  hashContentV28,
  okV28,
  type V28AclEntry,
  type V28Fact,
  type V28Result,
} from './types';

/** Phien ban dinh dang bundle v28. */
export const V28_BUNDLE_VERSION = '28.0.0';

/** Ten file manifest trong bundle. */
export const V28_BUNDLE_MANIFEST = 'manifest.json';

/** Manifest cua bundle. */
export interface V28BundleManifest {
  version: string;
  exportedAt: string;
  blocks: number;
  facts: number;
  aclEntries: number;
  /** Hash SHA-256 theo duong dan tuong doi trong bundle. */
  files: Record<string, string>;
}

/** Ket qua export bundle. */
export interface V28BundleExportResult {
  dir: string;
  manifest: V28BundleManifest;
  blockFiles: string[];
}

/** Ket qua import bundle. */
export interface V28BundleImportResult {
  blocksImported: number;
  blocksSkipped: number;
  factsImported: number;
  factsSkipped: number;
  aclReplaced: boolean;
  errors: string[];
}

/** Ghi file text (tao thu muc cha neu can). */
function writeBundleFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/**
 * Xuat store v28 thanh bundle portable.
 *
 * Block duoc xuat o dang file Markdown co frontmatter (dung
 * lai renderV28BlockFile cua git store); fact + ACL xuat dang
 * JSON. Manifest ghi hash tung file de import kiem tra sau.
 */
export function exportV28Bundle(store: V28Store, outDir: string): V28Result<V28BundleExportResult> {
  const blocksDir = join(outDir, 'blocks');
  mkdirSync(blocksDir, { recursive: true });
  const files: Record<string, string> = {};
  const blockFiles: string[] = [];
  for (const meta of store.gitStore.listBlocks()) {
    const block = store.gitStore.readBlock(meta.label);
    if (!block) continue;
    const fileName = `${meta.label}.md`;
    const content = renderV28BlockFile(block.meta, block.content);
    writeBundleFile(join(blocksDir, fileName), content);
    files[`blocks/${fileName}`] = hashContentV28(content);
    blockFiles.push(fileName);
  }
  const facts = store.facts.exportFacts();
  const factsJson = `${JSON.stringify(facts, null, 2)}\n`;
  writeBundleFile(join(outDir, 'facts.json'), factsJson);
  files['facts.json'] = hashContentV28(factsJson);

  const acl = store.shared.loadAcl();
  const aclJson = `${JSON.stringify(acl, null, 2)}\n`;
  writeBundleFile(join(outDir, 'acl.json'), aclJson);
  files['acl.json'] = hashContentV28(aclJson);

  const manifest: V28BundleManifest = {
    version: V28_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    blocks: blockFiles.length,
    facts: facts.length,
    aclEntries: acl.length,
    files,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeBundleFile(join(outDir, V28_BUNDLE_MANIFEST), manifestJson);
  return okV28({ dir: outDir, manifest, blockFiles });
}

/** Doc + kiem tra manifest cua bundle (tra loi neu thieu/sai). */
export function readV28BundleManifest(bundleDir: string): V28Result<V28BundleManifest> {
  const manifestPath = join(bundleDir, V28_BUNDLE_MANIFEST);
  if (!existsSync(manifestPath)) {
    return errV28(`bundle "${bundleDir}" thieu ${V28_BUNDLE_MANIFEST}`);
  }
  let manifest: V28BundleManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as V28BundleManifest;
  } catch {
    return errV28(`manifest cua bundle "${bundleDir}" khong phai JSON hop le`);
  }
  if (manifest.version !== V28_BUNDLE_VERSION) {
    return errV28(`bundle version "${String(manifest.version)}" khong phai ${V28_BUNDLE_VERSION} — khong nhap`);
  }
  return okV28(manifest);
}

/**
 * Kiem tra tinh toan ven cua bundle: moi file trong manifest
 * phai ton tai va hash phai khop. Tra danh sach loi (rong =
 * bundle nguyen ven).
 */
export function verifyV28Bundle(bundleDir: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const manifestResult = readV28BundleManifest(bundleDir);
  if (!manifestResult.ok) return { ok: false, errors: [manifestResult.error] };
  const manifest = manifestResult.value;
  for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
    const fullPath = join(bundleDir, relPath);
    if (!existsSync(fullPath)) {
      errors.push(`thieu file trong bundle: ${relPath}`);
      continue;
    }
    const actual = hashContentV28(readFileSync(fullPath, 'utf8'));
    if (actual !== expectedHash) errors.push(`file lech hash: ${relPath}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Nhap bundle v28 vao store.
 *
 *  - Block: doc frontmatter + body; bo qua neu store da co
 *    dung hash; ghi de (version moi) neu khac hash.
 *  - Fact: chi them fact chua co id (importFacts cua fact store).
 *  - ACL: ghi de bang ACL cua bundle (khi bundle co acl.json).
 * File lech hash manifest thi bo qua + ghi loi, khong dung ca dot.
 */
export function importV28Bundle(
  store: V28Store,
  bundleDir: string,
  opts: { dryRun?: boolean; actor?: string } = {},
): V28Result<V28BundleImportResult> {
  const result: V28BundleImportResult = {
    blocksImported: 0,
    blocksSkipped: 0,
    factsImported: 0,
    factsSkipped: 0,
    aclReplaced: false,
    errors: [],
  };
  const manifestResult = readV28BundleManifest(bundleDir);
  if (!manifestResult.ok) return errV28(manifestResult.error);
  const manifest = manifestResult.value;
  const dryRun = opts.dryRun === true;

  const blocksDir = join(bundleDir, 'blocks');
  if (existsSync(blocksDir)) {
    for (const file of readdirSync(blocksDir)) {
      if (!file.endsWith('.md')) continue;
      const relPath = `blocks/${file}`;
      const fullPath = join(blocksDir, file);
      const text = readFileSync(fullPath, 'utf8');
      const expectedHash = manifest.files[relPath];
      if (expectedHash && hashContentV28(text) !== expectedHash) {
        result.blocksSkipped += 1;
        result.errors.push(`block "${file}" lech hash manifest — bo qua.`);
        continue;
      }
      const label = basename(file, '.md');
      const { data, body } = parseV28Frontmatter(text);
      const content = body.replace(/\n$/, '');
      const existing = store.gitStore.readBlock(label);
      if (existing && hashContentV28(existing.content) === hashContentV28(content)) {
        result.blocksSkipped += 1;
        continue;
      }
      if (dryRun) {
        result.blocksImported += 1;
        continue;
      }
      const written = store.gitStore.writeBlock(label, content, {
        kind: 'custom',
        description: typeof data.description === 'string' ? data.description : '',
        scope: 'user',
        actor: opts.actor ?? 'system',
        message: `import bundle v28 from ${bundleDir}`,
        ownerBotId: typeof data.ownerBotId === 'string' ? data.ownerBotId : '',
      });
      if (written.ok) result.blocksImported += 1;
      else {
        result.blocksSkipped += 1;
        result.errors.push(`block "${label}" loi: ${written.error}`);
      }
    }
  }

  const factsPath = join(bundleDir, 'facts.json');
  if (existsSync(factsPath)) {
    let facts: V28Fact[];
    try {
      facts = JSON.parse(readFileSync(factsPath, 'utf8')) as V28Fact[];
    } catch {
      result.errors.push('facts.json khong phai JSON hop le — bo qua fact.');
      facts = [];
    }
    if (Array.isArray(facts)) {
      if (dryRun) {
        const known = new Set(store.facts.all().map((f) => f.id));
        for (const fact of facts) {
          if (fact && typeof fact.id === 'string' && !known.has(fact.id)) result.factsImported += 1;
          else result.factsSkipped += 1;
        }
      } else {
        const imported = store.facts.importFacts(facts);
        result.factsImported = imported.imported;
        result.factsSkipped = imported.skipped;
      }
    }
  }

  const aclPath = join(bundleDir, 'acl.json');
  if (existsSync(aclPath)) {
    try {
      const acl = JSON.parse(readFileSync(aclPath, 'utf8')) as V28AclEntry[];
      if (Array.isArray(acl)) {
        if (!dryRun) {
          store.shared.saveAcl(acl);
          result.aclReplaced = true;
        } else {
          result.aclReplaced = acl.length > 0;
        }
      }
    } catch {
      result.errors.push('acl.json khong phai JSON hop le — giu ACL hien tai.');
    }
  }
  return okV28(result);
}
