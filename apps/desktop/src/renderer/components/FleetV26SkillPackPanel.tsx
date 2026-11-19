import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v26 skill-pack panel (v1.39, Team T6) — the shared skill pack
 * for the whole fleet, with progressive disclosure built into the UI
 * itself: the list shows tier-1 metadata only (name + description,
 * ~100 tokens each); a skill body loads only when the user opens that
 * skill; scripts/assets stay lazy behind their own toggle.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV26SkillPackPanel` via IPC; bodies arrive through
 * `onLoadBody`); when there is no host wiring yet it uses an internal
 * demo store — the component never guesses real numbers; the demo is
 * clearly labelled in code.
 */

export interface FleetV26SkillMetadataView {
  name: string;
  description: string;
  metadataTokens: number;
  version: string;
  triggers: string[];
  allowedTools: string[];
  argumentHint: string | null;
}

export interface FleetV26SkillPackPanelView {
  summary: string;
  counts: { skills: number; metadataTokens: number; bodiesLoaded: number; files: number };
  metadata: FleetV26SkillMetadataView[];
  loadedBodies: string[];
}

export function demoFleetV26SkillPackPanel(): FleetV26SkillPackPanelView {
  return {
    summary: '2 skill(s) in the pack, ~24 metadata tokens at startup, 0 bod(ies) loaded on demand, 1 lazy file(s)',
    counts: { skills: 2, metadataTokens: 24, bodiesLoaded: 0, files: 1 },
    metadata: [
      {
        name: 'code-review', description: 'Review a diff for bugs, security issues and style.', metadataTokens: 13,
        version: '1.0.0', triggers: ['review', 'diff'], allowedTools: ['read-file', 'run-tests'], argumentHint: '<diff> [--fix]',
      },
      {
        name: 'verify', description: 'Verify a claim against the repo before stating it.', metadataTokens: 11,
        version: '1.0.0', triggers: ['verify', 'check'], allowedTools: ['read-file'], argumentHint: '<claim>',
      },
    ],
    loadedBodies: [],
  };
}

export interface FleetV26SkillPackPanelProps {
  panel?: FleetV26SkillPackPanelView;
  /** Host loads a skill body on demand (tier 2); returns the body text. */
  onLoadBody?: (name: string) => Promise<string | null>;
}

export default function FleetV26SkillPackPanel({ panel, onLoadBody }: FleetV26SkillPackPanelProps) {
  const t = useT();
  const view = useMemo(() => panel ?? demoFleetV26SkillPackPanel(), [panel]);
  const [query, setQuery] = useState('');
  const [openName, setOpenName] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const visible = q
    ? view.metadata.filter(
        (m) =>
          m.name.includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.triggers.some((tr) => tr.includes(q)),
      )
    : view.metadata;

  const openSkill = async (name: string) => {
    if (openName === name) {
      setOpenName(null);
      return;
    }
    setOpenName(name);
    if (bodies[name] !== undefined || !onLoadBody) return;
    setLoading(name);
    try {
      const body = await onLoadBody(name);
      if (body !== null) setBodies((prev) => ({ ...prev, [name]: body }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <section aria-label={t('fleet.v26.skillPack')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header>
        <h2 style={{ margin: 0 }}>{t('fleet.v26.skillPack')}</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{view.summary}</p>
        <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.8 }}>{t('fleet.v26.skillPackHint')}</p>
      </header>

      <label style={{ fontSize: 13 }}>
        {t('fleet.v26.skillSearch')}{' '}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="review…" style={{ minWidth: 220 }} />
      </label>

      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map((m) => {
          const open = openName === m.name;
          const body = bodies[m.name];
          return (
            <li key={m.name} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{m.name}</strong>
                <span style={{ fontSize: 12, opacity: 0.7 }}>v{m.version} · ~{m.metadataTokens} {t('fleet.v26.tokens')}</span>
                <button type="button" onClick={() => void openSkill(m.name)} style={{ marginLeft: 'auto' }}>
                  {open ? t('fleet.v26.hideDetails') : t('fleet.v26.skillLoadBody')}
                </button>
              </div>
              <p style={{ margin: '4px 0', fontSize: 13 }}>{m.description}</p>
              <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>
                {t('fleet.v26.skillTriggers', { triggers: m.triggers.length === 0 ? '—' : m.triggers.join(', ') })}
                {m.argumentHint ? ` · ${m.argumentHint}` : ''}
                {m.allowedTools.length > 0 ? ` · ${t('fleet.v26.skillAllowedTools', { tools: m.allowedTools.join(', ') })}` : ''}
              </p>
              {open ? (
                <div style={{ marginTop: 8 }}>
                  {loading === m.name ? (
                    <p style={{ margin: 0, fontSize: 13 }}>{t('fleet.v26.skillLoading')}</p>
                  ) : body !== undefined ? (
                    <pre style={{ margin: 0, padding: 8, background: 'var(--hatch-widget-surface-muted, #f5f5f5)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>{body}</pre>
                  ) : (
                    <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v26.skillBodyUnavailable')}</p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
        {visible.length === 0 ? <li style={{ fontSize: 13, opacity: 0.8 }}>{t('fleet.v26.skillEmpty')}</li> : null}
      </ul>
    </section>
  );
}
