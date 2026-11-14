/**
 * ContextV2Panel (v1.05, Team T4) — per-bot compaction policy +
 * savings preview + 1M-token window inspector.
 *
 * Presentational panel: the host passes the bot's policy, the live
 * window stats, and the inspector tree, plus callbacks for saving
 * a policy, applying a preset, computing a preview, and exporting
 * a snapshot. Data plumbing (IPC `context-v2:*`) is host work;
 * this file owns the form, the preview rendering, and the tree.
 *
 * Every display string goes through i18n (`contextV2.*`); the file
 * contains no hard-coded Vietnamese (see tests/i18n.test.mjs).
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

export interface ContextV2PolicyView {
  triggerRatio: number;
  maxTier: 1 | 2 | 3;
  keepAnchorKinds: string[];
  keepRecentTurns: number;
  frequency: 'per-turn' | 'hourly' | 'manual';
}

export interface ContextV2StatsView {
  limit: number;
  usedTokens: number;
  usageRatio: number;
  thresholdsCrossed: string[];
  segmentCount: number;
  spilledCount: number;
  byKind: Record<string, { count: number; tokens: number }>;
}

export interface ContextV2TreeNodeView {
  id: string;
  kind: string;
  tier?: 1 | 2 | 3;
  tokens: number;
  sourceIds: string[];
  spilled: boolean;
  preview: string;
}

export interface ContextV2TreeGroupView {
  kind: string;
  count: number;
  tokens: number;
  nodes: ContextV2TreeNodeView[];
}

export interface ContextV2PreviewView {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  savedRatio: number;
  turnsCompacted: number;
  turnsKept: number;
  tier1Summaries: number;
  tier2Summaries: number;
  tier3Summary: boolean;
  anchorsKept: number;
}

export interface ContextV2PolicyPatch {
  triggerRatio?: number;
  maxTier?: 1 | 2 | 3;
  keepAnchorKinds?: string[];
  keepRecentTurns?: number;
  frequency?: 'per-turn' | 'hourly' | 'manual';
}

export interface ContextV2ScheduleView {
  frequency: string;
  lastRunAt: string | null;
  nextAllowedAt: string | null;
  runsTotal: number;
  due: boolean;
}

export interface ContextV2AssemblyView {
  messageCount: number;
  tokensUsed: number;
  tokenBudget: number;
  droppedCount: number;
  manifest: string;
}

interface Props {
  policy: ContextV2PolicyView;
  stats: ContextV2StatsView | null;
  tree: ContextV2TreeGroupView[] | null;
  preview: ContextV2PreviewView | null;
  previewLoading?: boolean;
  schedule?: ContextV2ScheduleView | null;
  assembly?: ContextV2AssemblyView | null;
  onSavePolicy: (patch: ContextV2PolicyPatch) => void;
  onApplyPreset: (preset: string) => void;
  onPreview: () => void;
  onExportSnapshot: () => void;
  onBack: () => void;
}

const ANCHOR_KINDS = ['decision', 'metric', 'file-change', 'constraint', 'fact'];
const PRESETS = ['chat', 'coding', 'long-run', 'minimal'];
const FREQUENCIES: Array<'per-turn' | 'hourly' | 'manual'> = ['per-turn', 'hourly', 'manual'];

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export default function ContextV2Panel({
  policy,
  stats,
  tree,
  preview,
  previewLoading,
  schedule,
  assembly,
  onSavePolicy,
  onApplyPreset,
  onPreview,
  onExportSnapshot,
  onBack,
}: Props) {
  const t = useT();
  const [trigger, setTrigger] = useState(String(Math.round(policy.triggerRatio * 100)));
  const [maxTier, setMaxTier] = useState(String(policy.maxTier));
  const [keepRecent, setKeepRecent] = useState(String(policy.keepRecentTurns));
  const [frequency, setFrequency] = useState(policy.frequency);
  const [anchorKinds, setAnchorKinds] = useState<string[]>([...policy.keepAnchorKinds]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setTrigger(String(Math.round(policy.triggerRatio * 100)));
    setMaxTier(String(policy.maxTier));
    setKeepRecent(String(policy.keepRecentTurns));
    setFrequency(policy.frequency);
    setAnchorKinds([...policy.keepAnchorKinds]);
  }, [policy]);

  const toggleAnchorKind = (kind: string) => {
    setAnchorKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  };

  const save = () => {
    const triggerRatio = Math.max(50, Math.min(98, Number(trigger) || 80)) / 100;
    const tier = Number(maxTier);
    onSavePolicy({
      triggerRatio,
      maxTier: (tier === 1 || tier === 2 || tier === 3 ? tier : 3) as 1 | 2 | 3,
      keepRecentTurns: Math.max(0, Math.min(50, Number(keepRecent) || 0)),
      frequency,
      keepAnchorKinds: anchorKinds,
    });
    setNotice(t('contextV2.saved'));
  };

  const usageRatio = stats ? stats.usageRatio : 0;
  const usageClass = usageRatio >= 0.95 ? 'error' : usageRatio >= 0.8 ? 'hint' : 'hint';

  return (
    <div style={{ padding: 16, maxWidth: 860 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn secondary" onClick={onBack}>
          {t('contextV2.back')}
        </button>
        <h2 style={{ margin: 0 }}>{t('contextV2.title')}</h2>
      </div>
      <p className="hint">{t('contextV2.subtitle')}</p>

      <h3>{t('contextV2.policyTitle')}</h3>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {PRESETS.map((preset) => (
          <button
            key={preset}
            className="btn secondary"
            onClick={() => {
              onApplyPreset(preset);
              setNotice(t('contextV2.presetApplied'));
            }}
          >
            {t(`contextV2.preset${preset.charAt(0).toUpperCase()}${preset.slice(1).replace('-r', 'R')}`)}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <label>
          {t('contextV2.triggerLabel')}
          <input
            type="number"
            min={50}
            max={98}
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
          <span className="hint">{t('contextV2.triggerHint')}</span>
        </label>
        <label>
          {t('contextV2.maxTierLabel')}
          <select value={maxTier} onChange={(e) => setMaxTier(e.target.value)}>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <label>
          {t('contextV2.keepRecentLabel')}
          <input
            type="number"
            min={0}
            max={50}
            value={keepRecent}
            onChange={(e) => setKeepRecent(e.target.value)}
          />
        </label>
        <label>
          {t('contextV2.frequencyLabel')}
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {t(`contextV2.frequency${f === 'per-turn' ? 'PerTurn' : f === 'hourly' ? 'Hourly' : 'Manual'}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div>{t('contextV2.anchorsLabel')}</div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {ANCHOR_KINDS.map((kind) => (
            <label key={kind} style={{ display: 'flex', gap: 4, alignItems: 'center', width: 'auto' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={anchorKinds.includes(kind)}
                onChange={() => toggleAnchorKind(kind)}
              />
              {t(`contextV2.anchor${kind.charAt(0).toUpperCase()}${kind.slice(1).replace('-c', 'C')}`)}
            </label>
          ))}
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={save}>
          {t('contextV2.savePolicy')}
        </button>
        <button className="btn secondary" onClick={onPreview} disabled={previewLoading}>
          {t('contextV2.previewButton')}
        </button>
        {notice && <span className="hint">{notice}</span>}
      </div>

      <h3>{t('contextV2.previewTitle')}</h3>
      {preview ? (
        <div>
          <p>
            {t('contextV2.tokensBefore')}: {formatTokens(preview.tokensBefore)} ·{' '}
            {t('contextV2.tokensAfter')}: {formatTokens(preview.tokensAfter)} ·{' '}
            {t('contextV2.tokensSaved')}: {formatTokens(preview.tokensSaved)} ({pct(preview.savedRatio)})
          </p>
          <p className="hint">
            {t('contextV2.turnsCompacted')}: {preview.turnsCompacted} ·{' '}
            {t('contextV2.turnsKept')}: {preview.turnsKept} ·{' '}
            {t('contextV2.summariesBuilt')}: {preview.tier1Summaries + preview.tier2Summaries + (preview.tier3Summary ? 1 : 0)} ·{' '}
            {t('contextV2.anchorsKept')}: {preview.anchorsKept}
          </p>
        </div>
      ) : (
        <p className="hint">{t('contextV2.previewEmpty')}</p>
      )}

      <h3>{t('contextV2.windowTitle')}</h3>
      {stats ? (
        <div>
          <p className={usageClass}>
            {t('contextV2.usageLabel')}: {formatTokens(stats.usedTokens)} / {formatTokens(stats.limit)} ({pct(stats.usageRatio)})
            {stats.thresholdsCrossed.length > 0 &&
              ` — ${t('contextV2.thresholdsLabel')}: ${stats.thresholdsCrossed.join(', ')}`}
          </p>
          <div
            style={{
              height: 10,
              borderRadius: 5,
              background: 'var(--border)',
              overflow: 'hidden',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: `${Math.min(100, usageRatio * 100)}%`,
                height: '100%',
                background: usageRatio >= 0.95 ? '#c0392b' : usageRatio >= 0.8 ? '#e67e22' : '#27ae60',
              }}
            />
          </div>
          <p className="hint">
            {t('contextV2.segmentsLabel')}: {stats.segmentCount} · {t('contextV2.spilledLabel')}: {stats.spilledCount}
          </p>
        </div>
      ) : (
        <p className="hint">{t('contextV2.noStats')}</p>
      )}

      <h3>{t('contextV2.scheduleTitle')}</h3>
      {schedule ? (
        <p className="hint">
          {t('contextV2.scheduleFrequency')}: {schedule.frequency} ·{' '}
          {t('contextV2.scheduleLastRun')}: {schedule.lastRunAt ?? t('contextV2.scheduleNever')} ·{' '}
          {t('contextV2.scheduleNext')}: {schedule.nextAllowedAt ?? t('contextV2.scheduleNow')} ·{' '}
          {t('contextV2.scheduleRuns')}: {schedule.runsTotal} ·{' '}
          {t('contextV2.scheduleDue')}: {schedule.due ? t('contextV2.scheduleYes') : t('contextV2.scheduleNo')}
        </p>
      ) : (
        <p className="hint">{t('contextV2.scheduleEmpty')}</p>
      )}

      <h3>{t('contextV2.assemblyTitle')}</h3>
      {assembly ? (
        <p className="hint">
          {t('contextV2.assemblyMessages')}: {assembly.messageCount} ·{' '}
          {formatTokens(assembly.tokensUsed)} / {formatTokens(assembly.tokenBudget)} tokens ·{' '}
          {t('contextV2.assemblyDropped')}: {assembly.droppedCount}
        </p>
      ) : (
        <p className="hint">{t('contextV2.assemblyEmpty')}</p>
      )}

      <h3>{t('contextV2.inspectorTitle')}</h3>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn secondary" onClick={onExportSnapshot}>
          {t('contextV2.exportSnapshot')}
        </button>
      </div>
      {tree && tree.some((g) => g.count > 0) ? (
        tree
          .filter((g) => g.count > 0)
          .map((group) => (
            <details key={group.kind} style={{ marginBottom: 8 }}>
              <summary>
                {group.kind} — {group.count} · {formatTokens(group.tokens)} tokens
              </summary>
              <ul style={{ fontSize: 13 }}>
                {group.nodes.map((node) => (
                  <li key={node.id}>
                    <code>{node.id}</code>
                    {node.tier ? ` (${t('contextV2.tierLabel')} ${node.tier})` : ''} ·{' '}
                    {formatTokens(node.tokens)} tokens
                    {node.spilled ? ` · ${t('contextV2.spilledBadge')}` : ''} — {node.preview}
                  </li>
                ))}
              </ul>
            </details>
          ))
      ) : (
        <p className="hint">{t('contextV2.noSegments')}</p>
      )}
    </div>
  );
}
