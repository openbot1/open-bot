/**
 * Protocols v10 — tool search + progressive discovery (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): progressive tool
 * discovery — a tool is marked `defer_loading: true`, and the
 * agent searches for tools when it needs them instead of
 * loading the whole registry into context. The survey cites
 * an 85% token saving and more accurate tool choice on large
 * tool libraries; open-bot's registry is already past 1.100
 * tools, so this is the single highest-leverage change in
 * v10. Programmatic tool calling rides on the same idea: the
 * agent writes a small script that calls tools in a sandbox
 * and only the final result enters the context.
 *
 * This module is open-bot's own implementation, written from
 * that description:
 *
 *   - `McpV10ToolSearchRegistry`: a registry where each tool
 *     declares `deferLoading` (load lazily), a category, and
 *     search keywords. Tools with `deferLoading: false` are
 *     the always-loaded core; deferred tools stay out of
 *     context until searched for and loaded.
 *   - `searchTools()`: tokenised, scored search (exact name
 *     > prefix > keyword > description token), deterministic
 *     order (score desc, then name asc) so repeated searches
 *     are stable and cache-friendly.
 *   - `loadTool()` / `loadTools()`: load-on-demand with a
 *     loader per deferred tool; the registry records what is
 *     loaded, how many times each tool was loaded, and cache
 *     hits, so the host can see which deferred tools are
 *     actually worth keeping in the core set.
 *   - `McpV10ProgrammaticCaller`: runs a script — an ordered
 *     list of steps `{tool, args, saveAs}` — against the
 *     registry, with `$variable` substitution from earlier
 *     steps, a per-step timeout, and a result that contains
 *     only the final step's output plus a compact step log.
 *     The script itself never reaches the model context.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no disk: loaders are host-supplied functions.
 */

/** A tool entry in the v10 search registry. */
export interface McpV10SearchableTool {
  /** Tool name (unique in the registry). */
  name: string;
  /** Short description (searched). */
  description: string;
  /** Category for filtering, e.g. `protocols`, `files`, `memory`. */
  category: string;
  /** True = load lazily; the agent searches for it instead of loading it up front. */
  deferLoading: boolean;
  /** Extra search keywords (synonyms, alternate spellings). */
  keywords?: string[];
  /** JSON schema of the tool's parameters (kept for the loader, not searched). */
  inputSchema?: Record<string, unknown>;
}

/** Loader for a deferred tool (returns its full definition on demand). */
export type McpV10ToolLoader = (name: string) => Promise<McpV10SearchableTool> | McpV10SearchableTool;

/** One search hit. */
export interface McpV10ToolSearchHit {
  tool: McpV10SearchableTool;
  /** 0–100 relevance score. */
  score: number;
  /** Why it matched (`name` / `prefix` / `keyword` / `description` / `category`). */
  matchedOn: string;
}

/** Search options. */
export interface McpV10ToolSearchOptions {
  /** Max hits (default 10). */
  limit?: number;
  /** Only tools in this category. */
  category?: string;
  /** Include already-loaded tools only (default: all). */
  loadedOnly?: boolean;
  /** Minimum score (default 1 — anything that matches at all). */
  minScore?: number;
}

/** Error raised by the tool-search layer. */
export class McpV10ToolSearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV10ToolSearchError';
    this.code = code;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

/** Score one tool against query tokens (0–100). */
export function scoreMcpV10ToolSearch(
  tool: McpV10SearchableTool,
  queryTokens: readonly string[],
): { score: number; matchedOn: string } {
  if (queryTokens.length === 0) return { score: 0, matchedOn: '' };
  const name = tool.name.toLowerCase();
  const nameTokens = tokenize(tool.name);
  const descTokens = tokenize(tool.description);
  const keywords = (tool.keywords ?? []).map((k) => k.toLowerCase());
  const category = tool.category.toLowerCase();
  let score = 0;
  let matchedOn = '';
  for (const token of queryTokens) {
    if (name === token) {
      score += 40;
      matchedOn = 'name';
    } else if (name.startsWith(token) || nameTokens.some((t) => t.startsWith(token))) {
      score += 30;
      if (!matchedOn) matchedOn = 'prefix';
    } else if (keywords.some((k) => k === token || k.startsWith(token))) {
      score += 25;
      if (!matchedOn) matchedOn = 'keyword';
    } else if (category === token) {
      score += 20;
      if (!matchedOn) matchedOn = 'category';
    } else if (descTokens.some((t) => t === token)) {
      score += 15;
      if (!matchedOn) matchedOn = 'description';
    } else if (descTokens.some((t) => t.startsWith(token)) || nameTokens.some((t) => t.includes(token))) {
      score += 8;
      if (!matchedOn) matchedOn = 'description';
    }
  }
  return { score: Math.min(100, score), matchedOn };
}

/** Load statistics for one deferred tool. */
export interface McpV10ToolLoadStats {
  name: string;
  loads: number;
  /** When the tool was last loaded (ms since epoch, undefined when never). */
  lastLoadedAt?: number;
  /** Whether the tool is currently loaded. */
  loaded: boolean;
}

/**
 * The search registry: core tools are always loaded,
 * deferred tools are searched for and loaded on demand.
 */
export class McpV10ToolSearchRegistry {
  private readonly tools = new Map<string, McpV10SearchableTool>();
  private readonly loaders = new Map<string, McpV10ToolLoader>();
  private readonly loaded = new Set<string>();
  private readonly loadCounts = new Map<string, number>();
  private readonly lastLoadedAt = new Map<string, number>();

  constructor(initial: readonly McpV10SearchableTool[] = []) {
    for (const tool of initial) this.register(tool);
  }

  /** Register a tool (core tools count as loaded immediately). */
  register(tool: McpV10SearchableTool, loader?: McpV10ToolLoader): void {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new McpV10ToolSearchError('invalid-tool', 'Tool name must be a non-empty string.');
    }
    if (typeof tool.description !== 'string' || tool.description.length === 0) {
      throw new McpV10ToolSearchError('invalid-tool', `Tool "${tool.name}" needs a non-empty description.`);
    }
    if (typeof tool.category !== 'string' || tool.category.length === 0) {
      throw new McpV10ToolSearchError('invalid-tool', `Tool "${tool.name}" needs a category.`);
    }
    this.tools.set(tool.name, tool);
    if (loader) this.loaders.set(tool.name, loader);
    if (!tool.deferLoading) this.loaded.add(tool.name);
  }

  /** Remove a tool. Returns true when one was removed. */
  unregister(name: string): boolean {
    this.loaded.delete(name);
    this.loaders.delete(name);
    this.loadCounts.delete(name);
    this.lastLoadedAt.delete(name);
    return this.tools.delete(name);
  }

  /** Total tools known (core + deferred). */
  get total(): number {
    return this.tools.size;
  }

  /** How many tools are deferred (not in the always-loaded core). */
  get deferredCount(): number {
    let n = 0;
    for (const tool of this.tools.values()) if (tool.deferLoading) n += 1;
    return n;
  }

  /** How many tools are currently loaded. */
  get loadedCount(): number {
    return this.loaded.size;
  }

  /** All registered tools (copy, sorted by name). */
  listAll(): McpV10SearchableTool[] {
    return [...this.tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Currently loaded tools (the always-loaded core + loaded deferred tools). */
  listLoaded(): McpV10SearchableTool[] {
    return this.listAll().filter((t) => this.loaded.has(t.name));
  }

  /** Deferred tools that are not loaded yet. */
  listDeferredUnloaded(): McpV10SearchableTool[] {
    return this.listAll().filter((t) => t.deferLoading && !this.loaded.has(t.name));
  }

  /** Categories present in the registry (sorted). */
  categories(): string[] {
    return [...new Set(this.listAll().map((t) => t.category))].sort();
  }

  /** Get one tool by name (undefined when unknown). */
  get(name: string): McpV10SearchableTool | undefined {
    return this.tools.get(name);
  }

  /** True when the tool is currently loaded. */
  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /**
   * Search tools by free text. Scoring is deterministic:
   * score desc, then name asc, so the same query always
   * returns the same order (cache-friendly).
   */
  search(query: string, options: McpV10ToolSearchOptions = {}): McpV10ToolSearchHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? 1;
    const hits: McpV10ToolSearchHit[] = [];
    for (const tool of this.tools.values()) {
      if (options.category && tool.category !== options.category) continue;
      if (options.loadedOnly && !this.loaded.has(tool.name)) continue;
      const { score, matchedOn } = scoreMcpV10ToolSearch(tool, tokens);
      if (score >= minScore) hits.push({ tool, score, matchedOn });
    }
    hits.sort((a, b) => (b.score - a.score) || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0));
    return hits.slice(0, Math.max(0, limit));
  }

  /**
   * Load a deferred tool on demand (runs its loader, or marks
   * a core tool loaded). Returns the tool definition. Loading
   * an already-loaded tool is a cache hit (no loader call).
   */
  async loadTool(name: string): Promise<{ tool: McpV10SearchableTool; cacheHit: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpV10ToolSearchError('unknown-tool', `Unknown tool "${name}".`);
    }
    if (this.loaded.has(name)) {
      return { tool, cacheHit: true };
    }
    const loader = this.loaders.get(name);
    const loadedTool = loader ? await loader(name) : tool;
    if (loadedTool.name !== name) {
      throw new McpV10ToolSearchError('loader-mismatch', `Loader for "${name}" returned a different tool ("${loadedTool.name}").`);
    }
    this.tools.set(name, loadedTool);
    this.loaded.add(name);
    this.loadCounts.set(name, (this.loadCounts.get(name) ?? 0) + 1);
    this.lastLoadedAt.set(name, Date.now());
    return { tool: loadedTool, cacheHit: false };
  }

  /** Load several tools at once (skips unknown names, reports them). */
  async loadTools(names: readonly string[]): Promise<{
    loaded: McpV10SearchableTool[];
    cacheHits: string[];
    unknown: string[];
  }> {
    const loaded: McpV10SearchableTool[] = [];
    const cacheHits: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      if (!this.tools.has(name)) {
        unknown.push(name);
        continue;
      }
      const { tool, cacheHit } = await this.loadTool(name);
      if (cacheHit) cacheHits.push(name);
      else loaded.push(tool);
    }
    return { loaded, cacheHits, unknown };
  }

  /** Load statistics for one tool. */
  loadStats(name: string): McpV10ToolLoadStats | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      name,
      loads: this.loadCounts.get(name) ?? 0,
      lastLoadedAt: this.lastLoadedAt.get(name),
      loaded: this.loaded.has(name),
    };
  }

  /** Load statistics for every deferred tool (sorted by loads desc). */
  deferredStats(): McpV10ToolLoadStats[] {
    const out: McpV10ToolLoadStats[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.deferLoading) continue;
      out.push({
        name: tool.name,
        loads: this.loadCounts.get(tool.name) ?? 0,
        lastLoadedAt: this.lastLoadedAt.get(tool.name),
        loaded: this.loaded.has(tool.name),
      });
    }
    out.sort((a, b) => b.loads - a.loads || (a.name < b.name ? -1 : 1));
    return out;
  }

  /**
   * Suggest which deferred tools should be promoted to the
   * always-loaded core: tools loaded at least `minLoads`
   * times. The host decides; this only reports.
   */
  promotionCandidates(minLoads = 3): McpV10ToolLoadStats[] {
    return this.deferredStats().filter((s) => s.loads >= minLoads);
  }

  /** Serialisable snapshot (for the host to mirror to disk). */
  snapshot(): { tools: McpV10SearchableTool[]; loaded: string[] } {
    return { tools: this.listAll(), loaded: [...this.loaded].sort() };
  }

  /** Restore from a snapshot (loaders must be re-registered by the host). */
  static restore(snapshot: { tools: McpV10SearchableTool[]; loaded: string[] }): McpV10ToolSearchRegistry {
    const registry = new McpV10ToolSearchRegistry(snapshot.tools);
    for (const name of snapshot.loaded) {
      if (registry.tools.has(name)) registry.loaded.add(name);
    }
    return registry;
  }
}

/** One step of a programmatic tool-calling script. */
export interface McpV10ScriptStep {
  /** Tool to call (must be loaded, or loadable, in the registry). */
  tool: string;
  /** Arguments; string values may reference earlier results as `$name` or `$name.path`. */
  args?: Record<string, unknown>;
  /** Save this step's result under this name for later steps. */
  saveAs?: string;
}

/** A programmatic tool-calling script. */
export interface McpV10Script {
  /** Script name (for logs). */
  name: string;
  steps: McpV10ScriptStep[];
  /** Max steps (guard against runaway scripts, default 20). */
  maxSteps?: number;
  /** Per-step timeout in ms (default 30.000). */
  stepTimeoutMs?: number;
}

/** One executed step (compact log — the script itself stays out of context). */
export interface McpV10ScriptStepLog {
  step: number;
  tool: string;
  ok: boolean;
  /** Milliseconds the step took. */
  tookMs: number;
  error?: string;
}

/** Result of running a script: only the final output + compact log. */
export interface McpV10ScriptResult {
  ok: boolean;
  /** Final step's result (undefined when the script failed before finishing). */
  finalResult?: unknown;
  /** Compact per-step log. */
  steps: McpV10ScriptStepLog[];
  /** Error that stopped the script (undefined when it finished). */
  error?: string;
}

/** Executor a script step calls (host-supplied; runs the real tool). */
export type McpV10ScriptExecutor = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

function resolveReferences(value: unknown, vars: Map<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const path = value.slice(1).split('.');
    const root = vars.get(path[0]);
    if (root === undefined) throw new Error(`Script variable "$${path[0]}" is not defined (no earlier step saved it).`);
    let current: unknown = root;
    for (const key of path.slice(1)) {
      if (typeof current !== 'object' || current === null) {
        throw new Error(`Script variable "$${value.slice(1)}" cannot be resolved (not an object at ".${key}").`);
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }
  if (Array.isArray(value)) return value.map((v) => resolveReferences(v, vars));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveReferences(v, vars);
    return out;
  }
  return value;
}

/**
 * Programmatic tool calling: the agent writes a script, the
 * host runs it, and only the final result enters the model
 * context. Steps run in order; a step may reference earlier
 * results with `$name` / `$name.path`.
 */
export class McpV10ProgrammaticCaller {
  private readonly registry: McpV10ToolSearchRegistry;
  private readonly executor: McpV10ScriptExecutor;

  constructor(registry: McpV10ToolSearchRegistry, executor: McpV10ScriptExecutor) {
    this.registry = registry;
    this.executor = executor;
  }

  /** Validate a script without running it. Returns problems. */
  validate(script: McpV10Script): string[] {
    const problems: string[] = [];
    if (typeof script.name !== 'string' || script.name.length === 0) {
      problems.push('Script name must be a non-empty string.');
    }
    if (!Array.isArray(script.steps) || script.steps.length === 0) {
      problems.push('Script needs at least one step.');
      return problems;
    }
    const maxSteps = script.maxSteps ?? 20;
    if (script.steps.length > maxSteps) {
      problems.push(`Script has ${script.steps.length} steps, over the max of ${maxSteps}.`);
    }
    const defined = new Set<string>();
    for (let i = 0; i < script.steps.length; i += 1) {
      const step = script.steps[i];
      if (typeof step.tool !== 'string' || step.tool.length === 0) {
        problems.push(`Step ${i + 1}: tool must be a non-empty string.`);
        continue;
      }
      if (!this.registry.get(step.tool)) {
        problems.push(`Step ${i + 1}: unknown tool "${step.tool}".`);
      }
      if (step.saveAs !== undefined) {
        if (typeof step.saveAs !== 'string' || step.saveAs.length === 0) {
          problems.push(`Step ${i + 1}: saveAs must be a non-empty string.`);
        } else if (defined.has(step.saveAs)) {
          problems.push(`Step ${i + 1}: saveAs "${step.saveAs}" is already used by an earlier step.`);
        } else {
          defined.add(step.saveAs);
        }
      }
      if (step.args !== undefined) {
        const refs: string[] = [];
        const collect = (v: unknown): void => {
          if (typeof v === 'string' && v.startsWith('$')) refs.push(v.slice(1).split('.')[0]);
          else if (Array.isArray(v)) v.forEach(collect);
          else if (typeof v === 'object' && v !== null) Object.values(v as Record<string, unknown>).forEach(collect);
        };
        collect(step.args);
        for (const ref of refs) {
          if (!defined.has(ref)) problems.push(`Step ${i + 1}: references "$${ref}" which no earlier step saved.`);
        }
      }
    }
    return problems;
  }

  /** Run a script (validates first; stops at the first failing step). */
  async run(script: McpV10Script): Promise<McpV10ScriptResult> {
    const problems = this.validate(script);
    if (problems.length > 0) {
      return { ok: false, steps: [], error: `Invalid script: ${problems.join(' ')}` };
    }
    const timeoutMs = script.stepTimeoutMs ?? 30_000;
    const vars = new Map<string, unknown>();
    const logs: McpV10ScriptStepLog[] = [];
    let finalResult: unknown;
    for (let i = 0; i < script.steps.length; i += 1) {
      const step = script.steps[i];
      const startedAt = Date.now();
      try {
        // Deferred tools load on demand before the step runs.
        await this.registry.loadTool(step.tool);
        const args = resolveReferences(step.args ?? {}, vars) as Record<string, unknown>;
        const result = await Promise.race([
          Promise.resolve(this.executor(step.tool, args)),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`Step ${i + 1} (${step.tool}) timed out after ${timeoutMs}ms.`)), timeoutMs);
          }),
        ]);
        if (step.saveAs) vars.set(step.saveAs, result);
        finalResult = result;
        logs.push({ step: i + 1, tool: step.tool, ok: true, tookMs: Date.now() - startedAt });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logs.push({ step: i + 1, tool: step.tool, ok: false, tookMs: Date.now() - startedAt, error: message });
        return { ok: false, steps: logs, error: `Step ${i + 1} (${step.tool}) failed: ${message}` };
      }
    }
    return { ok: true, finalResult, steps: logs };
  }
}
