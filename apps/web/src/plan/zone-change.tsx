import { message as uiMessage } from '../messages';
import { useId, useState, type ReactNode } from 'react';

import type { PlanningZoneChangePreview } from '@yelaxis/application';
import type { PlanningZoneChangeOccurrence, PlanningZoneChangeRoutine } from '@yelaxis/domain';

import { applicationErrorMessage, formatDate, formatWallTime } from './format';
import { Modal } from './modal';
import {
  CommandFeedback,
  useCommandRunner,
  usePlanning,
  usePlanningOptional,
  usePlanQuery,
} from './planning-context';

import './zone-change.css';

/** Presentation preference: the planning zone the user chose to keep while on this device zone. */
export const zoneKeptKey = (deviceZone: string): string => `yelaxis:zone-kept:${deviceZone}`;

const deviceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function readKept(deviceZone: string): string | null {
  try {
    return window.localStorage.getItem(zoneKeptKey(deviceZone));
  } catch {
    return null;
  }
}

function writeKept(deviceZone: string, planningZone: string): void {
  try {
    window.localStorage.setItem(zoneKeptKey(deviceZone), planningZone);
  } catch {
    /* A private window may refuse storage; keeping still applies until the page reloads. */
  }
}

const readable = (zone: string): string => zone.replace(/_/gu, ' ');

/**
 * Device-zone change prompt (time-horizon-recurrence "Planning time zone"). YelAxis Planner never changes the
 * Profile silently: when the device reports another zone, the user keeps the planning zone or
 * reviews a preview of what would move and then chooses to change it.
 */
export function ZoneChangeNotice(): ReactNode {
  const planning = usePlanningOptional();
  if (planning === null) return null;
  return <ConnectedZoneChangeNotice />;
}

function ConnectedZoneChangeNotice(): ReactNode {
  const planning = usePlanning();
  const { state } = usePlanQuery(() => planning.getCapacitySettings(), [planning]);
  const [deviceZone] = useState(deviceTimeZone);
  const [kept, setKept] = useState<string | null>(() => readKept(deviceZone));
  const [reviewing, setReviewing] = useState(false);
  const runner = useCommandRunner();
  const labelId = useId();
  if (state.status !== 'ready') return <CommandFeedback runner={runner} />;
  const planningZone = state.data.profile.planningTimeZone;
  const visible = deviceZone !== planningZone && kept !== planningZone;
  return (
    <>
      <CommandFeedback runner={runner} showError={!reviewing} />
      {visible && (
        <section className="zone-notice" aria-labelledby={labelId}>
          <p id={labelId} className="zone-notice-title">
            <strong>
              {uiMessage('plan.zone-change.1892')}
              {readable(deviceZone)}
              {uiMessage('plan.zone-change.1893')}
              {readable(planningZone)}.
            </strong>
          </p>
          <p className="field-help">{uiMessage('plan.zone-change.1894')}</p>
          <div className="zone-notice-actions">
            <button
              type="button"
              onClick={() => {
                writeKept(deviceZone, planningZone);
                setKept(planningZone);
              }}
            >
              {uiMessage('plan.zone-change.1895')}
              {readable(planningZone)}
            </button>
            <button type="button" className="primary-button" onClick={() => setReviewing(true)}>
              {uiMessage('plan.zone-change.1896')}
              {readable(deviceZone)}…
            </button>
          </div>
        </section>
      )}
      <Modal
        open={reviewing}
        eyebrow={uiMessage('onboarding-ui.1050')}
        title={uiMessage('plan.zone-change.1897')}
        onClose={() => {
          runner.clearError();
          setReviewing(false);
        }}
      >
        {reviewing && (
          <ZoneChangeReview
            from={planningZone}
            to={deviceZone}
            timeFormat={state.data.profile.timeFormat}
            runnerBusy={runner.busy}
            runnerError={runner.error}
            onCancel={() => {
              runner.clearError();
              setReviewing(false);
            }}
            onChange={async (revision) => {
              const changed = await runner.run(
                () => planning.changePlanningZone({ zone: deviceZone, revision }),
                uiMessage('plan.zone-change.1898', { value0: readable(deviceZone) }),
              );
              if (changed) setReviewing(false);
            }}
          />
        )}
      </Modal>
    </>
  );
}

function ZoneChangeReview({
  from,
  onCancel,
  onChange,
  runnerBusy,
  runnerError,
  timeFormat,
  to,
}: {
  readonly from: string;
  readonly to: string;
  readonly timeFormat: '12_hour' | '24_hour';
  readonly runnerBusy: boolean;
  readonly runnerError: string | null;
  readonly onCancel: () => void;
  readonly onChange: (revision: number) => Promise<void>;
}): ReactNode {
  const planning = usePlanning();
  const { state, reload } = usePlanQuery(
    () => planning.previewPlanningZoneChange(to),
    [planning, to],
  );
  if (state.status === 'loading')
    return (
      <p className="field-help" role="status">
        {uiMessage('plan.zone-change.1899')}
      </p>
    );
  const failure =
    state.status === 'error'
      ? uiMessage('plan.zone-change.1900')
      : state.data.ok
        ? null
        : applicationErrorMessage(state.data.error);
  if (failure !== null || state.status !== 'ready' || !state.data.ok)
    return (
      <>
        <p className="validation-summary" role="alert">
          {failure}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {uiMessage('account.account-dialogs.20')}
          </button>
          {state.status === 'error' && (
            <button type="button" onClick={() => void reload()}>
              {uiMessage('account.account-dialogs.47')}
            </button>
          )}
        </div>
      </>
    );
  const preview: PlanningZoneChangePreview = state.data.value;
  return (
    <>
      <p>
        {uiMessage('plan.zone-change.1901')}
        {readable(to)}
        {uiMessage('plan.zone-change.1902')}
        {readable(from)}
        {uiMessage('plan.zone-change.1903')}
      </p>
      {preview.routines.length === 0 ? (
        <p className="field-help">{uiMessage('plan.zone-change.1904')}</p>
      ) : (
        <ul className="zone-routines" aria-label={uiMessage('plan.zone-change.1905')}>
          {preview.routines.map((routine) => (
            <li key={routine.routineId}>
              <p>
                <strong>{routine.title}</strong>{' '}
                <span className="field-help">{policyText(routine)}</span>
              </p>
              <ul>
                {routine.occurrences.map((occurrence) => (
                  <li key={occurrence.date}>
                    {formatDate(occurrence.date, 'weekday')}:{' '}
                    {occurrenceText(occurrence, to, timeFormat)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {preview.dateOnlyRoutineCount > 0 && (
        <p className="field-help">
          {preview.dateOnlyRoutineCount === 1
            ? uiMessage('plan.zone-change.1906')
            : uiMessage('plan.zone-change.1907', { value0: String(preview.dateOnlyRoutineCount) })}
        </p>
      )}
      {runnerError !== null && (
        <p className="validation-summary" role="alert">
          {runnerError}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={runnerBusy}
          onClick={() => void onChange(preview.profileRevision)}
        >
          {runnerBusy
            ? uiMessage('plan.zone-change.1908')
            : uiMessage('plan.zone-change.1909', { value0: readable(to) })}
        </button>
      </div>
    </>
  );
}

function policyText(routine: PlanningZoneChangeRoutine): string {
  return routine.policy.kind === 'fixed_zone'
    ? uiMessage('plan.zone-change.1910', { value0: readable(routine.policy.timeZone) })
    : uiMessage('plan.zone-change.1911');
}

function occurrenceText(
  occurrence: PlanningZoneChangeOccurrence,
  to: string,
  timeFormat: '12_hour' | '24_hour',
): string {
  const { after, before } = occurrence;
  if (after.kind === 'dst_skipped') return uiMessage('plan.zone-change.1912');
  if (before.kind === 'dst_skipped')
    return uiMessage('plan.zone-change.1913', {
      value0: formatWallTime(after.localTime, timeFormat),
    });
  const here = formatWallTime(after.localTime, timeFormat);
  if (!occurrence.instantChanges)
    return uiMessage('plan.zone-change.1914', {
      value0: formatWallTime(after.wallTime, timeFormat),
      value1: readable(after.timeZone),
      value2: here,
      value3: readable(to),
    });
  return uiMessage('plan.zone-change.1915', {
    value0: formatWallTime(before.wallTime, timeFormat),
    value1: here,
    value2: readable(to),
  });
}
