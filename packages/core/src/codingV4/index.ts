/**
 * Coding agent v4 (v1.11, Doi T4) — repo map PageRank v2, sub-agent
 * task visualizer trong chat UI, ACP-style model switching giua cac
 * run, Agent Profiles theo loai task coding.
 *
 * Y tuong hoc tu OpenHands 1.39/1.40 (ACP model switching, sub-agent
 * task visualizer, Agent Profiles) — chi hoc y tuong, tu thiet ke va
 * viet lai hoan toan tu dau, KHONG doc, KHONG copy code/text/tai san
 * cua bat ky repo nao, cua xAI/Cursor.
 *
 * Local-first: khong X, khong Grok Imagine, khong cloud VM/tai khoan/
 * thanh toan. Profile coding nam rieng trong module `coding-profiles`
 * (codingV4) — khong dung file cua T2 (Agent Profiles chung).
 */

export * from './repoMapV4';
export * from './subagentVisualizer';
export * from './modelSwitch';
export * from './codingProfiles';
