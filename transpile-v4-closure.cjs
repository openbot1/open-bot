/**
 * Transpile-only build of the Eval Harness v4 dependency closure
 * (low-memory alternative to `tsc -p` while other teams run full
 * builds). Seeds from packages/core/src/evalHarnessV4/*.ts and
 * follows RELATIVE imports recursively; package imports
 * (node:, tiktoken, ...) are left as require() calls.
 * Output: packages/core/dist/<same relative path>.js
 * No type checking — the real check is `tsc --noEmit`.
 */
const ts = require('/home/hatch/workspace/open-bot/node_modules/typescript');
const fs = require('node:fs');
const path = require('node:path');

const srcDir = '/home/hatch/workspace/open-bot-v144-t2/packages/core/src';
const outDir = '/home/hatch/workspace/open-bot-v144-t2/packages/core/dist';

const seeds = fs.readdirSync(path.join(srcDir, 'evalHarnessV4'))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => path.join(srcDir, 'evalHarnessV4', f));

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), base];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

const seen = new Set();
const queue = [...seeds];
const files = [];
const missing = [];
while (queue.length > 0) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  files.push(file);
  const text = fs.readFileSync(file, 'utf-8');
  const specs = new Set();
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|export\s+\*\s+from\s+)['"]([^'"]+)['"]/g)) {
    specs.add(m[1]);
  }
  for (const spec of specs) {
    const resolved = resolveImport(file, spec);
    if (resolved === null) {
      if (spec.startsWith('.')) missing.push(`${path.relative(srcDir, file)} -> ${spec}`);
      continue;
    }
    if (!seen.has(resolved)) queue.push(resolved);
  }
}

console.log(`closure files: ${files.length}`);
for (const m of missing.slice(0, 20)) console.log('UNRESOLVED', m);

let ok = 0;
const failed = [];
for (const file of files) {
  const rel = path.relative(srcDir, file);
  const out = path.join(outDir, rel.replace(/\.tsx?$/, '.js'));
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const result = ts.transpileModule(text, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      reportDiagnostics: true,
      fileName: file,
    });
    const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      failed.push(`${rel}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join(' | ')}`);
      continue;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, result.outputText, 'utf-8');
    ok += 1;
  } catch (err) {
    failed.push(`${rel}: ${err.message}`);
  }
}
console.log(`transpiled ok=${ok} fail=${failed.length}`);
for (const f of failed.slice(0, 20)) console.log('FAIL', f);
console.log('files:', files.map((f) => path.relative(srcDir, f)).sort().join(', '));
