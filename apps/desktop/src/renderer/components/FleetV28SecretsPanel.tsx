import { useT } from '../i18n/useT';

/**
 * Fleet v28 secrets panel (v1.41, Team T6) — profile-scoped secrets:
 * names + versions + rotation history for ONE profile. Secret values
 * are NEVER shown here — the panel only ever receives metadata
 * (see core `buildFleetV28SecretsPanel`); a value is shown as the
 * `[REDACTED]` placeholder by design, never as real text.
 *
 * Data comes via props (host builds the view-model from core via
 * IPC); when there is no host wiring yet it uses an internal demo
 * store — the component never guesses real numbers; the demo is
 * clearly labelled in code.
 */

export interface FleetV28SecretsPanelView {
  profileId: string;
  summary: string;
  secrets: Array<{
    name: string;
    version: number;
    createdAtMs: number;
    updatedAtMs: number;
    rotatedAtMs: number | null;
    hasGraceValue: boolean;
  }>;
  recentAudit: Array<{ name: string; action: string; version: number; atMs: number; note: string }>;
}

export function demoFleetV28SecretsPanel(): FleetV28SecretsPanelView {
  const now = Date.now();
  return {
    profileId: 'bot-demo',
    summary: 'Demo fleet v28 secrets panel (no host wiring yet).',
    secrets: [
      { name: 'api-key', version: 2, createdAtMs: now - 86_400_000, updatedAtMs: now - 3600_000, rotatedAtMs: now - 3600_000, hasGraceValue: true },
      { name: 'webhook-token', version: 1, createdAtMs: now - 86_400_000, updatedAtMs: now - 86_400_000, rotatedAtMs: null, hasGraceValue: false },
    ],
    recentAudit: [
      { name: 'api-key', action: 'rotate', version: 2, atMs: now - 3600_000, note: 'Secret rotated to version 2 (old value kept 300000ms).' },
      { name: 'webhook-token', action: 'set', version: 1, atMs: now - 86_400_000, note: 'Secret created.' },
    ],
  };
}

export default function FleetV28SecretsPanel({ panel }: { panel?: FleetV28SecretsPanelView }) {
  const t = useT();
  const view = panel ?? demoFleetV28SecretsPanel();
  return (
    <section aria-label={t('fleet.v28.secretsTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v28.secretsTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v28.secretProfile')}: <strong>{view.profileId}</strong> · {t('fleet.v28.secrets')}:{' '}
        {view.secrets.length}
      </p>
      {view.secrets.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.noSecrets')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.secrets.map((s) => (
            <li key={s.name}>
              <strong>{s.name}</strong> — {t('fleet.v28.secretVersion')}: {s.version} ·{' '}
              {t('fleet.v28.secretCreated')}: {new Date(s.createdAtMs).toLocaleDateString()}
              {s.rotatedAtMs !== null ? ` · ${t('fleet.v28.secretRotated')}: ${new Date(s.rotatedAtMs).toLocaleDateString()}` : ''}
              <br />
              <span style={{ fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.redacted')}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 style={{ margin: '4px 0 0', fontSize: 14 }}>{t('fleet.v28.history')}</h3>
      {view.recentAudit.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v28.noSecrets')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {view.recentAudit.map((e) => (
            <li key={`${e.name}-${e.atMs}-${e.action}`}>
              <strong>{e.name}</strong> — {e.action} (v{e.version}) · {new Date(e.atMs).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
