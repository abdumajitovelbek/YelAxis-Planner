import { PagedItems } from '../item-pages';
import { message as uiMessage } from '../messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ConflictView, PlanProfile, TimedEntry } from '@yelaxis/application';

import { conflictCounts } from './capacity-summary';
import { formatDate, formatInstantTime } from './format';
import { occurrenceTarget } from './occurrence-controls';
import { usePlanning, type CommandRunner } from './planning-context';
import { entryKindLabel, entryTimeText } from './timeline';
import { isBlockEntry, type RequestDialog } from './scheduling-dialogs';

import './conflicts.css';

/**
 * Unresolved overlaps with four explicit choices per item: Move, Shorten, Keep overlap, or Cancel.
 * Nothing is chosen automatically. Kept overlaps are listed separately and ask for nothing.
 */
export function ConflictsPanel({
  conflicts,
  onRequest,
  profile,
  runner,
}: {
  readonly conflicts: readonly ConflictView[];
  readonly onRequest: RequestDialog;
  readonly profile: PlanProfile;
  readonly runner: CommandRunner;
}): ReactNode {
  const { open } = conflictCounts(conflicts);
  const unresolved = conflicts.filter((conflict) => !conflict.kept);
  const kept = conflicts.filter((conflict) => conflict.kept);
  const announced = useRef<number | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (announced.current === open) return;
    const previous = announced.current;
    announced.current = open;
    if (open > 0)
      setMessage(
        uiMessage('plan.conflicts.1216', {
          value0: String(open),
          value1: open === 1 ? 'overlap' : 'overlaps',
        }),
      );
    else if (previous !== null && previous > 0) setMessage(uiMessage('plan.conflicts.1217'));
  }, [open]);

  return (
    <section
      id="plan-overlaps"
      className="overlaps-panel"
      aria-labelledby="plan-overlaps-heading"
      tabIndex={-1}
    >
      <h2 id="plan-overlaps-heading">{uiMessage('plan.conflicts.1218')}</h2>
      <p className="sr-only" aria-live="polite">
        {message}
      </p>
      {unresolved.length === 0 ? (
        <p className="quiet-empty">{uiMessage('plan.conflicts.1219')}</p>
      ) : (
        <>
          <p className="field-help">{uiMessage('plan.conflicts.1220')}</p>
          <ul className="conflict-list">
            <PagedItems items={unresolved}>
              {(conflict) => (
                <li key={`${conflict.firstKey}|${conflict.secondKey}`} className="conflict-item">
                  <h3>
                    {conflict.first.title}
                    {uiMessage('plan.conflicts.1221')}
                    {conflict.second.title}
                  </h3>
                  <p className="warning-text">
                    {uiMessage('plan.conflicts.1222')}
                    {formatDate(conflict.first.localDate, 'weekday')},{' '}
                    {formatInstantTime(
                      conflict.overlapStartsAt,
                      profile.planningTimeZone,
                      profile.timeFormat,
                    )}{' '}
                    –{' '}
                    {formatInstantTime(
                      conflict.overlapEndsAt,
                      profile.planningTimeZone,
                      profile.timeFormat,
                    )}
                  </p>
                  <div className="conflict-sides">
                    <ConflictSide
                      entry={conflict.first}
                      onRequest={onRequest}
                      profile={profile}
                      runner={runner}
                    />
                    <ConflictSide
                      entry={conflict.second}
                      onRequest={onRequest}
                      profile={profile}
                      runner={runner}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={runner.busy}
                    onClick={() => onRequest({ kind: 'keepOverlap', conflict })}
                  >
                    {uiMessage('plan.conflicts.1223')}
                    <span className="sr-only">
                      {' '}
                      {conflict.first.title}
                      {uiMessage('plan.conflicts.1221')}
                      {conflict.second.title}
                    </span>
                  </button>
                </li>
              )}
            </PagedItems>
          </ul>
        </>
      )}
      {kept.length > 0 && (
        <>
          <h3>{uiMessage('plan.conflicts.1224')}</h3>
          <ul className="kept-list">
            <PagedItems items={kept}>
              {(conflict) => (
                <li key={`${conflict.firstKey}|${conflict.secondKey}`}>
                  {conflict.first.title}
                  {uiMessage('plan.conflicts.1221')}
                  {conflict.second.title}, {formatDate(conflict.first.localDate, 'weekday')}{' '}
                  {formatInstantTime(
                    conflict.overlapStartsAt,
                    profile.planningTimeZone,
                    profile.timeFormat,
                  )}
                  <span className="status-pill">{uiMessage('plan.conflicts.1224')}</span>
                </li>
              )}
            </PagedItems>
          </ul>
        </>
      )}
    </section>
  );
}

function ConflictSide({
  entry,
  onRequest,
  profile,
  runner,
}: {
  readonly entry: TimedEntry;
  readonly onRequest: RequestDialog;
  readonly profile: PlanProfile;
  readonly runner: CommandRunner;
}): ReactNode {
  const planning = usePlanning();
  const context = (
    <>
      {' '}
      <span className="sr-only">{entry.title}</span>
    </>
  );
  const occurrence = entry.occurrence;
  const commitment = entry.block?.target.kind === 'commitment';
  return (
    <div className="conflict-side">
      <p className="conflict-entry">
        <span className="entry-time">
          {entryTimeText(entry, entry.localDate, profile.timeFormat)}
        </span>{' '}
        <strong>{entry.title}</strong> <span className="field-help">{entryKindLabel(entry)}</span>
      </p>
      {entry.state !== 'planned' ? null : isBlockEntry(entry) ? (
        <div className="control-row">
          <button
            type="button"
            disabled={runner.busy}
            onClick={() => onRequest({ kind: 'move', entry })}
          >
            {uiMessage('alignment.milestone-detail.610')}
            {context}
          </button>
          {entry.durationMinutes > 1 && (
            <button
              type="button"
              disabled={runner.busy}
              onClick={() => onRequest({ kind: 'shorten', entry })}
            >
              {uiMessage('plan.conflicts.1225')}
              {context}
            </button>
          )}
          <button
            type="button"
            disabled={runner.busy}
            onClick={() => onRequest({ kind: 'cancelBlock', entry })}
          >
            {commitment ? uiMessage('plan.conflicts.1226') : uiMessage('plan.conflicts.1227')}
            {context}
          </button>
        </div>
      ) : occurrence !== undefined ? (
        <div className="control-row">
          <button
            type="button"
            disabled={runner.busy}
            onClick={() => onRequest({ kind: 'editOccurrence', occurrence, focus: 'date' })}
          >
            {uiMessage('alignment.milestone-detail.610')}
            {context}
          </button>
          <button
            type="button"
            disabled={runner.busy}
            onClick={() => onRequest({ kind: 'editOccurrence', occurrence, focus: 'duration' })}
          >
            {uiMessage('plan.conflicts.1225')}
            {context}
          </button>
          <button
            type="button"
            disabled={runner.busy}
            onClick={() =>
              void runner.run(
                () => planning.skipOccurrence({ occurrence: occurrenceTarget(occurrence) }),
                uiMessage('plan.conflicts.1228'),
              )
            }
          >
            {uiMessage('plan.conflicts.1229')}
            {context}
          </button>
        </div>
      ) : null}
    </div>
  );
}
