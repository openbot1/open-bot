/**
 * ComposioToolkitPrefsSection (v1.20, Doi T4) — the per-toolkit
 * prefs panel in Settings → Connected apps → Composio.
 *
 * Props-driven, it does NOT call IPC directly: the host
 * (SettingsView, via ComposioAppsSection) passes state +
 * callbacks; main connects the callbacks to IPC channels that
 * read/write the v120 prefs store + usage v2 store.
 *
 * What it shows, per toolkit (v120 prefs model):
 * - toolkit on/off (v2 layer — sits under the v119 toolkit
 *   toggle; turning a toolkit off here disables all its
 *   actions for this user)
 * - quota for today: used / cap / remaining + severity
 *   (soft-limit from usage metering v2: ok/warn/alert/blocked)
 * - per-action on/off (each action slug, with its approval
 *   hint) — expanded per toolkit so the list stays short
 * - default params per action (JSON text, validated by the
 *   host against the v120 param-names table; errors come back
 *   through props, never thrown here)
 *
 * i18n: all display strings live in locales/*.json under
 * `settings.composio.prefsV120.*` and are read through useT()
 * — no hard-coded strings in this file.
 */

import { useT } from '../i18n/useT';

export interface ComposioToolkitPrefsActionRow {
  /** Slug action, e.g. 'GMAIL_SEND_EMAIL'. */
  slug: string;
  /** Whether the action is enabled for this user. */
  enabled: boolean;
  /** Whether the action needs approval when run. */
  needsApproval: boolean;
  /** Default params currently saved (shown as JSON). */
  defaultParams: Record<string, unknown>;
  /** Expected param names (empty = no table — any name allowed). */
  paramNames: readonly string[];
  /** Calls today (this user, this action). */
  callsToday: number;
}

export interface ComposioToolkitPrefsRow {
  /** Toolkit slug, e.g. 'gmail'. */
  toolkit: string;
  /** Display name, e.g. 'Gmail (via Composio)'. */
  label: string;
  /** Display icon. */
  icon: string;
  /** Whether the toolkit is enabled for this user (v2 layer). */
  enabled: boolean;
  /** True for mock-only toolkits (never live-verified). */
  mockOnly: boolean;
  /** Calls used today (this user, this toolkit). */
  used: number;
  /** Daily cap for this toolkit. */
  cap: number;
  /** Calls left today before the toolkit is blocked. */
  remaining: number;
  /** Soft-limit severity from usage metering v2. */
  severity: 'ok' | 'warn' | 'alert' | 'blocked';
  /** True when the toolkit is off because of prefs (not quota). */
  disabledByPrefs: boolean;
  /** Actions of this toolkit (shown when expanded). */
  actions: ComposioToolkitPrefsActionRow[];
}

export interface ComposioToolkitPrefsSectionProps {
  /** One row per toolkit the user can configure. */
  toolkits: ComposioToolkitPrefsRow[];
  /** Busy (saving a pref) — buttons are disabled while waiting. */
  busy: boolean;
  /** Toolkit currently expanded (null = all collapsed). */
  expandedToolkit: string | null;
  /** Toggle one toolkit. */
  onToggleToolkit: (toolkit: string, next: boolean) => void;
  /** Toggle one action. */
  onToggleAction: (toolkit: string, slug: string, next: boolean) => void;
  /** Expand/collapse one toolkit (null = collapse all). */
  onExpandToolkit: (toolkit: string | null) => void;
  /** Default-param JSON drafts, keyed `${toolkit}:${slug}`. */
  defaultParamDrafts: Record<string, string>;
  /** Update a default-param draft. */
  onDefaultParamDraftChange: (toolkit: string, slug: string, text: string) => void;
  /** Save a default-param draft (host validates, then persists). */
  onSaveDefaultParams: (toolkit: string, slug: string) => void;
  /** Clear saved default params for one action. */
  onClearDefaultParams: (toolkit: string, slug: string) => void;
  /** Validation errors from the host, keyed `${toolkit}:${slug}`. */
  defaultParamErrors: Record<string, string>;
}

export function ComposioToolkitPrefsSection(props: ComposioToolkitPrefsSectionProps) {
  const t = useT();
  return (
    <div>
      <h4>{t('settings.composio.prefsV120.title')}</h4>
      <p className="hint">{t('settings.composio.prefsV120.intro')}</p>
      {props.toolkits.length === 0 && <p className="hint">{t('settings.composio.prefsV120.empty')}</p>}
      {props.toolkits.map((toolkit) => {
        const expanded = props.expandedToolkit === toolkit.toolkit;
        const quotaText = t('settings.composio.prefsV120.quota', {
          used: String(toolkit.used),
          cap: String(toolkit.cap),
          remaining: String(toolkit.remaining),
        });
        const severityText =
          toolkit.severity === 'blocked'
            ? t('settings.composio.prefsV120.severityBlocked')
            : toolkit.severity === 'alert'
              ? t('settings.composio.prefsV120.severityAlert')
              : toolkit.severity === 'warn'
                ? t('settings.composio.prefsV120.severityWarn')
                : t('settings.composio.prefsV120.severityOk');
        return (
          <div key={toolkit.toolkit}>
            <h4>
              {toolkit.icon} {toolkit.label} —{' '}
              {toolkit.enabled ? t('settings.composio.appEnabled') : t('settings.composio.appDisabled')}
              {toolkit.mockOnly ? ` (${t('settings.composio.prefsV120.mockOnly')})` : ''}
            </h4>
            <p className="hint">
              {quotaText} — {severityText}
              {toolkit.disabledByPrefs ? ` (${t('settings.composio.prefsV120.disabledByPrefs')})` : ''}
            </p>
            <button
              className="btn secondary"
              disabled={props.busy}
              onClick={() => void props.onToggleToolkit(toolkit.toolkit, !toolkit.enabled)}
            >
              {toolkit.enabled ? t('settings.composio.turnOff') : t('settings.composio.turnOn')}
            </button>{' '}
            <button
              className="btn secondary"
              disabled={props.busy}
              onClick={() => void props.onExpandToolkit(expanded ? null : toolkit.toolkit)}
            >
              {expanded
                ? t('settings.composio.prefsV120.collapse')
                : t('settings.composio.prefsV120.expand')}
            </button>
            {expanded && (
              <div>
                {toolkit.actions.map((action) => {
                  const draftKey = `${toolkit.toolkit}:${action.slug}`;
                  const draft = props.defaultParamDrafts[draftKey] ?? JSON.stringify(action.defaultParams);
                  const error = props.defaultParamErrors[draftKey];
                  return (
                    <div key={action.slug}>
                      <span>
                        {action.slug} —{' '}
                        {action.enabled ? t('settings.composio.appEnabled') : t('settings.composio.appDisabled')}
                        {action.needsApproval ? ` (${t('settings.composio.prefsV120.needsApproval')})` : ''} —{' '}
                        {t('settings.composio.prefsV120.callsToday', { calls: String(action.callsToday) })}
                      </span>{' '}
                      <button
                        className="btn secondary"
                        disabled={props.busy || !toolkit.enabled}
                        onClick={() => void props.onToggleAction(toolkit.toolkit, action.slug, !action.enabled)}
                      >
                        {action.enabled ? t('settings.composio.turnOff') : t('settings.composio.turnOn')}
                      </button>
                      <div>
                        <label htmlFor={`composio-prefs-${toolkit.toolkit}-${action.slug}`}>
                          {t('settings.composio.prefsV120.defaultParams')}
                        </label>{' '}
                        <input
                          id={`composio-prefs-${toolkit.toolkit}-${action.slug}`}
                          type="text"
                          autoComplete="off"
                          disabled={props.busy || !toolkit.enabled}
                          value={draft}
                          placeholder={
                            action.paramNames.length > 0
                              ? t('settings.composio.prefsV120.defaultParamsPlaceholder', {
                                  params: action.paramNames.join(', '),
                                })
                              : t('settings.composio.prefsV120.defaultParamsPlaceholderAny')
                          }
                          onChange={(e) =>
                            props.onDefaultParamDraftChange(toolkit.toolkit, action.slug, e.target.value)
                          }
                        />{' '}
                        <button
                          className="btn secondary"
                          disabled={props.busy || !toolkit.enabled}
                          onClick={() => void props.onSaveDefaultParams(toolkit.toolkit, action.slug)}
                        >
                          {t('settings.composio.prefsV120.saveParams')}
                        </button>{' '}
                        <button
                          className="btn secondary"
                          disabled={props.busy || !toolkit.enabled || Object.keys(action.defaultParams).length === 0}
                          onClick={() => void props.onClearDefaultParams(toolkit.toolkit, action.slug)}
                        >
                          {t('settings.composio.prefsV120.clearParams')}
                        </button>
                        {error && <p className="error">{error}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
