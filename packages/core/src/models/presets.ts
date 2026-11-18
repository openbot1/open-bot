/**
 * Presets for OpenAI-compatible providers (v0.5).
 *
 * A preset is just a well-known base URL + default model for a
 * third-party provider that speaks the OpenAI chat-completions API.
 * No credentials live here — the user still supplies their own API
 * key, stored in the Vault like any other provider key. Adding a new
 * preset is one entry in COMPATIBLE_PRESETS; nothing else changes.
 *
 * This module is intentionally a leaf: it imports nothing from
 * open-bot, so packages/core/src/providers/index.ts can import it
 * without creating a cycle (models/registry.ts imports the provider
 * registry, the provider registry imports only this file).
 */

export interface CompatiblePreset {
  /** Stable id, used in settings (e.g. 'deepseek'). */
  id: string;
  /** Display label, e.g. 'DeepSeek'. */
  label: string;
  /** Base URL of the provider's OpenAI-compatible API. */
  baseUrl: string;
  /** Model used when the user picks this preset and sets no model. */
  defaultModel: string;
}

export const COMPATIBLE_PRESETS: readonly CompatiblePreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    // v0.97: `deepseek-chat` / `deepseek-reasoner` were retired on
    // 2026-07-24 — the current default is the V4 cost-efficient
    // flagship (see providers/deepseek.ts).
    defaultModel: 'deepseek-v4-flash',
  },
  {
    // v0.97 (Team T6): Moonshot AI (Kimi) — international endpoint;
    // mainland-China keys use https://api.moonshot.cn/v1 instead.
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    // v0.97 (Team T6): Cohere Compatibility API — OpenAI-compatible
    // endpoint for the Command models (api.cohere.ai, not .com).
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-a-03-2025',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
  },
  {
    // B-platform M3. Cerebras: model suy luận siêu nhanh (Wafer-Scale
    // Engine). Mặc định gpt-oss-120b — llama-3.3-70b đã bị gỡ khỏi
    // endpoint công khai của Cerebras trong 2026, không dùng làm mặc định.
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
  },
  {
    // B-platform M3. Fireworks AI: serverless, model id đầy đủ dạng
    // accounts/fireworks/models/<model> theo doc của Fireworks.
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    // B-platform M3. SambaNova Cloud: model id Meta-Llama-3.3-70B-Instruct
    // theo doc + danh sách /v1/models trực tiếp. Lưu ý: gói miễn phí
    // của SambaNova hiện yêu cầu phương thức thanh toán trước khi gọi
    // lần đầu (test 2026-08-31 trả 402), người dùng tự thêm key của mình.
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
  {
    // B-platform M3. Google AI Studio qua endpoint tương thích OpenAI:
    // dùng cùng AI Studio key với provider Gemini. Mặc định
    // gemini-2.5-flash (đã kiểm chứng chạy tốt); project mới chưa từng
    // dùng model 2.5 có thể cần chọn model 3.x (vd gemini-3-flash).
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  // v1.18 (Doi T3): mo rong tu 12 len 90 preset OpenAI-compatible —
  // gateway/router, inference cloud, model vendor, Trung Quoc, local
  // self-hosted. Chi la baseUrl + defaultModel cong khai; user tu nap
  // key cua minh vao Vault, khong co credential nao o day. Endpoint
  // local (localhost) khong can key.
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar',
  },
  {
    id: 'aimlapi',
    label: 'AIML API',
    baseUrl: 'https://api.aimlapi.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'requesty',
    label: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    defaultModel: 'openai/gpt-4o-mini',
  },
  {
    id: 'portkey',
    label: 'Portkey',
    baseUrl: 'https://api.portkey.ai/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'helicone',
    label: 'Helicone',
    baseUrl: 'https://oai.helicone.ai/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    defaultModel: 'openai/gpt-4o-mini',
  },
  {
    id: 'langdb',
    label: 'LangDB',
    baseUrl: 'https://api.langdb.ai',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'martian',
    label: 'Martian',
    baseUrl: 'https://api.withmartian.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'notdiamond',
    label: 'Not Diamond',
    baseUrl: 'https://api.notdiamond.ai/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'unify',
    label: 'Unify AI',
    baseUrl: 'https://api.unify.ai/v1',
    defaultModel: 'gpt-4o-mini@openai',
  },
  {
    id: 'eden-ai',
    label: 'Eden AI',
    baseUrl: 'https://api.edenai.run/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'ovh-ai',
    label: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    defaultModel: 'Meta-Llama-3_3-70B-Instruct',
  },
  {
    id: 'targon',
    label: 'Targon',
    baseUrl: 'https://api.targon.com/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'corcel',
    label: 'Corcel',
    baseUrl: 'https://api.corcel.io/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'inference-sh',
    label: 'Inference.sh',
    baseUrl: 'https://api.inference.sh/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'prime-intellect',
    label: 'Prime Intellect',
    baseUrl: 'https://api.primeintellect.ai/api/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'scaleway',
    label: 'Scaleway',
    baseUrl: 'https://api.scaleway.ai/v1',
    defaultModel: 'llama-3.1-8b-instruct',
  },
  {
    id: 'pollinations',
    label: 'Pollinations',
    baseUrl: 'https://text.pollinations.ai/v1',
    defaultModel: 'openai',
  },
  {
    id: 'pawan',
    label: 'Pawan',
    baseUrl: 'https://api.pawan.krd/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'shuttleai',
    label: 'ShuttleAI',
    baseUrl: 'https://api.shuttleai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'textsynth',
    label: 'TextSynth',
    baseUrl: 'https://api.textsynth.com/v1',
    defaultModel: 'mistral-7b-v0.3',
  },
  {
    id: 'naga-ai',
    label: 'Naga AI',
    baseUrl: 'https://api.naga.ac/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'modelscope',
    label: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    defaultModel: 'Qwen/Qwen3-8B',
  },
  {
    id: 'anyscale',
    label: 'Anyscale',
    baseUrl: 'https://api.endpoints.anyscale.com/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'replicate',
    label: 'Replicate',
    baseUrl: 'https://openai.replicate.dev/v1',
    defaultModel: 'meta/meta-llama-3.1-405b-instruct',
  },
  {
    id: 'baseten',
    label: 'Baseten',
    baseUrl: 'https://api.baseten.co/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'lambda',
    label: 'Lambda',
    baseUrl: 'https://api.lambda.ai/v1',
    defaultModel: 'llama3.1-405b-instruct',
  },
  {
    id: 'friendli',
    label: 'FriendliAI',
    baseUrl: 'https://inference.friendli.ai/v1',
    defaultModel: 'meta-llama-3.1-8b-instruct',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
  },
  {
    id: 'lepton',
    label: 'Lepton AI',
    baseUrl: 'https://api.lepton.ai/v1',
    defaultModel: 'llama3.1-70b',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai/v1',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    defaultModel: 'Qwen/Qwen3-8B',
  },
  {
    id: 'featherless',
    label: 'Featherless',
    baseUrl: 'https://api.featherless.ai/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'chutes',
    label: 'Chutes',
    baseUrl: 'https://llm.chutes.ai/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3.1',
  },
  {
    id: 'infermatic',
    label: 'Infermatic',
    baseUrl: 'https://api.infermatic.ai/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'kluster',
    label: 'Kluster.ai',
    baseUrl: 'https://api.kluster.ai/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'parasail',
    label: 'Parasail',
    baseUrl: 'https://api.parasail.io/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'avian',
    label: 'Avian',
    baseUrl: 'https://api.avian.io/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'nebius',
    label: 'Nebius AI Studio',
    baseUrl: 'https://api.studio.nebius.com/v1',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
  },
  {
    id: 'ai21',
    label: 'AI21 Labs',
    baseUrl: 'https://api.ai21.com/studio/v1',
    defaultModel: 'jamba-large',
  },
  {
    id: 'writer',
    label: 'Writer',
    baseUrl: 'https://api.writer.com/v1',
    defaultModel: 'palmyra-x-004',
  },
  {
    id: 'reka',
    label: 'Reka',
    baseUrl: 'https://api.reka.ai/v1',
    defaultModel: 'reka-flash',
  },
  {
    id: 'upstage',
    label: 'Upstage',
    baseUrl: 'https://api.upstage.ai/v1/solar',
    defaultModel: 'solar-pro2',
  },
  {
    id: 'sarvam',
    label: 'Sarvam AI',
    baseUrl: 'https://api.sarvam.ai/v1',
    defaultModel: 'sarvam-m',
  },
  {
    id: 'maritaca',
    label: 'Maritaca AI',
    baseUrl: 'https://api.maritalk.ai/v1',
    defaultModel: 'sabia-3',
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7',
  },
  {
    id: 'z-ai',
    label: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.7',
  },
  {
    id: 'doubao',
    label: 'Doubao (Volcengine)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-M2.1',
  },
  {
    id: 'baichuan',
    label: 'Baichuan',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
  },
  {
    id: 'yi',
    label: '01.AI (Yi)',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    defaultModel: 'yi-lightning',
  },
  {
    id: 'spark',
    label: 'iFlytek Spark',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    defaultModel: 'generalv3.5',
  },
  {
    id: 'qianfan',
    label: 'Baidu Qianfan',
    baseUrl: 'https://qianfan.baidubce.com/v1',
    defaultModel: 'ernie-4.5-turbo-128k',
  },
  {
    id: 'hunyuan',
    label: 'Tencent Hunyuan',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-turbos-latest',
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-2',
  },
  {
    id: 'sensenova',
    label: 'SenseTime SenseNova',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
    defaultModel: 'SenseChat-5-1209',
  },
  {
    id: 'internlm',
    label: 'InternLM',
    baseUrl: 'https://api.internlm.com/v1',
    defaultModel: 'internlm3-8b-instruct',
  },
  {
    id: 'moonshot-cn',
    label: 'Moonshot CN',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2',
  },
  {
    id: 'qwen-cn',
    label: 'Qwen CN (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'ollama-local',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'Qwen/Qwen3-8B',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'text-generation-webui',
    label: 'text-generation-webui',
    baseUrl: 'http://localhost:5000/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'jan',
    label: 'Jan',
    baseUrl: 'http://localhost:1337/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'sglang',
    label: 'SGLang',
    baseUrl: 'http://localhost:30000/v1',
    defaultModel: 'Qwen/Qwen3-8B',
  },
  {
    id: 'tgi',
    label: 'Text Generation Inference',
    baseUrl: 'http://localhost:8080/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'litellm',
    label: 'LiteLLM Proxy (tu host)',
    baseUrl: 'http://localhost:4000/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'open-webui',
    label: 'Open WebUI',
    baseUrl: 'http://localhost:8080/ollama/v1',
    defaultModel: 'qwen3',
  },
  {
    id: 'gpt4all',
    label: 'GPT4All',
    baseUrl: 'http://localhost:4891/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'localai',
    label: 'LocalAI',
    baseUrl: 'http://localhost:8080/v1',
    defaultModel: 'gpt-3.5-turbo',
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    defaultModel: 'qwen3',
  },
  {
    id: 'koboldcpp',
    label: 'KoboldCpp',
    baseUrl: 'http://localhost:5001/v1',
    defaultModel: 'local-model',
  },
];

/** Copies of all presets, in display order. */
export function listCompatiblePresets(): CompatiblePreset[] {
  return COMPATIBLE_PRESETS.map((p) => ({ ...p }));
}

/** One preset by id, or undefined when the id is unknown. Never throws. */
export function resolvePreset(id: string): CompatiblePreset | undefined {
  const found = COMPATIBLE_PRESETS.find((p) => p.id === id);
  return found ? { ...found } : undefined;
}
