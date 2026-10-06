import { PagedItems } from '../item-pages';
import { message as uiMessage } from '../messages';
/**
 * Today's Routines without a set time and this week's counts. Complete and Skip change
 * only the occurrence; Skipped is a neutral state, and nothing counts a streak. Routines at a set
 * time are on the timeline.
 */
import type { ReactNode } from 'react';

import type { OccurrenceEntry, TodayView } from '@yelaxis/application';

import { formatDate } from '../plan/format';
import { OccurrenceControls, occurrenceTarget } from '../plan/occurrence-controls';
import type { CommandRunner } from '../plan/planning-context';
import { AddToFocusButton } from './focus-strip';

export function TodayRoutines({
  runner,
  view,
}: {
  readonly view: TodayView;
  readonly runner: CommandRunner;
}): ReactNode {
  const { day, week } = view.routines;
  return (
    <section className="today-section today-routines" aria-labelledby="today-routines-heading">
      <h2 id="today-routines-heading">{uiMessage('alignment.axis-detail.433')}</h2>
      <p className="field-help">{uiMessage('today.today-routines.2296')}</p>
      {day.length === 0 && week.length === 0 && (
        <p className="quiet-empty">{uiMessage('today.today-routines.2297')}</p>
      )}
      {day.length > 0 && (
        <ul
          className="routine-list"
          aria-label={uiMessage('today.today-routines.2298', {
            value0: formatDate(view.date, 'long'),
          })}
        >
          <PagedItems items={day} identity={view.date}>
            {(entry) => (
              <RoutineItem key={entry.ref.occurrenceId} entry={entry} view={view} runner={runner} />
            )}
          </PagedItems>
        </ul>
      )}
      {week.length > 0 && (
        <>
          <h3 id="today-routines-week-heading">{uiMessage('plan.plan-month.1315')}</h3>
          <ul className="routine-list" aria-labelledby="today-routines-week-heading">
            <PagedItems items={week} identity={view.date}>
              {(entry) => (
                <RoutineItem
                  key={entry.ref.occurrenceId}
                  entry={entry}
                  view={view}
                  runner={runner}
                />
              )}
            </PagedItems>
          </ul>
        </>
      )}
    </section>
  );
}

function RoutineItem({
  entry,
  runner,
  view,
}: {
  readonly entry: OccurrenceEntry;
  readonly view: TodayView;
  readonly runner: CommandRunner;
}): ReactNode {
  return (
    <li>
      <p className="routine-title">{entry.ref.routineTitle}</p>
      <OccurrenceControls compact entry={entry} profile={view.profile} runner={runner} />
      {entry.state === 'planned' && (
        <div className="control-row">
          <AddToFocusButton
            date={view.date}
            target={{ kind: 'routine_occurrence', occurrence: occurrenceTarget(entry) }}
            title={entry.ref.routineTitle}
            focus={view.focus}
            editable={view.focusEditable}
            runner={runner}
          />
        </div>
      )}
    </li>
  );
}
