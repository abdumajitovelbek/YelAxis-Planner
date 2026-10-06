import { message as uiMessage } from '../messages';
/**
 * Pieces shared by the Outcome, Project, and Milestone detail pages on top of the alignment kit:
 * links to related objects, rows with their controls, the edges the Unlink dialog needs, and the
 * placement form limited to the horizons an object may use. Everything here renders read models or
 * runs one explicit command.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  AlignmentEdge,
  AlignmentKind,
  AlignmentNode,
  AlignmentNodeKind,
  AlignmentRelationship,
  NodeRef,
  PlaceableTargetInput,
  PlacementPeriodInput,
  RevisionRef,
} from '@yelaxis/application';
import {
  alignmentRelationshipRules,
  type CalendarDate,
  type HorizonPeriod,
  type UUID,
} from '@yelaxis/domain';

import { formatDate, formatMonth, formatPeriod } from '../plan/format';
import { Modal } from '../plan/modal';
import { usePlanning, usePlanningToday, type CommandRunner } from '../plan/planning-context';
import {
  actionPath,
  axisPath,
  milestonePath,
  outcomePath,
  planPath,
  projectPath,
  routinePath,
} from '../plan/routes';
import { periodLocation } from '../plan/theme-editor';
import { DialogError, isCalendarDate, shiftMonths, useDialogAutofocus } from '../plan/timeline';
import { StatusPill } from './kit';
import { stateLabel } from './labels';

import './details.css';

/* ───────────────────────── Nodes and edges ───────────────────────── */

/** The page of a related object; Notes have none. */
export function nodePath(kind: AlignmentNodeKind, id: string): string | null {
  switch (kind) {
    case 'axis':
      return axisPath(id);
    case 'outcome':
      return outcomePath(id);
    case 'project':
      return projectPath(id);
    case 'milestone':
      return milestonePath(id);
    case 'action':
      return actionPath(id);
    case 'routine':
      return routinePath(id);
    case 'note':
      return null;
  }
}

interface NodeFacts {
  readonly id: UUID;
  readonly title: string;
  readonly state: string;
  readonly localRevision: number;
  readonly archived?: boolean;
}

/** A detail object as an alignment node (the focus of the link and unlink dialogs). */
export function alignmentNode(kind: AlignmentNodeKind, item: NodeFacts): AlignmentNode {
  return {
    kind,
    id: item.id,
    title: item.title,
    state: item.state,
    archived: item.archived ?? item.state === 'archived',
    localRevision: item.localRevision,
  };
}

/** The record a lifecycle command expects, with the title its dialogs show. */
export function lifecycleTarget(
  kind: AlignmentKind,
  item: NodeFacts,
): RevisionRef & { readonly title: string } {
  return { kind, id: item.id, revision: item.localRevision, title: item.title };
}

/**
 * One direct relationship of the page's object, for the shared Unlink dialog. Join links carry
 * their link record; foreign-key links are unlinked with the child's revision.
 */
export function edgeTo(
  relationship: AlignmentRelationship,
  direction: 'up' | 'down',
  other: AlignmentNode,
  link: { readonly linkId?: UUID; readonly linkRevision?: number } = {},
): AlignmentEdge {
  return {
    relationship,
    direction,
    required: alignmentRelationshipRules[relationship].required,
    other,
    ...(link.linkId === undefined ? {} : { linkId: link.linkId }),
    ...(link.linkRevision === undefined ? {} : { linkRevision: link.linkRevision }),
  };
}

/**
 * Title as a link to its page, with "Archived" said in text when it applies (rows whose state pill
 * already says it pass `showArchived={false}`).
 */
export function NodeLink({
  archivedText = uiMessage('alignment.alignment-page.405'),
  kind,
  node,
  showArchived = true,
}: {
  readonly kind: AlignmentNodeKind;
  readonly node: NodeRef;
  readonly archivedText?: string;
  readonly showArchived?: boolean;
}): ReactNode {
  const path = nodePath(kind, node.id);
  return (
    <>
      {path === null ? (
        <span>{node.title}</span>
      ) : (
        <Link className="detail-node-link" to={path}>
          {node.title}
        </Link>
      )}
      {showArchived && node.archived && <span className="archived-tag">{archivedText}</span>}
    </>
  );
}

export interface DetailRow {
  readonly key: string;
  readonly kind: AlignmentNodeKind;
  readonly node: NodeRef;
  /** Extra neutral facts, such as a target window. */
  readonly facts?: readonly string[];
  readonly controls?: ReactNode;
}

/**
 * Related objects under a heading that names their kind: title link and state in words, neutral
 * facts, and the row's own controls.
 */
export function DetailList({
  empty,
  label,
  ordered = false,
  rows,
}: {
  readonly label: string;
  readonly empty: string;
  readonly rows: readonly DetailRow[];
  readonly ordered?: boolean;
}): ReactNode {
  if (rows.length === 0) return <p className="quiet-empty">{empty}</p>;
  const items = rows.map((row) => (
    <li key={row.key} className="alignment-row detail-row">
      <div className="alignment-row-main">
        <p className="alignment-row-title">
          <NodeLink kind={row.kind} node={row.node} showArchived={row.node.state !== 'archived'} />
          <StatusPill label={stateLabel(row.kind, row.node.state)} />
        </p>
        {row.facts !== undefined && row.facts.length > 0 && (
          <p className="alignment-row-meta">
            {row.facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </p>
        )}
      </div>
      {row.controls !== undefined && <div className="detail-row-controls">{row.controls}</div>}
    </li>
  ));
  return ordered ? (
    <ol className="alignment-list" aria-label={label}>
      {items}
    </ol>
  ) : (
    <ul className="alignment-list" aria-label={label}>
      {items}
    </ul>
  );
}

/**
 * A page button that stays focusable while a command runs (`aria-disabled`), so a keyboard user
 * keeps their place; pressing it meanwhile does nothing.
 */
export function CommandButton({
  busy,
  children,
  onClick,
}: {
  readonly busy: boolean;
  readonly children: ReactNode;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-disabled={busy}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {children}
    </button>
  );
}

/** Unlink opens a confirmation; both objects always stay. */
export function UnlinkButton({
  disabled,
  onClick,
  title,
}: {
  readonly title: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <CommandButton busy={disabled} onClick={onClick}>
      {uiMessage('actions-ui.319')}
      <span className="sr-only">{title}</span>
    </CommandButton>
  );
}

/** Where an object is placed, as a link to that Plan period. */
export function PlacementFact({
  placement,
}: {
  readonly placement: { readonly period: HorizonPeriod } | undefined;
}): ReactNode {
  if (placement === undefined) return uiMessage('alignment.detail-parts.457');
  const location = periodLocation(placement.period);
  return (
    <Link className="detail-node-link" to={planPath(location.horizon, location.date)}>
      {formatPeriod(placement.period)}
    </Link>
  );
}

/* ───────────────────────── Placement ───────────────────────── */

export type PlacementKind = 'year' | 'month' | 'week';

const choiceLabels: Readonly<Record<PlacementKind, string>> = {
  year: 'A year',
  month: 'A month',
  week: 'A week',
};

const yearsShown = 10;
const monthsShown = 24;

/** Years from this year (or an earlier placed year) through the next nine. */
function yearOptions(today: CalendarDate, selected: string): readonly string[] {
  const first = Math.min(Number(today.slice(0, 4)), Number(selected));
  const last = Math.max(Number(today.slice(0, 4)) + yearsShown - 1, Number(selected));
  return Array.from({ length: last - first + 1 }, (_, index) => String(first + index));
}

/** Twenty-four months from this month, plus an earlier or later placed month. */
function monthOptions(today: CalendarDate, selected: string): readonly string[] {
  const months = Array.from({ length: monthsShown }, (_, index) =>
    shiftMonths(`${today.slice(0, 7)}-01`, index).slice(0, 7),
  );
  if (months.includes(selected)) return months;
  return selected < (months[0] ?? selected) ? [selected, ...months] : [...months, selected];
}

function placementWords(period: PlacementPeriodInput): string {
  switch (period.kind) {
    case 'year':
      return period.date.slice(0, 4);
    case 'month':
      return formatMonth(period.date.slice(0, 7));
    case 'week':
      return uiMessage('alignment.detail-parts.458', { value0: formatDate(period.date, 'long') });
    case 'day':
      return formatDate(period.date, 'long');
  }
}

/**
 * Place an Outcome, Project, or Milestone in one of the horizons it allows. Placing replaces the
 * current placement and changes nothing else: no state, target window, or order. The dialog that
 * hosts it shows the runner's error.
 */
export function PlacementForm({
  allowed,
  current,
  onCancel,
  onDone,
  runner,
  submitLabel = uiMessage('alignment.detail-parts.459'),
  target,
  title,
}: {
  readonly target: PlaceableTargetInput;
  readonly title: string;
  readonly allowed: readonly PlacementKind[];
  readonly current?: HorizonPeriod | undefined;
  readonly runner: CommandRunner;
  readonly submitLabel?: string;
  readonly onCancel?: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const planning = usePlanning();
  const today = usePlanningToday();
  const idBase = useId();
  const container = useRef<HTMLFormElement>(null);
  useDialogAutofocus(container);
  const anchor = current === undefined ? today : periodLocation(current).date;
  const currentKind = allowed.find((kind) => kind === current?.kind);
  const [choice, setChoice] = useState<PlacementKind>(currentKind ?? allowed[0] ?? 'month');
  const [year, setYear] = useState(anchor.slice(0, 4));
  const [month, setMonth] = useState(anchor.slice(0, 7));
  const [weekDate, setWeekDate] = useState<string>(anchor);
  const [error, setError] = useState<string | null>(null);
  const period: PlacementPeriodInput | null =
    choice === 'year'
      ? { kind: 'year', date: `${year}-01-01` }
      : choice === 'month'
        ? { kind: 'month', date: `${month}-01` }
        : isCalendarDate(weekDate)
          ? { kind: 'week', date: weekDate }
          : null;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (period === null) {
      setError(uiMessage('alignment.detail-parts.460'));
      return;
    }
    setError(null);
    const saved = await runner.run(
      () => planning.place({ target, period }),
      uiMessage('alignment.detail-parts.461', { value0: placementWords(period) }),
    );
    if (saved) onDone();
  };
  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      {allowed.length > 1 && (
        <fieldset className="compact-fieldset">
          <legend>{uiMessage('alignment.detail-parts.462')}</legend>
          {allowed.map((kind) => (
            <label key={kind} className="check-row" htmlFor={`${idBase}-choice-${kind}`}>
              <input
                id={`${idBase}-choice-${kind}`}
                type="radio"
                name={`${idBase}-choice`}
                checked={choice === kind}
                {...(choice === kind ? { 'data-autofocus': true } : {})}
                onChange={() => setChoice(kind)}
              />
              <span>{choiceLabels[kind]}</span>
            </label>
          ))}
        </fieldset>
      )}
      {choice === 'year' && (
        <label className="field-label" htmlFor={`${idBase}-year`}>
          {uiMessage('alignment.detail-parts.463')}
          <select
            id={`${idBase}-year`}
            value={year}
            onChange={(event) => setYear(event.target.value)}
          >
            {yearOptions(today, year).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      )}
      {choice === 'month' && (
        <label className="field-label" htmlFor={`${idBase}-month`}>
          {uiMessage('actions-ui.249')}
          <select
            id={`${idBase}-month`}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          >
            {monthOptions(today, month).map((value) => (
              <option key={value} value={value}>
                {formatMonth(value)}
              </option>
            ))}
          </select>
        </label>
      )}
      {choice === 'week' && (
        <label className="field-label" htmlFor={`${idBase}-week`}>
          {uiMessage('alignment.detail-parts.464')}
          <input
            id={`${idBase}-week`}
            type="date"
            value={weekDate}
            onChange={(event) => setWeekDate(event.target.value)}
          />
        </label>
      )}
      <p className="interval-summary" role="status">
        {period === null
          ? uiMessage('alignment.detail-parts.460')
          : uiMessage('alignment.detail-parts.465', {
              value0: title,
              value1: placementWords(period),
            })}
      </p>
      <div className="dialog-actions">
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel}>
            {uiMessage('account.account-dialogs.20')}
          </button>
        )}
        <button type="submit" className="primary-button" disabled={runner.busy}>
          {runner.busy ? uiMessage('account.conflicts-page.133') : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The placement form in its own dialog (Outcome and Project pages). */
export function PlacementDialog({
  allowed,
  current,
  onClose,
  open,
  runner,
  target,
  title,
}: {
  readonly open: boolean;
  readonly target: PlaceableTargetInput;
  readonly title: string;
  readonly allowed: readonly PlacementKind[];
  readonly current?: HorizonPeriod | undefined;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}): ReactNode {
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('alignment.detail-parts.459')}
      title={uiMessage('alignment.detail-parts.466', { value0: title })}
      description={uiMessage('alignment.detail-parts.467')}
      onClose={close}
    >
      {open && (
        <>
          <DialogError runner={runner} />
          <PlacementForm
            allowed={allowed}
            current={current}
            runner={runner}
            target={target}
            title={title}
            onCancel={close}
            onDone={onClose}
          />
        </>
      )}
    </Modal>
  );
}
