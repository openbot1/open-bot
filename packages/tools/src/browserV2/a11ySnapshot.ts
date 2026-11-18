/**
 * Accessibility-tree snapshot — perception chính của browser driver v2
 * (v1.33, Đội T4).
 *
 * Ý tưởng học từ survey v133 (Playwright MCP / browser-use / Stagehand):
 * snapshot a11y-tree rẻ, tất định, không cần vision model — model đọc
 * role/name/value + ref đánh số rồi ra lệnh bằng ref, thay vì đoán CSS
 * selector hay tọa độ pixel. Chỉ khi element không có trong tree (không
 * có role ARIA — canvas, SVG thuần, div vẽ bằng CSS) mới fallback sang
 * screenshot + tọa độ (xem `visionFallback.ts`).
 *
 * Định dạng snapshot: đúng định dạng `page.locator('body').ariaSnapshot()`
 * của Playwright (một node một dòng, con thụt 2 space so với cha):
 *
 * ```
 * - heading "Welcome" [level=1]
 * - textbox "Search" [ref=e2]
 * - button "Submit" [ref=e3] [disabled]
 * - generic [ref=e4]:
 *   - text: Hello world
 * ```
 *
 * Module này KHÔNG gọi Playwright — nó parse/serialize/diff văn bản
 * snapshot nên test được hoàn toàn bằng fixture chuỗi, không cần browser
 * thật. Driver thật (xem `driverV2.ts`) chỉ việc đưa chuỗi snapshot thô
 * từ Playwright vào đây.
 *
 * Quy ước ref: `e1`, `e2`, ... theo thứ tự duyệt DFS. Ref do Playwright
 * cấp được giữ nguyên khi parse; node thiếu ref được cấp ref ổn định
 * theo vị trí (`auto-<path>`) để diff theo ref vẫn hoạt động.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Trạng thái checkbox/radio ba trạng thái của ARIA. */
export type A11yChecked = boolean | 'mixed';

/** Một node trong accessibility tree. */
export interface A11yNode {
  /** Ref đánh số (`e1`, `e2`, ...) — định danh ổn định để model ra lệnh. */
  ref: string;
  /** ARIA role: button, textbox, link, heading, generic, text, img, ... */
  role: string;
  /** Accessible name (nhãn đọc được, đã unquote). */
  name: string;
  /** Giá trị hiện tại (textbox, spinbutton, slider...). */
  value?: string;
  /** Placeholder của input (nếu có). */
  placeholder?: string;
  /** Node bị vô hiệu hoá. */
  disabled?: boolean;
  /** Trạng thái checked (checkbox/radio). */
  checked?: A11yChecked;
  /** Trạng thái selected (option/tab/treeitem). */
  selected?: boolean;
  /** Trạng thái expanded (treeitem/button có popup). */
  expanded?: boolean;
  /** Node đang active (tab/link hiện tại). */
  active?: boolean;
  /** Cấp heading (level=1..6). */
  level?: number;
  /** URL đích (link). */
  url?: string;
  /** Node con (thứ tự DOM). */
  children: A11yNode[];
}

/** Một node đã làm phẳng kèm đường dẫn ref của cha (dùng cho diff/tìm). */
export interface FlatA11yNode {
  node: A11yNode;
  /** Đường dẫn từ gốc, vd `e1/e4/e7`. */
  path: string;
  /** Độ sâu (gốc = 0). */
  depth: number;
}

/** Kết quả diff giữa hai snapshot liên tiếp. */
export interface SnapshotDiff {
  /** Node mới xuất hiện (kèm subtree đã serialize). */
  added: A11yNode[];
  /** Node biến mất (chỉ giữ ref + role + name để model biết). */
  removed: A11yNode[];
  /** Node còn ref nhưng role/name/value/state đổi. */
  changed: Array<{ before: A11yNode; after: A11yNode; fields: string[] }>;
  /** Số node không đổi (để tính tỉ lệ thay đổi). */
  unchangedCount: number;
  /** Tổng node ở snapshot mới. */
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Parser — aria snapshot text -> A11yNode[]
// ---------------------------------------------------------------------------

/**
 * Parse một dòng snapshot Playwright.
 *
 * Chấp nhận các dạng:
 * - `- button "Submit" [ref=e3] [disabled]`
 * - `- heading "Title" [level=1]`
 * - `- textbox "Search" [ref=e2] [value="hello"]`
 * - `- checkbox "Accept" [checked] [ref=e9]`
 * - `- text: Hello world`
 * - `- generic [ref=e4]:` (mở block con)
 * - `- link "Home" [ref=e5] [href=/x]` (Playwright không in href;
 *   parser vẫn nhận nếu có)
 * - `- textbox "Name" [active] [ref=e4]: hello` (Playwright mode ai:
 *   giá trị hiện tại nằm sau dấu `:` cuối — parser tách thành `value`)
 */
export interface ParsedSnapshotLine {
  depth: number;
  node: A11yNode;
  /** true khi dòng kết thúc bằng `:` (mở block con). */
  opensBlock: boolean;
}

/** Tách các `[attr]` / `[attr=value]` ở cuối dòng; trả về phần còn lại + attrs. */
function splitAttrs(line: string): { head: string; attrs: Record<string, string | true> } {
  const attrs: Record<string, string | true> = {};
  let head = line;
  // Các attr luôn nằm ở cuối dòng (sau role/name); cắt dần từ phải sang.
  for (;;) {
    const m = head.match(/\[([^\]]+)\]\s*:?\s*$/);
    if (!m) break;
    const inner = m[1];
    const eq = inner.indexOf('=');
    if (eq === -1) {
      attrs[inner.trim()] = true;
    } else {
      const key = inner.slice(0, eq).trim();
      let val = inner.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      attrs[key] = val;
    }
    head = head.slice(0, m.index).trimEnd();
  }
  return { head, attrs };
}

function unquote(text: string): string {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse một dòng (đã bỏ indent) thành node; `depth` tính từ số space. */
export function parseSnapshotLine(rawLine: string): ParsedSnapshotLine | null {
  const indentMatch = rawLine.match(/^( *)- /);
  if (!indentMatch) return null;
  const depth = Math.floor(indentMatch[1].length / 2);
  let rest = rawLine.slice(indentMatch[0].length);
  const opensBlock = rest.endsWith(':');
  if (opensBlock) rest = rest.slice(0, -1).trimEnd();
  // Playwright mode ai: giá trị inline sau dấu `:` cuối
  // (`- textbox "Name" [active] [ref=e4]: hello`) — tách ra trước khi
  // parse attr (dòng kết thúc bằng `:` trơn đã xử lý ở opensBlock).
  let inlineValue: string | undefined;
  const colonValue = rest.match(/^(.*\]): (.+)$/);
  if (colonValue) {
    rest = colonValue[1];
    inlineValue = colonValue[2];
  }
  const { head, attrs } = splitAttrs(rest);

  // Dạng text thuần: `- text: Hello world` (không có role/name kiểu khác).
  const textMatch = head.match(/^text:\s?(.*)$/);
  if (textMatch) {
    const ref = typeof attrs['ref'] === 'string' ? (attrs['ref'] as string) : '';
    return {
      depth,
      opensBlock,
      node: {
        ref,
        role: 'text',
        name: unquote(textMatch[1]),
        children: [],
      },
    };
  }

  // Dạng thường: `role "name"` hoặc `role` (không name).
  const roleMatch = head.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/);
  if (!roleMatch) return null;
  const role = roleMatch[1];
  const name = unquote(roleMatch[2] ?? '');
  const ref = typeof attrs['ref'] === 'string' ? (attrs['ref'] as string) : '';
  const node: A11yNode = { ref, role, name, children: [] };
  if (inlineValue !== undefined) node.value = inlineValue;
  if (typeof attrs['value'] === 'string') node.value = attrs['value'] as string;
  if (typeof attrs['placeholder'] === 'string') node.placeholder = attrs['placeholder'] as string;
  if (typeof attrs['href'] === 'string') node.url = attrs['href'] as string;
  if (typeof attrs['url'] === 'string') node.url = attrs['url'] as string;
  if (attrs['disabled'] === true) node.disabled = true;
  if (attrs['checked'] === true) node.checked = true;
  if (attrs['checked'] === 'mixed') node.checked = 'mixed';
  if (attrs['checked'] === 'false') node.checked = false;
  if (attrs['selected'] === true) node.selected = true;
  if (attrs['expanded'] === true) node.expanded = true;
  if (attrs['active'] === true) node.active = true;
  if (typeof attrs['level'] === 'string') {
    const n = Number(attrs['level']);
    if (Number.isInteger(n) && n > 0) node.level = n;
  }
  return { depth, opensBlock, node };
}

/**
 * Parse toàn bộ snapshot text thành cây. Dòng trống và dòng không khớp
 * định dạng được bỏ qua (Playwright có thể in thêm dòng chú thích).
 * Node thiếu ref được cấp ref ổn định `auto-<depth>-<index>`.
 */
export function parseAriaSnapshot(text: string): A11yNode[] {
  const roots: A11yNode[] = [];
  // Stack: [depth, node] của các tổ tiên đang mở.
  const stack: Array<{ depth: number; node: A11yNode }> = [];
  let autoCounter = 0;
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue;
    const parsed = parseSnapshotLine(rawLine);
    if (!parsed) continue;
    const { depth, node } = parsed;
    if (!node.ref) {
      autoCounter += 1;
      node.ref = `auto-${depth}-${autoCounter}`;
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ depth, node });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Serializer — A11yNode[] -> snapshot text (định dạng Playwright)
// ---------------------------------------------------------------------------

function escapeName(name: string): string {
  // Tên chứa dấu `"` hoặc xuống dòng thì quote bằng dấu nháy đơn.
  if (name.includes('"') || name.includes('\n')) {
    return `'${name.replace(/'/g, "\\'")}'`;
  }
  return `"${name}"`;
}

function serializeNode(node: A11yNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  let line = `${indent}- ${node.role}`;
  if (node.role === 'text') {
    line += `: ${node.name}`;
  } else if (node.name) {
    line += ` ${escapeName(node.name)}`;
  }
  if (node.level !== undefined) line += ` [level=${node.level}]`;
  if (node.value !== undefined) line += ` [value=${escapeName(node.value)}]`;
  if (node.placeholder !== undefined) line += ` [placeholder=${escapeName(node.placeholder)}]`;
  if (node.url !== undefined) line += ` [href=${node.url}]`;
  if (node.disabled) line += ' [disabled]';
  if (node.checked === true) line += ' [checked]';
  if (node.checked === 'mixed') line += ' [checked=mixed]';
  if (node.checked === false) line += ' [checked=false]';
  if (node.selected) line += ' [selected]';
  if (node.expanded) line += ' [expanded]';
  if (node.active) line += ' [active]';
  if (node.ref) line += ` [ref=${node.ref}]`;
  if (node.children.length > 0) line += ':';
  lines.push(line);
  for (const child of node.children) serializeNode(child, depth + 1, lines);
}

/** Serialize cây thành snapshot text (round-trip với parser). */
export function serializeAriaSnapshot(nodes: A11yNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) serializeNode(node, 0, lines);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ref numbering / traversal
// ---------------------------------------------------------------------------

/** Cấp lại ref `e1..eN` theo thứ tự DFS (tất định, ổn định qua các step nếu cây không đổi). */
export function assignRefs(nodes: A11yNode[]): A11yNode[] {
  let counter = 0;
  const walk = (list: A11yNode[]): A11yNode[] =>
    list.map((n) => {
      counter += 1;
      return { ...n, ref: `e${counter}`, children: walk(n.children) };
    });
  return walk(nodes);
}

/** Làm phẳng cây theo DFS, kèm path + depth. */
export function flattenSnapshot(nodes: A11yNode[]): FlatA11yNode[] {
  const out: FlatA11yNode[] = [];
  const walk = (list: A11yNode[], parentPath: string, depth: number): void => {
    for (const node of list) {
      const path = parentPath ? `${parentPath}/${node.ref}` : node.ref;
      out.push({ node, path, depth });
      walk(node.children, path, depth + 1);
    }
  };
  walk(nodes, '', 0);
  return out;
}

/** Tìm node theo ref (DFS). null khi không có — caller fallback vision. */
export function findNodeByRef(nodes: A11yNode[], ref: string): A11yNode | null {
  for (const flat of flattenSnapshot(nodes)) {
    if (flat.node.ref === ref) return flat.node;
  }
  return null;
}

/** Đếm node trong cây (kể cả text). */
export function countNodes(nodes: A11yNode[]): number {
  return flattenSnapshot(nodes).length;
}

/** Chỉ giữ các node tương tác được (click/type/select) — rút gọn cho model. */
export function interactiveNodes(nodes: A11yNode[]): A11yNode[] {
  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'spinbutton',
    'slider',
    'switch',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'treeitem',
    'option',
    'searchbox',
  ]);
  const out: A11yNode[] = [];
  for (const flat of flattenSnapshot(nodes)) {
    if (INTERACTIVE.has(flat.node.role)) out.push(flat.node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff — chỉ gửi phần đổi về model
// ---------------------------------------------------------------------------

function nodeSignature(n: A11yNode): string {
  return [
    n.role,
    n.name,
    n.value ?? '',
    n.placeholder ?? '',
    n.url ?? '',
    n.disabled ? 'disabled' : '',
    n.checked === undefined ? '' : `checked=${String(n.checked)}`,
    n.selected ? 'selected' : '',
    n.expanded ? 'expanded' : '',
    n.active ? 'active' : '',
    n.level === undefined ? '' : `level=${n.level}`,
  ].join('|');
}

function changedFields(before: A11yNode, after: A11yNode): string[] {
  const fields: string[] = [];
  if (before.role !== after.role) fields.push('role');
  if (before.name !== after.name) fields.push('name');
  if (before.value !== after.value) fields.push('value');
  if (before.placeholder !== after.placeholder) fields.push('placeholder');
  if (before.url !== after.url) fields.push('url');
  if (before.disabled !== after.disabled) fields.push('disabled');
  if (before.checked !== after.checked) fields.push('checked');
  if (before.selected !== after.selected) fields.push('selected');
  if (before.expanded !== after.expanded) fields.push('expanded');
  if (before.active !== after.active) fields.push('active');
  if (before.level !== after.level) fields.push('level');
  return fields;
}

/**
 * Diff hai snapshot (so theo ref). Node đổi cha nhưng giữ ref được coi
 * là unchanged (ref ổn định theo Playwright). Node `auto-*` không có
 * ref thật nên diff theo vị trí: chúng được so bằng signature tại cùng
 * path — xử lý trong `diffSnapshotsByPath` khi cần; ở đây auto-ref
 * khác nhau giữa hai lần parse sẽ tính là added+removed (an toàn:
 * model nhận đủ thông tin, chỉ tốn thêm token).
 */
export function diffSnapshots(prev: A11yNode[], next: A11yNode[]): SnapshotDiff {
  const prevFlat = flattenSnapshot(prev);
  const nextFlat = flattenSnapshot(next);
  const prevByRef = new Map(prevFlat.map((f) => [f.node.ref, f.node]));
  const nextByRef = new Map(nextFlat.map((f) => [f.node.ref, f.node]));
  const added: A11yNode[] = [];
  const removed: A11yNode[] = [];
  const changed: SnapshotDiff['changed'] = [];
  let unchangedCount = 0;
  for (const f of nextFlat) {
    const old = prevByRef.get(f.node.ref);
    if (!old) {
      added.push(f.node);
      continue;
    }
    if (nodeSignature(old) === nodeSignature(f.node)) {
      unchangedCount += 1;
    } else {
      changed.push({ before: old, after: f.node, fields: changedFields(old, f.node) });
    }
  }
  for (const f of prevFlat) {
    if (!nextByRef.has(f.node.ref)) removed.push(f.node);
  }
  return { added, removed, changed, unchangedCount, totalCount: nextFlat.length };
}

/** Render diff thành text ngắn gọn gửi về model (thay cho full snapshot). */
export function renderSnapshotDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];
  lines.push(
    `Snapshot diff: ${diff.totalCount} nodes (${diff.unchangedCount} unchanged, ` +
      `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed).`,
  );
  for (const n of diff.added) {
    lines.push(`+ ${serializeAriaSnapshot([n]).replace(/\n/g, '\n  ')}`);
  }
  for (const n of diff.removed) {
    lines.push(`- [ref=${n.ref}] ${n.role} "${n.name}" (removed)`);
  }
  for (const c of diff.changed) {
    lines.push(
      `~ [ref=${c.after.ref}] ${c.after.role} "${c.after.name}" changed: ${c.fields.join(', ')}` +
        (c.fields.includes('value')
          ? ` (value: "${c.before.value ?? ''}" -> "${c.after.value ?? ''}")`
          : ''),
    );
  }
  return lines.join('\n');
}

/** Ước lượng token theo quy tắc 1 token ≈ 4 ký tự (đủ cho đo cost/step). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cắt snapshot dài về giới hạn ký tự, giữ nguyên các dòng đầu + footer. */
export function truncateSnapshot(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const kept = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return `${kept}\n[... snapshot truncated, ${text.length - kept.length} more chars ...]`;
}
