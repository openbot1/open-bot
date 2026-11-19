/**
 * Transpile-only build of packages/core/src -> packages/core/dist.
 * Low-memory alternative to `tsc -p` (which OOMs when other teams
 * run full builds concurrently): strips types file-by-file with
 * transpileModule, no type checking, no program-wide analysis.
 * Use ONLY to get a runnable dist for node --test; the real
 * typecheck is still `tsc --noEmit -p packages/core/tsconfig.json`.
 */
const ts = require('/home/hatch/workspace/open-bot/node_modules/typescript');
const fs = require('node:fs');
const path = require('node:path');

const srcDir = '/home/hatch/workspace/open-bot-v144-t2/packages/core/src';
const outDir = '/home/hatch/workspace/open-bot-v144-t2/packages/core/dist';

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  skipLibCheck: true,
};

let ok = 0;
let fail = 0;
const failed = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      const rel = path.relative(srcDir, full);
      const out = path.join(outDir, rel.replace(/\.tsx?$/, '.js'));
      try {
        const text = fs.readFileSync(full, 'utf-8');
        const result = ts.transpileModule(text, {
          compilerOptions,
          reportDiagnostics: true,
          fileName: full,
        });
        const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
        if (errors.length > 0) {
          fail += 1;
          failed.push(`${rel}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join(' | ')}`);
          continue;
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, result.outputText, 'utf-8');
        ok += 1;
      } catch (err) {
        fail += 1;
        failed.push(`${rel}: ${err.message}`);
      }
    }
  }
}

walk(srcDir);
console.log(`transpiled ok=${ok} fail=${fail}`);
for (const f of failed.slice(0, 20)) console.log('FAIL', f);
