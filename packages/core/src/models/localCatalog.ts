/**
 * Local model catalogue (v1.15, Doi T3) — Qwen3 / Llama / Gemma, GGUF.
 *
 * Y tuong (hoc tu llama.cpp router-mode + thuc hanh fleet on-device):
 * pin model cua minh (GGUF tu publisher), khong build fleet feature
 * tren model do OS cung cap (Apple/Microsoft co the doi/go model bat
 * cu luc nao). Moi muc ghi ro license (SPDX hoac ten giay phep cong
 * dong da biet), kich thuoc GGUF, RAM yeu cau, context, use-case
 * khuyen nghi — de UI va registry co the validate license TRUOC KHI
 * cho phep tai/cai, va chan model khong ro license.
 *
 * Du lieu tu thiet ke rieng cua open-bot (so lieu tham khao cong khai
 * tu trang model: Qwen3 Apache 2.0, Llama 3.x Community License,
 * Gemma Terms of Use). Khong copy code/text/tai san cua repo nao.
 */

/** Giay phep cua mot model local. */
export interface LocalModelLicense {
  /** SPDX id khi co (Apache-2.0, MIT...); undefined khi giay phep cong dong khong co SPDX. */
  spdx?: string;
  /** Ten day du de hien thi, vd "Apache License 2.0". */
  name: string;
  /** URL van ban giay phep. */
  url: string;
  /** Duoc dung thuong mai khong (theo van ban giay phep). */
  commercialUse: boolean;
  /** Duoc phan phoi lai khong. */
  redistribution: boolean;
  /** Co phai giay phep mo (OSI-approved) khong. */
  openSource: boolean;
  /** Rang buoc can luu y, vd "can ghi attribution", "khong dung de train model doi thu". */
  notes: string[];
}

/** Mot model trong catalogue local. */
export interface LocalModelEntry {
  /** Id on dinh trong open-bot, vd "qwen3-4b". */
  id: string;
  /** Ho model: 'qwen3' | 'llama' | 'gemma' | 'qwen2.5-coder'. */
  family: 'qwen3' | 'llama' | 'gemma' | 'qwen2.5-coder';
  /** Ten hien thi. */
  label: string;
  /** So tham so (ty), vd 4. */
  paramsB: number;
  /** Luong tu hoa GGUF, vd "Q4_K_M". */
  quantization: string;
  /** Kich thuoc file GGUF (byte). */
  ggufSizeBytes: number;
  /** RAM toi thieu de chay (byte) = GGUF + KV cache uoc tinh. */
  ramRequiredBytes: number;
  /** Context toi da (token). */
  contextTokens: number;
  /** Giay phep. */
  license: LocalModelLicense;
  /** Tag Ollama tuong ung (neu co). */
  ollamaTag?: string;
  /** Repo/file GGUF goc (chi de hien thi, khong tu tai). */
  ggufSource?: string;
  /** Use-case khuyen nghi. */
  useCases: Array<'chat' | 'code' | 'reasoning' | 'summarize' | 'translate' | 'embed' | 'tool-use' | 'long-context'>;
  /** Chat template / tool-use co san khong. */
  toolUse: boolean;
  /** Toc do uoc tinh tren Apple Silicon M-series (token/s, Q4) — tham khao. */
  estTokensPerSec?: number;
  /** Cap chat luong: 1 (nho) .. 5 (manh nhat trong catalogue). */
  qualityTier: 1 | 2 | 3 | 4 | 5;
  /** Ghi chu van hanh. */
  notes: string[];
}

const GB = 1024 * 1024 * 1024;

function apache(): LocalModelLicense {
  return {
    spdx: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
    commercialUse: true,
    redistribution: true,
    openSource: true,
    notes: ['Ghi attribution khi phan phoi lai'],
  };
}

function llamaCommunity(version: string): LocalModelLicense {
  return {
    name: `Meta Llama ${version} Community License`,
    url: 'https://www.llama.com/llama3_2/license/',
    commercialUse: true,
    redistribution: true,
    openSource: false,
    notes: [
      'Giay phep cong dong cua Meta, KHONG phai OSI-approved',
      'Can chap hanh Acceptable Use Policy cua Meta',
      'Khong dung output de cai thien model doi thu',
    ],
  };
}

function gemmaTerms(): LocalModelLicense {
  return {
    name: 'Gemma Terms of Use',
    url: 'https://ai.google.dev/gemma/terms',
    commercialUse: true,
    redistribution: true,
    openSource: false,
    notes: [
      'Giay phep cua Google, KHONG phai OSI-approved',
      'Can chap hanh Prohibited Use Policy',
      'Can dung thuong mai nhung phai tuan thu dieu khoan su dung',
    ],
  };
}

/** Catalogue co san — 12 model local da kiem chung license. */
export const LOCAL_MODEL_CATALOG: readonly LocalModelEntry[] = [
  {
    id: 'qwen3-0.6b',
    family: 'qwen3',
    label: 'Qwen3 0.6B',
    paramsB: 0.6,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(0.5 * GB),
    ramRequiredBytes: Math.round(1.2 * GB),
    contextTokens: 32768,
    license: apache(),
    ollamaTag: 'qwen3:0.6b',
    ggufSource: 'Qwen/Qwen3-0.6B-GGUF',
    useCases: ['chat', 'summarize', 'translate'],
    toolUse: false,
    estTokensPerSec: 120,
    qualityTier: 1,
    notes: ['Nhe nhat catalogue — dung cho decision/router tier, phan loai nhanh'],
  },
  {
    id: 'qwen3-1.7b',
    family: 'qwen3',
    label: 'Qwen3 1.7B',
    paramsB: 1.7,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(1.2 * GB),
    ramRequiredBytes: Math.round(2.2 * GB),
    contextTokens: 32768,
    license: apache(),
    ollamaTag: 'qwen3:1.7b',
    ggufSource: 'Qwen/Qwen3-1.7B-GGUF',
    useCases: ['chat', 'summarize', 'translate'],
    toolUse: true,
    estTokensPerSec: 90,
    qualityTier: 2,
    notes: ['Chat hang ngay nhe, chay tot tren may 8 GB RAM'],
  },
  {
    id: 'qwen3-4b',
    family: 'qwen3',
    label: 'Qwen3 4B',
    paramsB: 4,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(2.5 * GB),
    ramRequiredBytes: Math.round(4.5 * GB),
    contextTokens: 32768,
    license: apache(),
    ollamaTag: 'qwen3:4b',
    ggufSource: 'Qwen/Qwen3-4B-GGUF',
    useCases: ['chat', 'code', 'reasoning', 'summarize', 'translate', 'tool-use'],
    toolUse: true,
    estTokensPerSec: 55,
    qualityTier: 3,
    notes: ['Model mac dinh cho fleet — can bang chat luong/toc do/RAM'],
  },
  {
    id: 'qwen3-8b',
    family: 'qwen3',
    label: 'Qwen3 8B',
    paramsB: 8,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(5.2 * GB),
    ramRequiredBytes: Math.round(8 * GB),
    contextTokens: 32768,
    license: apache(),
    ollamaTag: 'qwen3:8b',
    ggufSource: 'Qwen/Qwen3-8B-GGUF',
    useCases: ['chat', 'code', 'reasoning', 'summarize', 'tool-use', 'long-context'],
    toolUse: true,
    estTokensPerSec: 35,
    qualityTier: 4,
    notes: ['Code + reasoning kha, can may 16 GB RAM tro len'],
  },
  {
    id: 'qwen3-14b',
    family: 'qwen3',
    label: 'Qwen3 14B',
    paramsB: 14,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(9.0 * GB),
    ramRequiredBytes: Math.round(13 * GB),
    contextTokens: 32768,
    license: apache(),
    ollamaTag: 'qwen3:14b',
    ggufSource: 'Qwen/Qwen3-14B-GGUF',
    useCases: ['code', 'reasoning', 'summarize', 'long-context'],
    toolUse: true,
    estTokensPerSec: 22,
    qualityTier: 4,
    notes: ['Reasoning manh local, can may 24 GB RAM tro len'],
  },
  {
    id: 'qwen3-32b',
    family: 'qwen3',
    label: 'Qwen3 32B',
    paramsB: 32,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(20 * GB),
    ramRequiredBytes: Math.round(28 * GB),
    contextTokens: 32768,
    license: apache(),
    ollamaTag: 'qwen3:32b',
    ggufSource: 'Qwen/Qwen3-32B-GGUF',
    useCases: ['code', 'reasoning', 'long-context'],
    toolUse: true,
    estTokensPerSec: 12,
    qualityTier: 5,
    notes: ['Manh nhat Qwen3 local — chi may RAM lon (>= 32 GB) hoac GPU VRAM lon'],
  },
  {
    id: 'llama-3.2-1b',
    family: 'llama',
    label: 'Llama 3.2 1B',
    paramsB: 1,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(0.8 * GB),
    ramRequiredBytes: Math.round(1.6 * GB),
    contextTokens: 131072,
    license: llamaCommunity('3.2'),
    ollamaTag: 'llama3.2:1b',
    ggufSource: 'meta-llama/Llama-3.2-1B-GGUF (via llama.cpp)',
    useCases: ['chat', 'summarize', 'translate'],
    toolUse: false,
    estTokensPerSec: 110,
    qualityTier: 1,
    notes: ['Nhe, context 128k — tot cho tom tat van ban dai'],
  },
  {
    id: 'llama-3.2-3b',
    family: 'llama',
    label: 'Llama 3.2 3B',
    paramsB: 3,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(2.0 * GB),
    ramRequiredBytes: Math.round(3.5 * GB),
    contextTokens: 131072,
    license: llamaCommunity('3.2'),
    ollamaTag: 'llama3.2:3b',
    ggufSource: 'meta-llama/Llama-3.2-3B-GGUF (via llama.cpp)',
    useCases: ['chat', 'summarize', 'translate', 'tool-use'],
    toolUse: true,
    estTokensPerSec: 65,
    qualityTier: 2,
    notes: ['Chat hang ngay, context 128k, chay tot tren may 8 GB'],
  },
  {
    id: 'llama-3.1-8b',
    family: 'llama',
    label: 'Llama 3.1 8B',
    paramsB: 8,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(4.7 * GB),
    ramRequiredBytes: Math.round(7.5 * GB),
    contextTokens: 131072,
    license: llamaCommunity('3.1'),
    ollamaTag: 'llama3.1:8b',
    ggufSource: 'meta-llama/Llama-3.1-8B-GGUF (via llama.cpp)',
    useCases: ['chat', 'code', 'reasoning', 'summarize', 'tool-use', 'long-context'],
    toolUse: true,
    estTokensPerSec: 32,
    qualityTier: 4,
    notes: ['Context 128k — lua chon tot cho long-context khi can Llama'],
  },
  {
    id: 'gemma-3-1b',
    family: 'gemma',
    label: 'Gemma 3 1B',
    paramsB: 1,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(0.7 * GB),
    ramRequiredBytes: Math.round(1.5 * GB),
    contextTokens: 32768,
    license: gemmaTerms(),
    ollamaTag: 'gemma3:1b',
    ggufSource: 'google/gemma-3-1b-it-GGUF',
    useCases: ['chat', 'summarize', 'translate'],
    toolUse: false,
    estTokensPerSec: 110,
    qualityTier: 1,
    notes: ['Nhe, chay tot tren may yeu; chi text (ban nay khong vision)'],
  },
  {
    id: 'gemma-3-4b',
    family: 'gemma',
    label: 'Gemma 3 4B',
    paramsB: 4,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(2.6 * GB),
    ramRequiredBytes: Math.round(4.5 * GB),
    contextTokens: 131072,
    license: gemmaTerms(),
    ollamaTag: 'gemma3:4b',
    ggufSource: 'google/gemma-3-4b-it-GGUF',
    useCases: ['chat', 'summarize', 'translate', 'long-context'],
    toolUse: false,
    estTokensPerSec: 55,
    qualityTier: 3,
    notes: ['Context 128k, chat luong kha — luu y Gemma 4B khong ho tro tool-use chinh thuc'],
  },
  {
    id: 'gemma-3-12b',
    family: 'gemma',
    label: 'Gemma 3 12B',
    paramsB: 12,
    quantization: 'Q4_K_M',
    ggufSizeBytes: Math.round(7.3 * GB),
    ramRequiredBytes: Math.round(11 * GB),
    contextTokens: 131072,
    license: gemmaTerms(),
    ollamaTag: 'gemma3:12b',
    ggufSource: 'google/gemma-3-12b-it-GGUF',
    useCases: ['chat', 'code', 'reasoning', 'summarize', 'long-context'],
    toolUse: false,
    estTokensPerSec: 25,
    qualityTier: 4,
    notes: ['Manh nhat Gemma text-only, can may 16 GB RAM tro len'],
  },
];

/** SPDX / ten giay phep duoc chap nhan mac dinh (mo + cong dong da biet). */
export const ALLOWED_LICENSE_NAMES = [
  'Apache License 2.0',
  'MIT License',
  'Meta Llama 3.1 Community License',
  'Meta Llama 3.2 Community License',
  'Meta Llama 3.3 Community License',
  'Gemma Terms of Use',
] as const;

/** Ket qua validate license cua mot model. */
export interface LicenseValidation {
  /** true = duoc phep tai/cai/chay trong open-bot. */
  allowed: boolean;
  /** Ly do chan (khi allowed = false) hoac canh bao (khi allowed = true). */
  reasons: string[];
  /** Canh bao khong chan: giay phep cong dong, can doc them dieu khoan. */
  warnings: string[];
  /** Loai giay phep: mo / cong dong / khong ro. */
  kind: 'open-source' | 'community' | 'unknown';
}

/**
 * Validate license truoc khi cho phep tai/cai model.
 * - Khong co ten giay phep / ten trong danh sach den / chua biet -> CHAN.
 * - Giay phep mo (Apache/MIT) -> cho phep, khong canh bao.
 * - Giay phep cong dong da biet (Llama/Gemma) -> cho phep + canh bao doc dieu khoan.
 */
export function validateModelLicense(entry: Pick<LocalModelEntry, 'id' | 'license'>): LicenseValidation {
  const lic = entry.license;
  if (!lic || !lic.name || lic.name.trim() === '') {
    return {
      allowed: false,
      reasons: [`Model "${entry.id}" khong co giay phep ro rang — chan tai/cai cho den khi xac dinh duoc license.`],
      warnings: [],
      kind: 'unknown',
    };
  }
  const name = lic.name.trim();
  if (!(ALLOWED_LICENSE_NAMES as readonly string[]).includes(name)) {
    return {
      allowed: false,
      reasons: [
        `Giay phep "${name}" cua model "${entry.id}" chua duoc phe duyet — chi Apache 2.0 / MIT / Llama Community / Gemma Terms duoc phep.`,
      ],
      warnings: [],
      kind: 'unknown',
    };
  }
  if (lic.openSource) {
    return { allowed: true, reasons: [], warnings: [], kind: 'open-source' };
  }
  return {
    allowed: true,
    reasons: [],
    warnings: [
      `"${name}" la giay phep cong dong (khong phai open-source OSI) — doc ky dieu khoan truoc khi dung thuong mai.`,
      ...lic.notes,
    ],
    kind: 'community',
  };
}

/** Tim model theo id (undefined neu khong co). */
export function findLocalModel(id: string): LocalModelEntry | undefined {
  return LOCAL_MODEL_CATALOG.find((m) => m.id === id);
}

/** Loc model theo use-case. */
export function localModelsForUseCase(
  useCase: LocalModelEntry['useCases'][number],
): LocalModelEntry[] {
  return LOCAL_MODEL_CATALOG.filter((m) => m.useCases.includes(useCase));
}

/** Model vua trong RAM kha dung (byte). Sap xep chat luong giam dan. */
export function localModelsFittingRam(availableRamBytes: number): LocalModelEntry[] {
  return LOCAL_MODEL_CATALOG.filter((m) => m.ramRequiredBytes <= availableRamBytes)
    .sort((a, b) => b.qualityTier - a.qualityTier || a.ramRequiredBytes - b.ramRequiredBytes);
}

/** Model mac dinh cua fleet: Qwen3 4B (Apache 2.0, can bang chat luong/RAM). */
export const DEFAULT_LOCAL_MODEL_ID = 'qwen3-4b';

/** Model nhe nhat de lam decision/router tier. */
export const DEFAULT_ROUTER_MODEL_ID = 'qwen3-0.6b';
