/**
 * ConversationV112Panel — panel showing the v1.12 conversation log
 * (Team T2).
 *
 * Presentational: receives folded state + event tail via props, never
 * calls IPC, never reads disk. The host (coordinator) wires data from
 * the `conversation_v112_replay` tool or from its own IPC — the panel
 * only renders. All displayed text is already sanitized in core
 * (secrets redacted, output truncated), so the panel renders text
 * directly with no extra redaction.
 *
 * Props:
 * - `state`: folded ConversationState (core) — summary + counts.
 * - `events`: tail events (newest last) — shows seq/type/at.
 * - `onReplay` / `onSnapshot` / `onCompact` / `onExport` /
 *   `onBranch`: callbacks when the user clicks a button (host wires
 *   the tool itself).
 */

import type { AnyConversationEvent, ConversationState } from '@open-bot/core';
import { useT } from '../i18n/useT';

export interface ConversationV112PanelProps {
  state: ConversationState | null;
  events: AnyConversationEvent[];
  loading?: boolean;
  loadError?: string | null;
  onRefresh?: () => void;
  onReplay?: () => void;
  onSnapshot?: () => void;
  onCompact?: () => void;
  onExport?: () => void;
  onBranch?: () => void;
}

/** Conversation status label (translated via i18n convV112.*). */
export function conversationV112StatusLabel(
  t: (key: string) => string,
  status: ConversationState['status'],
): string {
  switch (status) {
    case 'active':
      return t('convV112.statusActive');
    case 'branched':
      return t('convV112.statusBranched');
    case 'ended':
      return t('convV112.statusEnded');
    case 'compacted':
      return t('convV112.statusCompacted');
    default:
      return status;
  }
}

/** Summarize one event as a short line (never leaks message content). */
export function formatConversationV112EventLine(event: AnyConversationEvent): string {
  return `#${event.seq} ${event.type} @ ${event.at}`;
}

export default function ConversationV112Panel(props: ConversationV112PanelProps) {
  const t = useT();
  const { state, events, loading, loadError } = props;

  if (loading) {
    return <div className="conv-v112-panel"><p>{t('convV112.loading')}</p></div>;
  }
  if (loadError) {
    return (
      <div className="conv-v112-panel">
        <p>{t('convV112.loadError')}</p>
        <p>{loadError}</p>
        {props.onRefresh ? <button type="button" onClick={props.onRefresh}>{t('convV112.retry')}</button> : null}
      </div>
    );
  }
  if (!state) {
    return <div className="conv-v112-panel"><p>{t('convV112.empty')}</p></div>;
  }

  return (
    <div className="conv-v112-panel">
      <h2>{t('convV112.title')}</h2>
      <p>{t('convV112.subtitle')}</p>
      <dl>
        <dt>{t('convV112.status')}</dt>
        <dd>{conversationV112StatusLabel(t, state.status)}</dd>
        <dt>{t('convV112.branch')}</dt>
        <dd>{state.branchId}</dd>
        <dt>{t('convV112.lastSeq')}</dt>
        <dd>{state.lastSeq}</dd>
        <dt>{t('convV112.messages')}</dt>
        <dd>{state.messages.length}</dd>
        <dt>{t('convV112.toolCalls')}</dt>
        <dd>{state.toolCallsCompleted} / {state.toolCallsCompleted + state.pendingToolCalls.length}</dd>
        <dt>{t('convV112.codeactRuns')}</dt>
        <dd>{state.codeActRuns}</dd>
        <dt>{t('convV112.codeactBlocked')}</dt>
        <dd>{state.codeActBlocked}</dd>
        <dt>{t('convV112.skillsLoaded')}</dt>
        <dd>{state.loadedSkills.length > 0 ? state.loadedSkills.map((s) => s.name).join(', ') : '—'}</dd>
        <dt>{t('convV112.branches')}</dt>
        <dd>{state.branches.length}</dd>
      </dl>
      <div>
        {props.onRefresh ? <button type="button" onClick={props.onRefresh}>{t('convV112.refresh')}</button> : null}
        {props.onReplay ? <button type="button" onClick={props.onReplay}>{t('convV112.replay')}</button> : null}
        {props.onSnapshot ? <button type="button" onClick={props.onSnapshot}>{t('convV112.snapshot')}</button> : null}
        {props.onCompact ? <button type="button" onClick={props.onCompact}>{t('convV112.compact')}</button> : null}
        {props.onExport ? <button type="button" onClick={props.onExport}>{t('convV112.export')}</button> : null}
        {props.onBranch ? <button type="button" onClick={props.onBranch}>{t('convV112.branchAction')}</button> : null}
      </div>
      <ul>
        {events.map((event) => (
          <li key={`${event.seq}-${event.hash.slice(0, 8)}`}>
            {formatConversationV112EventLine(event)}
          </li>
        ))}
      </ul>
    </div>
  );
}
