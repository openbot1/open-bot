import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Voice v24 dynamic model picker (v1.37, Team T5) — the
 * model picker for a running voice session.
 *
 * Unlike the static picker, this one lists whatever the
 * dynamic provider catalogue holds *at the moment it
 * opens*: no hard-coded provider or model list. Each
 * provider shows its live status (online / degraded /
 * unknown / offline / unconfigured) and its account label
 * (never a secret); a provider that cannot be used is
 * shown dimmed with a plain-language reason instead of
 * silently disappearing. Selecting a model switches the
 * live voice session to it while the transcript stays
 * exactly where it was — the host confirms the switch and
 * reports the transcript turn count kept.
 *
 * Data comes via props (host builds the view-model from the
 * core `DynamicProviderCatalogV24` snapshot via IPC); when
 * there is no host wiring yet it uses an internal demo
 * store — the component never guesses real numbers; the
 * demo is clearly labelled in code.
 */

export type VoiceV24ProviderStatusView =
  | 'online'
  | 'offline'
  | 'unconfigured'
  | 'degraded'
  | 'unknown';

export interface VoiceV24PickerModelView {
  id: string;
  label: string;
  supportsVoice?: boolean;
  deprecated?: boolean;
}

export interface VoiceV24PickerProviderView {
  id: string;
  label: string;
  kind: 'subscription' | 'api' | 'custom' | 'local';
  status: VoiceV24ProviderStatusView;
  models: VoiceV24PickerModelView[];
  configured: boolean;
  accountLabel?: string;
  hasUsableModel: boolean;
}

export interface VoiceV24ModelSelection {
  providerId: string;
  model: string;
}

export interface VoiceV24ModelPickerView {
  providers: VoiceV24PickerProviderView[];
  current: VoiceV24ModelSelection;
  /** Transcript turns the last switch kept (null when no switch yet). */
  lastSwitchKeptTurns: number | null;
  updatedAtMs: number;
}

export function demoVoiceV24ModelPicker(): VoiceV24ModelPickerView {
  return {
    providers: [
      {
        id: 'codex',
        label: 'Codex',
        kind: 'subscription',
        status: 'online',
        models: [
          { id: 'gpt-5.2', label: 'GPT-5.2', supportsVoice: true },
          { id: 'gpt-5.2-mini', label: 'GPT-5.2 mini', supportsVoice: true },
        ],
        configured: true,
        accountLabel: 'demo@example.com',
        hasUsableModel: true,
      },
      {
        id: 'ollama',
        label: 'Ollama (local)',
        kind: 'local',
        status: 'degraded',
        models: [{ id: 'qwen3:8b', label: 'Qwen3 8B', supportsVoice: false }],
        configured: true,
        hasUsableModel: true,
      },
      {
        id: 'openai',
        label: 'OpenAI',
        kind: 'api',
        status: 'unconfigured',
        models: [{ id: 'gpt-5.2', label: 'GPT-5.2', supportsVoice: true }],
        configured: false,
        hasUsableModel: true,
      },
    ],
    current: { providerId: 'codex', model: 'gpt-5.2' },
    lastSwitchKeptTurns: null,
    updatedAtMs: 0,
  };
}

function statusKey(status: VoiceV24ProviderStatusView): string {
  switch (status) {
    case 'online':
      return 'voice.v24.providers.online';
    case 'offline':
      return 'voice.v24.providers.offline';
    case 'unconfigured':
      return 'voice.v24.providers.unconfigured';
    case 'degraded':
      return 'voice.v24.providers.degraded';
    case 'unknown':
      return 'voice.v24.providers.unknown';
  }
}

/** Plain-language reason a provider cannot be picked right now. */
export function unusableReasonV24View(
  provider: VoiceV24PickerProviderView,
  t: (key: string) => string,
): string | null {
  if (provider.status === 'unconfigured') return t('voice.v24.providers.unusableUnconfigured');
  if (provider.status === 'offline') return t('voice.v24.providers.unusableOffline');
  if (provider.status === 'unknown') return t('voice.v24.providers.unusableUnknown');
  if (!provider.hasUsableModel) return t('voice.v24.providers.unusableNoModels');
  if (provider.models.length === 0) return t('voice.v24.providers.unusableNoModels');
  return null;
}

export function isUsableProviderV24View(provider: VoiceV24PickerProviderView): boolean {
  return (
    (provider.status === 'online' || provider.status === 'degraded') &&
    provider.hasUsableModel &&
    provider.models.length > 0
  );
}

export default function VoiceV24ModelPicker({
  picker: pickerProp,
  onSelect,
  onRefresh,
}: {
  picker?: VoiceV24ModelPickerView | null;
  /** Called when the user picks a model; the host switches the live session. */
  onSelect?: (selection: VoiceV24ModelSelection) => void;
  /** Re-probe providers and reload the catalogue (optional). */
  onRefresh?: () => void;
}) {
  const t = useT();
  const [picker] = useState<VoiceV24ModelPickerView>(() => pickerProp ?? demoVoiceV24ModelPicker());
  const [expanded, setExpanded] = useState<string | null>(picker.current.providerId);
  const [switching, setSwitching] = useState(false);

  const usableCount = useMemo(
    () => picker.providers.filter(isUsableProviderV24View).length,
    [picker],
  );

  const handleSelect = (selection: VoiceV24ModelSelection) => {
    if (selection.providerId === picker.current.providerId && selection.model === picker.current.model) {
      return;
    }
    setSwitching(true);
    try {
      onSelect?.(selection);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <section aria-label={t('voice.v24.providers.title')}>
      <h2>{t('voice.v24.providers.title')}</h2>
      <p>
        {t('voice.v24.providers.usable')}: {usableCount} / {picker.providers.length}
      </p>
      {onRefresh !== undefined && (
        <button type="button" onClick={onRefresh}>
          {t('voice.v24.providers.refresh')}
        </button>
      )}
      {picker.lastSwitchKeptTurns !== null && (
        <p>
          {t('voice.v24.model.switched')} — {t('voice.v24.panel.transcriptKept')}:{' '}
          {picker.lastSwitchKeptTurns}
        </p>
      )}
      {picker.providers.length === 0 ? (
        <p>{t('voice.v24.providers.noProviders')}</p>
      ) : (
        <ul>
          {picker.providers.map((provider) => {
            const usable = isUsableProviderV24View(provider);
            const reason = unusableReasonV24View(provider, t);
            const isCurrentProvider = provider.id === picker.current.providerId;
            const isOpen = expanded === provider.id;
            return (
              <li key={provider.id} data-status={provider.status} aria-disabled={!usable}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : provider.id)}
                  aria-expanded={isOpen}
                >
                  {provider.label} — {t(statusKey(provider.status))}
                  {isCurrentProvider ? ` (${t('voice.v24.panel.currentModel')})` : ''}
                </button>
                {provider.accountLabel !== undefined && <span> {provider.accountLabel}</span>}
                {!usable && reason !== null && <span> — {reason}</span>}
                {isOpen && (
                  <ul>
                    {provider.models.length === 0 ? (
                      <li>{t('voice.v24.providers.unusableNoModels')}</li>
                    ) : (
                      provider.models.map((model) => {
                        const isCurrent =
                          isCurrentProvider && model.id === picker.current.model;
                        const disabled = !usable || model.deprecated === true;
                        return (
                          <li key={model.id}>
                            <button
                              type="button"
                              disabled={disabled || switching}
                              onClick={() =>
                                handleSelect({ providerId: provider.id, model: model.id })
                              }
                            >
                              {model.label ?? model.id}
                              {isCurrent ? ` (${t('voice.v24.panel.currentModel')})` : ''}
                              {model.deprecated === true ? ' (deprecated)' : ''}
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
