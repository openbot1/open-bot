/**
 * Agent Profiles theo loai task coding (v1.11, Doi T4) — coding agent v4.
 *
 * Y tuong hoc tu OpenHands 1.40 Agent Profiles (chi hoc y tuong, tu
 * thiet ke va viet lai hoan toan tu dau — KHONG doc, KHONG copy
 * code/text/tai san cua bat ky repo nao, cua xAI/Cursor).
 *
 * Moi profile la preset cho MOT loai task coding: model goi y (+
 * fallback), bo tool duoc phep, system prompt, gioi han buoc/ngan
 * sach token, va quy tac do/don't. Host ap profile truoc khi chay
 * task (chon model theo profile, chi mo tool trong danh sach, ghep
 * system prompt vao prompt that) thay vi dung mot cau hinh chung cho
 * moi task.
 *
 * PHAM VI: day la profile RIENG cho coding (module `coding-profiles`,
 * dat trong codingV4) — khong dung file cua T2 (doi eval lam Agent
 * Profiles chung). Neu T2 co profile chung, host co the map
 * kind -> profile chung; module nay khong import gi tu T2.
 *
 * Loai task: debug, refactor, feature, review, test, explore.
 * Map tu loai task cua router v3 (CodingV3TaskType) sang profile kind
 * o `codingV4ProfileForTaskType` de host cu tai dung duoc.
 *
 * Gioi han trung thuc:
 *   - profile chi la preset CAU HINH (khong goi LLM, khong ep buoc
 *     that): host phai tu ap model/tools/prompt theo profile.
 *   - tool trong profile la TEN tool (vd "repomap_v4_rank"); ten la
 *     phai nam trong registry that moi co tac dung — resolve se canh
 *     bao va loai tool la khi host cap danh sach tool hop le.
 *   - model goi y la ten cau hinh; host chon fallback khi model
 *     chinh khong co san.
 */

export type CodingV4ProfileKind = 'debug' | 'refactor' | 'feature' | 'review' | 'test' | 'explore';

export const CODING_V4_PROFILE_KINDS: CodingV4ProfileKind[] = [
  'debug',
  'refactor',
  'feature',
  'review',
  'test',
  'explore',
];

export interface CodingV4Profile {
  /** Id on dinh: `coding-<kind>` (vd "coding-debug"). */
  id: string;
  kind: CodingV4ProfileKind;
  /** Ten hien thi (tieng Anh goc; UI dich qua i18n key codingV4.profile.<kind>). */
  label: string;
  description: string;
  /** Model goi y cho loai task nay. */
  modelId: string;
  /** Fallback theo thu tu khi model chinh khong co san. */
  fallbackModelIds: string[];
  /** Ten tool duoc phep dung trong profile nay. */
  tools: string[];
  /** System prompt co ban cua profile (host ghep them context). */
  systemPrompt: string;
  /** So buoc agent toi da cho mot task. */
  maxSteps: number;
  /** Ngan sach token uoc luong cho repo map cua task. */
  budgetTokens: number;
  rules: {
    /** Viec NEN lam. */
    do: string[];
    /** Viec KHONG lam. */
    dont: string[];
  };
}

/** Tool doc repo map chi doc (dung chung cho moi profile). */
const READ_REPO_TOOLS = [
  'repomap_v4_rank',
  'repomap_v4_budget_map',
  'repomap_v4_invalidate',
  'repomap_v3_budget_map',
] as const;

/** Tool doc file/code chi doc. */
const READ_CODE_TOOLS = ['read_file', 'list_files', 'web_search'] as const;

export const CODING_V4_PROFILES: CodingV4Profile[] = [
  {
    id: 'coding-debug',
    kind: 'debug',
    label: 'Debug',
    description:
      'Tim nguyen nhan loi roi sua toi thieu: tai hien loi truoc, doc stack trace + code lien quan, chi sua dung cho loi, khong refactor lan.',
    modelId: 'ollama/qwen2.5-coder:32b',
    fallbackModelIds: ['ollama/qwen2.5-coder:7b', 'gemini-2.5-flash'],
    tools: [...READ_REPO_TOOLS, ...READ_CODE_TOOLS, 'shell_exec', 'coding_v3_team_run'],
    systemPrompt:
      'You are a debugging agent. Reproduce the bug first, read the stack trace and the smallest relevant code, then fix only the root cause with the minimal change. Do not refactor unrelated code. Verify the fix with a test or a reproduction run before finishing.',
    maxSteps: 25,
    budgetTokens: 2000,
    rules: {
      do: [
        'Reproduce the bug before changing code.',
        'Read the stack trace and the smallest relevant code first.',
        'Verify the fix with a test or a reproduction run.',
      ],
      dont: [
        'Do not refactor unrelated code while debugging.',
        'Do not guess the fix without reading the failing code.',
        'Do not swallow errors or hide them behind try/catch.',
      ],
    },
  },
  {
    id: 'coding-refactor',
    kind: 'refactor',
    label: 'Refactor',
    description:
      'Cai tien cau truc ma khong doi hanh vi: tach ham/module nho, doi ten ro nghia, chay test truoc va sau de chung minh hanh vi giu nguyen.',
    modelId: 'ollama/qwen2.5-coder:32b',
    fallbackModelIds: ['ollama/qwen2.5-coder:7b', 'gemini-2.5-flash'],
    tools: [...READ_REPO_TOOLS, ...READ_CODE_TOOLS, 'write_file', 'shell_exec', 'coding_v3_team_run'],
    systemPrompt:
      'You are a refactoring agent. Improve structure without changing behavior: split large functions and modules, rename for clarity, keep the public surface stable. Run the tests before and after the change and report any behavior difference as a blocker, not as a cleanup.',
    maxSteps: 30,
    budgetTokens: 3000,
    rules: {
      do: [
        'Run the tests before and after the refactor.',
        'Keep the change small and reviewable, one concern at a time.',
        'Keep public APIs and behavior unchanged.',
      ],
      dont: [
        'Do not change behavior and call it a refactor.',
        'Do not rename public symbols without updating all callers.',
        'Do not mix a refactor with a feature change.',
      ],
    },
  },
  {
    id: 'coding-feature',
    kind: 'feature',
    label: 'Feature',
    description:
      'Xay tinh nang moi tu spec: lap ke hoach, viet code + test, chay build/typecheck/test, bao cao file da doi va gioi han con ton tai.',
    modelId: 'gemini-2.5-flash',
    fallbackModelIds: ['ollama/qwen2.5-coder:32b', 'ollama/qwen2.5-coder:7b'],
    tools: [
      ...READ_REPO_TOOLS,
      ...READ_CODE_TOOLS,
      'write_file',
      'shell_exec',
      'coding_v3_team_run',
      'coding_v4_subagent_start',
      'coding_v4_subagent_update',
      'coding_v4_model_switch',
    ],
    systemPrompt:
      'You are a feature-building agent. Plan first, then implement the feature with tests, run build, typecheck and the new tests, and report the files changed plus any remaining limits. Prefer small, composable modules and reuse existing helpers instead of inventing new ones.',
    maxSteps: 40,
    budgetTokens: 4000,
    rules: {
      do: [
        'Plan the change before writing code.',
        'Add a test for every new behavior.',
        'Run build, typecheck and tests before reporting done.',
      ],
      dont: [
        'Do not invent a new helper when one already exists.',
        'Do not report done while tests are failing.',
        'Do not hard-code secrets or credentials.',
      ],
    },
  },
  {
    id: 'coding-review',
    kind: 'review',
    label: 'Review',
    description:
      'Review code thay nguoi: chi doc, khong sua file; chi ra loi that, bao mat, hieu nang, va goi y sua cu the kem vi tri file/dong.',
    modelId: 'gemini-2.5-flash',
    fallbackModelIds: ['ollama/qwen2.5-coder:32b'],
    tools: [...READ_REPO_TOOLS, ...READ_CODE_TOOLS],
    systemPrompt:
      'You are a code-review agent. Read only — never edit files. Find real bugs, security issues and performance problems, and suggest concrete fixes with file and line references. Do not nitpick style; rank findings by severity and stop when the list is complete.',
    maxSteps: 20,
    budgetTokens: 3000,
    rules: {
      do: [
        'Rank findings by severity with file and line references.',
        'Suggest a concrete fix for every finding.',
        'Check security, correctness and performance first.',
      ],
      dont: [
        'Do not edit files during a review.',
        'Do not nitpick style when real issues exist.',
        'Do not approve code with a failing test.',
      ],
    },
  },
  {
    id: 'coding-test',
    kind: 'test',
    label: 'Test',
    description:
      'Viet va chay test: bao phu hanh vi moi + truong hop bien, test phai doc lap va chay nhanh, khong sua test de lach loi that.',
    modelId: 'ollama/qwen2.5-coder:7b',
    fallbackModelIds: ['ollama/qwen2.5-coder:32b', 'gemini-2.5-flash'],
    tools: [...READ_REPO_TOOLS, ...READ_CODE_TOOLS, 'write_file', 'shell_exec'],
    systemPrompt:
      'You are a test-writing agent. Cover the new behavior plus edge cases, keep each test independent and fast, and never edit a test to hide a real failure — fix the code instead. Report the number of new tests and their results.',
    maxSteps: 20,
    budgetTokens: 2000,
    rules: {
      do: [
        'Cover edge cases, not only the happy path.',
        'Keep tests independent and fast.',
        'Report new-test counts and results.',
      ],
      dont: [
        'Do not edit a test to hide a real failure.',
        'Do not write tests that depend on network or wall-clock time.',
        'Do not duplicate an existing test under a new name.',
      ],
    },
  },
  {
    id: 'coding-explore',
    kind: 'explore',
    label: 'Explore',
    description:
      'Kham pha repo de tra loi cau hoi hoac lap ke hoach: chi doc, dung repo map de tim file/symbol lien quan, tra loi ngan gon co dan chung file/dong.',
    modelId: 'ollama/qwen2.5-coder:7b',
    fallbackModelIds: ['gemini-2.5-flash'],
    tools: [...READ_REPO_TOOLS, ...READ_CODE_TOOLS],
    systemPrompt:
      'You are an exploration agent. Read only — never edit files. Use the repo map to find the relevant files and symbols, then answer briefly with file and line evidence. Say clearly when something is not in the codebase instead of guessing.',
    maxSteps: 15,
    budgetTokens: 2000,
    rules: {
      do: [
        'Use the repo map to find relevant files first.',
        'Answer with file and line evidence.',
        'Say when something is not in the codebase.',
      ],
      dont: [
        'Do not edit files while exploring.',
        'Do not guess an answer the code does not support.',
        'Do not dump whole files into the answer.',
      ],
    },
  },
];

/** Lay profile theo kind hoac id (vd "debug" hay "coding-debug"). */
export function getCodingV4Profile(kindOrId: string): CodingV4Profile | undefined {
  const key = (kindOrId ?? '').trim().toLowerCase();
  if (key === '') return undefined;
  return CODING_V4_PROFILES.find((p) => p.kind === key || p.id === key);
}

/** Danh sach profile (ban sao de caller khong sua duoc goc). */
export function listCodingV4Profiles(): CodingV4Profile[] {
  return CODING_V4_PROFILES.map((p) => ({
    ...p,
    fallbackModelIds: [...p.fallbackModelIds],
    tools: [...p.tools],
    rules: { do: [...p.rules.do], dont: [...p.rules.dont] },
  }));
}

export type CodingV4TaskTypeForProfile =
  | 'codegen'
  | 'refactor'
  | 'review'
  | 'explore'
  | 'plan'
  | 'fix'
  | 'test'
  | 'chat';

/**
 * Map loai task cua router v3 sang profile kind cua coding v4:
 * fix -> debug, codegen -> feature, plan/chat -> explore, con lai
 * giu nguyen ten (refactor/review/test/explore).
 */
export function codingV4ProfileForTaskType(taskType: string): CodingV4ProfileKind {
  switch ((taskType ?? '').trim().toLowerCase()) {
    case 'fix':
      return 'debug';
    case 'codegen':
      return 'feature';
    case 'plan':
    case 'chat':
      return 'explore';
    case 'refactor':
      return 'refactor';
    case 'review':
      return 'review';
    case 'test':
      return 'test';
    case 'explore':
    default:
      return 'explore';
  }
}

export interface CodingV4ResolveOptions {
  /** Ghi de mot phan profile (vd doi modelId, them tool). */
  overrides?: Partial<Omit<CodingV4Profile, 'id' | 'kind' | 'rules'> & { rules?: Partial<CodingV4Profile['rules']> }>;
  /** Danh sach ten tool hop le (vd tu registry): tool la se bi loai + canh bao. */
  knownTools?: readonly string[];
}

export interface CodingV4ResolvedProfile {
  profile: CodingV4Profile;
  /** Canh bao (tool la bi loai, override khong hop le...). */
  warnings: string[];
}

/**
 * Giai quyet profile de host ap dung: lay profile goc, ap overrides,
 * loai tool khong co trong `knownTools` (neu host cap), kiem tra
 * maxSteps/budgetTokens hop le. Khong bao gio throw vi tool la — chi
 * canh bao (host van chay duoc voi tool con lai).
 */
export function resolveCodingV4Profile(
  kindOrId: string,
  options: CodingV4ResolveOptions = {},
): CodingV4ResolvedProfile {
  const base = getCodingV4Profile(kindOrId);
  const warnings: string[] = [];
  if (!base) {
    throw new Error(`Khong co coding profile "${kindOrId}" (debug/refactor/feature/review/test/explore).`);
  }
  const profile: CodingV4Profile = {
    ...base,
    fallbackModelIds: [...base.fallbackModelIds],
    tools: [...base.tools],
    rules: { do: [...base.rules.do], dont: [...base.rules.dont] },
  };
  const overrides = options.overrides ?? {};
  if (overrides.label !== undefined) profile.label = overrides.label;
  if (overrides.description !== undefined) profile.description = overrides.description;
  if (overrides.modelId !== undefined) profile.modelId = overrides.modelId;
  if (overrides.fallbackModelIds !== undefined) {
    profile.fallbackModelIds = [...overrides.fallbackModelIds];
  }
  if (overrides.systemPrompt !== undefined) profile.systemPrompt = overrides.systemPrompt;
  if (overrides.tools !== undefined) profile.tools = [...overrides.tools];
  if (overrides.maxSteps !== undefined) {
    if (Number.isFinite(overrides.maxSteps) && overrides.maxSteps > 0) {
      profile.maxSteps = Math.floor(overrides.maxSteps);
    } else {
      warnings.push(`maxSteps override "${String(overrides.maxSteps)}" khong hop le, giu ${profile.maxSteps}.`);
    }
  }
  if (overrides.budgetTokens !== undefined) {
    if (Number.isFinite(overrides.budgetTokens) && overrides.budgetTokens > 0) {
      profile.budgetTokens = Math.floor(overrides.budgetTokens);
    } else {
      warnings.push(`budgetTokens override "${String(overrides.budgetTokens)}" khong hop le, giu ${profile.budgetTokens}.`);
    }
  }
  if (overrides.rules?.do !== undefined) profile.rules.do = [...overrides.rules.do];
  if (overrides.rules?.dont !== undefined) profile.rules.dont = [...overrides.rules.dont];

  if (options.knownTools) {
    const known = new Set(options.knownTools);
    const kept: string[] = [];
    for (const tool of profile.tools) {
      if (known.has(tool)) kept.push(tool);
      else warnings.push(`Tool "${tool}" khong co trong registry — loai khoi profile ${profile.id}.`);
    }
    profile.tools = kept;
  }
  return { profile, warnings };
}

/**
 * Render system prompt day du de host ghep vao prompt that: prompt
 * goc + danh sach tool duoc phep + quy tac do/don't + gioi han buoc.
 */
export function renderCodingV4ProfileSystemPrompt(profile: CodingV4Profile): string {
  const lines: string[] = [
    `[Profile: ${profile.label} (${profile.id})]`,
    profile.systemPrompt,
    '',
    `Allowed tools (${profile.tools.length}): ${profile.tools.join(', ')}.`,
    `Max steps: ${profile.maxSteps}. Repo-map budget: ${profile.budgetTokens} tokens.`,
    '',
    'Do:',
    ...profile.rules.do.map((r) => `- ${r}`),
    '',
    "Don't:",
    ...profile.rules.dont.map((r) => `- ${r}`),
  ];
  return lines.join('\n');
}
