/**
 * DoctorTeamPanel — Doctor + Team + Engine picker (v1.06, Team T5 — UI v3).
 *
 * Three sections, one screen, all wired to real services:
 *
 * - Doctor: runs the checks in doctorChecks.ts (detected engines,
 *   Ollama, memory health, failing MCP tasks, loaded team) and shows
 *   a pass/warn/fail checklist. There is no `doctor` command in the
 *   repo yet — the panel aggregates the signals the app already
 *   exposes instead of inventing a backend.
 * - Team: the team from `team:get` (name, members, shared bots) plus
 *   the portable export/import flow (`team:export` / `team:import` /
 *   `team:import-apply`, same conflict handling as TeamView — a
 *   conflicting import waits for "only what's new" vs "overwrite
 *   all", never overwrites silently).
 * - Engine picker: the model rail (`models:rail`) filtered to CLI
 *   drivers (entries with a `detectedKind`) plus Ollama; picking a
 *   driver + model for a bot saves it with `bots:update`.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  ProviderRailEntryView,
  ProviderRailView,
  TeamBundleView,
  TeamConfigLike,
  TeamImportConflictView,
  TeamImportSummaryView,
} from '../types';
import {
  DOCTOR_CHECK_LABEL_KEYS,
  runDoctorChecks,
  type DoctorCheckResult,
} from './doctorChecks';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
  /** Called with the saved bot after the engine picker writes it. */
  onBotUpdated: (bot: BotConfigLike) => void;
  onBack: () => void;
}

/** Static doctor status -> i18n key map (kept literal so the key scan finds every key). */
const STATUS_KEYS: Record<DoctorCheckResult['status'], string> = {
  pass: 'doctorTeam.status.pass',
  warn: 'doctorTeam.status.warn',
  fail: 'doctorTeam.status.fail',
};

/** Rail entries a bot can actually run on: CLI drivers + local Ollama. */
function engineEntries(rail: ProviderRailView | null): ProviderRailEntryView[] {
  if (!rail) return [];
  return rail.entries.filter(
    (e) => e.selectable && (e.detectedKind !== undefined || e.providerId === 'ollama'),
  );
}

export default function DoctorTeamPanel({ bots, botId, onSelectBot, onBotUpdated, onBack }: Props) {
  const t = useT();
  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  // ---- Doctor ----
  const [checks, setChecks] = useState<DoctorCheckResult[] | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorError, setDoctorError] = useState('');

  const runDoctor = async () => {
    setDoctorRunning(true);
    setDoctorError('');
    try {
      setChecks(await runDoctorChecks(window.openBot, activeBot?.id ?? null));
    } catch (e) {
      setDoctorError(e instanceof Error ? e.message : t('doctorTeam.loadError'));
    } finally {
      setDoctorRunning(false);
    }
  };

  // ---- Team ----
  const [team, setTeam] = useState<TeamConfigLike | null>(null);
  const [sharedBotIds, setSharedBotIds] = useState<string[]>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [teamError, setTeamError] = useState('');
  const [teamNotice, setTeamNotice] = useState('');
  const [teamBusy, setTeamBusy] = useState<string | null>(null);
  const [importPending, setImportPending] = useState<{
    summary: TeamImportSummaryView;
    conflicts: TeamImportConflictView[];
    bundle: TeamBundleView;
  } | null>(null);

  const loadTeam = async () => {
    setTeamLoading(true);
    setTeamError('');
    try {
      const [teamConfig, shared] = await Promise.all([
        window.openBot.getTeam(),
        window.openBot.listSharedBots(),
      ]);
      setTeam(teamConfig);
      setSharedBotIds(shared);
    } catch {
      setTeamError(t('team.loadError'));
    } finally {
      setTeamLoading(false);
    }
  };

  useEffect(() => {
    void loadTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doExportTeam = async () => {
    setTeamBusy('export');
    setTeamError('');
    setTeamNotice('');
    try {
      const res = await window.openBot.exportTeam();
      if (res.cancelled) return;
      let msg = t('team.exportSaved', { path: res.path });
      if (res.skippedSkills.length > 0) {
        const parts = res.skippedSkills.map((s) =>
          s.reason === 'oversize'
            ? t('team.exportSkippedOversize', { name: s.name, chars: String(s.chars), max: String(200000) })
            : t('team.exportSkippedEmpty', { name: s.name }),
        );
        msg += ` ${parts.join(' ')}`;
      }
      setTeamNotice(msg);
    } catch {
      setTeamError(t('team.exportError'));
    } finally {
      setTeamBusy(null);
    }
  };

  const applyImport = async (bundle: TeamBundleView, overwrite: boolean) => {
    setImportPending(null);
    setTeamBusy('import');
    setTeamError('');
    setTeamNotice('');
    try {
      const res = await window.openBot.importTeamApply({ bundle, overwrite });
      const r = res.report;
      let msg = t('team.importDone', {
        bots: String(r.botsAdded + r.botsReplaced),
        automations: String(r.automationsAdded + r.automationsReplaced),
        skills: String(r.skillsWritten),
      });
      if (res.skipped.length > 0) {
        msg += ` ${t('team.importSkipped', { count: String(res.skipped.length) })}`;
      }
      if (r.webhookDisabled > 0) {
        msg += ` ${t('team.importWebhooksDisabled', { count: String(r.webhookDisabled) })}`;
      }
      if (res.failures.length > 0) {
        setTeamError(res.failures.join('\n'));
      }
      setTeamNotice(msg);
      await loadTeam();
    } catch (e) {
      setTeamError(t('team.importError', { error: e instanceof Error ? e.message : t('team.loadError') }));
    } finally {
      setTeamBusy(null);
    }
  };

  const doImportTeam = async () => {
    setTeamBusy('import');
    setTeamError('');
    setTeamNotice('');
    try {
      const res = await window.openBot.importTeam();
      if (res.cancelled) return;
      if (res.conflicts.length === 0) {
        await applyImport(res.bundle, false);
      } else {
        setImportPending({ summary: res.summary, conflicts: res.conflicts, bundle: res.bundle });
      }
    } catch (e) {
      setTeamError(t('team.importError', { error: e instanceof Error ? e.message : t('team.loadError') }));
    } finally {
      setTeamBusy(null);
    }
  };

  // ---- Engine picker ----
  const [rail, setRail] = useState<ProviderRailView | null>(null);
  const [railError, setRailError] = useState('');
  const [redetecting, setRedetecting] = useState(false);
  const [pickedProviderId, setPickedProviderId] = useState('');
  const [pickedModel, setPickedModel] = useState('');
  const [savingEngine, setSavingEngine] = useState(false);
  const [engineNotice, setEngineNotice] = useState('');
  const [engineError, setEngineError] = useState('');

  const loadRail = async () => {
    setRailError('');
    try {
      setRail(await window.openBot.listModelRail());
    } catch {
      setRailError(t('doctorTeam.loadError'));
    }
  };

  useEffect(() => {
    void loadRail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeBot) {
      setPickedProviderId(activeBot.providerId);
      setPickedModel(activeBot.model);
    }
  }, [activeBot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = engineEntries(rail);
  const pickedEntry = entries.find((e) => e.providerId === pickedProviderId) ?? null;
  const modelOptions =
    pickedEntry && pickedEntry.models.length > 0 ? pickedEntry.models : pickedEntry ? [pickedEntry.defaultModel] : [];
  const engineChanged =
    !!activeBot &&
    (pickedProviderId !== activeBot.providerId || pickedModel !== activeBot.model);

  const redetect = async () => {
    setRedetecting(true);
    setEngineError('');
    try {
      await window.openBot.redetectEngines();
      await loadRail();
    } catch {
      setEngineError(t('doctorTeam.loadError'));
    } finally {
      setRedetecting(false);
    }
  };

  const saveEngine = async () => {
    if (!activeBot || !engineChanged) return;
    setSavingEngine(true);
    setEngineError('');
    setEngineNotice('');
    try {
      const saved = await window.openBot.updateBot({
        ...activeBot,
        providerId: pickedProviderId,
        model: pickedModel,
      });
      onBotUpdated(saved);
      setEngineNotice(t('doctorTeam.savedOk'));
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : t('doctorTeam.saveError'));
    } finally {
      setSavingEngine(false);
    }
  };

  return (
    <div className="panel" data-testid="doctor-team-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('doctorTeam.title')}</h2>
        <button className="btn secondary" onClick={onBack}>
          {t('mcp.back')}
        </button>
      </div>
      <p className="hint">{t('doctorTeam.intro')}</p>

      <h3>{t('doctorTeam.doctorTitle')}</h3>
      <div className="row">
        <button
          type="button"
          onClick={() => void runDoctor()}
          disabled={doctorRunning}
          data-testid="doctor-team-run"
        >
          {doctorRunning ? t('doctorTeam.running') : t('doctorTeam.runDoctor')}
        </button>
      </div>
      {doctorError !== '' && <p className="error">{doctorError}</p>}
      {checks === null ? (
        <p className="hint" data-testid="doctor-team-not-run">
          {t('doctorTeam.notRunYet')}
        </p>
      ) : (
        <ul data-testid="doctor-team-checks">
          {checks.map((check) => (
            <li key={check.id} data-testid={`doctor-team-check-${check.id}`}>
              <span className={`badge ${check.status}`}>{t(STATUS_KEYS[check.status])}</span>{' '}
              <strong>{t(DOCTOR_CHECK_LABEL_KEYS[check.id])}</strong>{' '}
              <span style={{ color: 'var(--text-dim)' }}>{t(check.detailKey, check.vars)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('doctorTeam.teamTitle')}</h3>
      {teamLoading ? (
        <p className="hint">{t('team.loading')}</p>
      ) : teamError ? (
        <p className="error" data-testid="doctor-team-error">
          {teamError}
        </p>
      ) : team ? (
        <>
          <p data-testid="doctor-team-name">
            {t('doctorTeam.teamName', { name: team.name })} ·{' '}
            {t('doctorTeam.teamId', { id: team.id })}
          </p>
          <h4>{t('team.membersTitle')}</h4>
          {team.members.length === 0 ? (
            <p className="hint">{t('team.emptyMembers')}</p>
          ) : (
            <ul data-testid="doctor-team-members">
              {team.members.map((m) => (
                <li key={m.userId}>
                  {m.name} ({m.userId}) · {m.role}
                </li>
              ))}
            </ul>
          )}
          <h4>{t('team.botsTitle')}</h4>
          {sharedBotIds.length === 0 ? (
            <p className="hint">{t('team.emptyBots')}</p>
          ) : (
            <ul data-testid="doctor-team-shared-bots">
              {sharedBotIds.map((id) => (
                <li key={id}>{bots.find((b) => b.id === id)?.name ?? id}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="hint">{t('doctorTeam.noTeam')}</p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn secondary"
          onClick={() => void doExportTeam()}
          disabled={teamBusy !== null}
          data-testid="doctor-team-export"
        >
          {t('team.exportTeam')}
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={() => void doImportTeam()}
          disabled={teamBusy !== null}
          data-testid="doctor-team-import"
        >
          {t('team.importTeam')}
        </button>
      </div>
      {teamNotice !== '' && <p className="hint" data-testid="doctor-team-notice">{teamNotice}</p>}
      {importPending && (
        <div className="card" data-testid="doctor-team-import-pending">
          <strong>{t('team.importConflictsTitle')}</strong>
          <p>
            {t('team.importSummary', {
              name: importPending.summary.teamName,
              bots: String(importPending.summary.bots),
              automations: String(importPending.summary.automations),
              skills: String(importPending.summary.skills),
            })}
          </p>
          <ul>
            {importPending.conflicts.map((c) => (
              <li key={`${c.kind}:${c.id}`}>
                {c.kind}: {c.id} — {c.detail}
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              type="button"
              className="btn secondary"
              onClick={() => void applyImport(importPending.bundle, false)}
              disabled={teamBusy !== null}
            >
              {t('team.importKeepExisting')}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => void applyImport(importPending.bundle, true)}
              disabled={teamBusy !== null}
            >
              {t('team.importOverwrite')}
            </button>
          </div>
        </div>
      )}

      <h3>{t('doctorTeam.engineTitle')}</h3>
      <p className="hint">{t('doctorTeam.engineIntro')}</p>
      {railError !== '' && <p className="error">{railError}</p>}
      {engineError !== '' && <p className="error">{engineError}</p>}
      {engineNotice !== '' && <p className="hint" data-testid="doctor-team-engine-notice">{engineNotice}</p>}
      {!activeBot ? (
        <p className="hint">{t('doctorTeam.noBots')}</p>
      ) : entries.length === 0 ? (
        <p className="hint" data-testid="doctor-team-no-engines">
          {t('doctorTeam.noEngines')}
        </p>
      ) : (
        <>
          <p className="hint" data-testid="doctor-team-current-engine">
            {t('doctorTeam.currentEngine', { provider: activeBot.providerId, model: activeBot.model })}
          </p>
          <div className="row">
            <label>
              {t('doctorTeam.bot')}
              <select
                value={activeBot.id}
                onChange={(e) => onSelectBot(e.target.value)}
                data-testid="doctor-team-bot-select"
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('doctorTeam.engine')}
              <select
                value={pickedProviderId}
                onChange={(e) => {
                  const entry = entries.find((x) => x.providerId === e.target.value) ?? null;
                  setPickedProviderId(e.target.value);
                  if (entry) setPickedModel(entry.defaultModel);
                }}
                data-testid="doctor-team-engine-select"
              >
                {entries.map((e) => (
                  <option key={e.providerId} value={e.providerId}>
                    {e.label}
                    {e.status !== 'usable' ? ` (${t('doctorTeam.unavailable')})` : ''}
                    {e.accountLabel ? ` — ${e.accountLabel}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('doctorTeam.model')}
              <select
                value={pickedModel}
                onChange={(e) => setPickedModel(e.target.value)}
                data-testid="doctor-team-model-select"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => void saveEngine()}
              disabled={!engineChanged || savingEngine}
              data-testid="doctor-team-save-engine"
            >
              {savingEngine ? t('doctorTeam.saving') : t('doctorTeam.saveEngine')}
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => void redetect()}
              disabled={redetecting}
              data-testid="doctor-team-redetect"
            >
              {redetecting ? t('settings.enginesRedetecting') : t('settings.enginesRedetect')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
