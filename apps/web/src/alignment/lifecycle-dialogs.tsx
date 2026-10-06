import { message as uiMessage } from '../messages';
/**
 * Archive, restore, and permanent deletion for Axes, Outcomes, Projects, and Milestones. Archive is
 * the default and can be undone; restore returns the object as it was; permanent deletion shows
 * exactly what blocks it and what it removes, never deletes another object, keeps review decisions
 * about it as “Deleted object”, and asks for the exact title before it runs. It cannot be undone.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type {
  ArchiveImpactView,
  Bounded,
  DeleteImpactView,
  ImpactItem,
  RevisionRef,
} from '@yelaxis/application';
import {
  alignmentNodeKinds,
  alignmentRelationshipRules,
  isAlignmentRelationship,
  type AlignmentKind,
  type PermanentDeletePolicy,
} from '@yelaxis/domain';

import { Modal } from '../plan/modal';
import { useAlignment, type CommandRunner } from '../plan/planning-context';
import { runForReceipt, useNoticeNavigate } from './kit';
import { countLabel, kindLabel, relationshipLabel } from './labels';

export type LifecycleTarget = RevisionRef & { readonly title: string };

const revisionRef = (target: RevisionRef): RevisionRef => ({
  kind: target.kind,
  id: target.id,
  revision: target.revision,
});

type Loaded<View> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: View | null }
  | { readonly status: 'error' };

/** "2 Milestones and 1 Project" from per-kind counts, in catalog order; empty when all are zero. */
function childrenText(counts: ArchiveImpactView['activeChildren']): string {
  const parts = alignmentNodeKinds.flatMap((kind) => {
    const count = counts[kind] ?? 0;
    return count > 0 ? [countLabel(kind, count)] : [];
  });
  if (parts.length <= 1) return parts.join('');
  return uiMessage('alignment.lifecycle-dialogs.477', {
    value0: parts.slice(0, -1).join(', '),
    value1: parts[parts.length - 1] ?? '',
  });
}

/* ───────────────────────── Archive and restore ───────────────────────── */

/** Archive after stating its consequences in words. Nothing is deleted; Undo is offered. */
export function ArchiveDialog({
  onClose,
  open,
  runner,
  target,
}: {
  readonly open: boolean;
  readonly target: LifecycleTarget;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const label = kindLabel(target.kind);
  const [preview, setPreview] = useState<Loaded<ArchiveImpactView>>({ status: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setProblem(null);
    setPreview({ status: 'loading' });
    alignment.previewArchive({ kind: target.kind, id: target.id }).then(
      (view) => {
        if (live) setPreview({ status: 'ready', view });
      },
      () => {
        if (live) setPreview({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [alignment, open, target.id, target.kind]);
  const confirm = async (): Promise<void> => {
    if (runner.busy) return;
    setProblem(null);
    const outcome = await runForReceipt(
      runner,
      () => alignment.archive(revisionRef(target)),
      uiMessage('alignment.lifecycle-dialogs.478', { value0: label }),
    );
    if (outcome.ok) onClose();
    else setProblem(outcome.message);
  };
  const view = preview.status === 'ready' ? preview.view : null;
  const children = view === null ? '' : childrenText(view.activeChildren);
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('actions-ui.258')}
      title={uiMessage('alignment.lifecycle-dialogs.479', { value0: label })}
      onClose={onClose}
    >
      <p>
        <strong>{target.title}</strong>
        {` leaves your current lists. It keeps its history and its links.`}
      </p>
      {preview.status === 'loading' && (
        <p className="field-help">{uiMessage('alignment.lifecycle-dialogs.480')}</p>
      )}
      {preview.status === 'error' && (
        <p className="field-help">
          {uiMessage('alignment.lifecycle-dialogs.481')}
          {label}.
        </p>
      )}
      {preview.status === 'ready' && view === null && (
        <p className="field-help">
          {uiMessage('alignment.lifecycle-dialogs.482', { value0: label })}
        </p>
      )}
      {children !== '' && (
        <p>{uiMessage('alignment.lifecycle-dialogs.483', { value0: children, value1: label })}</p>
      )}
      {view?.placementKept === true && <p>{uiMessage('alignment.lifecycle-dialogs.484')}</p>}
      <p>{uiMessage('alignment.lifecycle-dialogs.485')}</p>
      {problem !== null && (
        <p className="validation-summary" role="alert">
          {problem}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          className="primary-button"
          type="button"
          aria-disabled={runner.busy || (preview.status === 'ready' && view === null)}
          onClick={() => {
            if (preview.status === 'ready' && view === null) return;
            void confirm();
          }}
        >
          {uiMessage('alignment.lifecycle-dialogs.486', { value0: label })}
        </button>
      </div>
    </Modal>
  );
}

/** Restore an archived object to the state it had before (or its safe default). */
export function RestoreButton({
  runner,
  target,
}: {
  readonly target: RevisionRef & { readonly title?: string };
  readonly runner: CommandRunner;
}): ReactNode {
  const alignment = useAlignment();
  return (
    <button
      type="button"
      aria-disabled={runner.busy}
      onClick={() => {
        if (runner.busy) return;
        void runner.run(
          () => alignment.restore(revisionRef(target)),
          uiMessage('alignment.lifecycle-dialogs.487', { value0: kindLabel(target.kind) }),
        );
      }}
    >
      {uiMessage('actions-ui.298')}
    </button>
  );
}

/** The read-only state of an archived object's page: what to do, and Restore. */
export function ArchivedNotice({
  runner,
  target,
}: {
  readonly target: RevisionRef & { readonly title?: string };
  readonly runner: CommandRunner;
}): ReactNode {
  return (
    <div className="archived-notice">
      <p>{uiMessage('alignment.lifecycle-dialogs.488')}</p>
      <RestoreButton target={target} runner={runner} />
    </div>
  );
}

/* ───────────────────────── Permanent deletion ───────────────────────── */

/**
 * The last section of an object page. Deleting permanently goes through the impact preview and a
 * typed-title confirmation, then opens `parentPath` and says what happened.
 */
export function DangerZone({
  parentPath,
  runner,
  target,
}: {
  readonly target: LifecycleTarget;
  readonly parentPath: string;
  readonly runner: CommandRunner;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const label = kindLabel(target.kind);
  return (
    <section className="danger-zone alignment-danger-zone" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('actions-ui.300')}</h2>
      <p>{uiMessage('alignment.lifecycle-dialogs.489', { value0: label })}</p>
      <button type="button" className="alignment-destructive" onClick={() => setOpen(true)}>
        {uiMessage('actions-ui.302')}
      </button>
      <DeleteDialog
        open={open}
        target={target}
        parentPath={parentPath}
        runner={runner}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** Why a permanent delete cannot run yet, in words, with what to do instead. */
export function deleteBlockerMessages(view: DeleteImpactView): readonly string[] {
  const label = kindLabel(view.target.kind);
  const messages: string[] = [];
  const blockers = new Set(view.blockers);
  if (blockers.has('required_children')) {
    messages.push(
      uiMessage('alignment.lifecycle-dialogs.490', {
        value0: label,
        value1: plural(view.requiredChildren.total, 'milestone', 'milestones'),
      }),
    );
  }
  if (blockers.has('history_references')) {
    // Review decisions never block: they stay in history (see `keptReviewsText`).
    const defaults = view.historyReferences.routineDefaults;
    messages.push(
      defaults > 0
        ? uiMessage('alignment.lifecycle-dialogs.491', {
            value0: label,
            value1: plural(defaults, 'routine default', 'routine defaults'),
          })
        : uiMessage('alignment.lifecycle-dialogs.492', { value0: label }),
    );
  }
  const linked =
    blockers.has('live_optional_relationships') ||
    blockers.has('placements') ||
    blockers.has('selections');
  if (linked) {
    messages.push(uiMessage('alignment.lifecycle-dialogs.493', { value0: label }));
  }
  if (blockers.has('reminders'))
    messages.push(uiMessage('alignment.lifecycle-dialogs.494', { value0: label }));
  if (blockers.has('pending_mutation')) {
    messages.push(uiMessage('alignment.lifecycle-dialogs.495', { value0: label }));
  }
  if (blockers.has('open_conflict')) {
    messages.push(uiMessage('alignment.lifecycle-dialogs.496', { value0: label }));
  }
  return messages;
}

function impactItemText(item: ImpactItem, target: AlignmentKind): string {
  if (item.kind === 'placement') return uiMessage('alignment.lifecycle-dialogs.497');
  if (item.kind === 'selection') return uiMessage('alignment.lifecycle-dialogs.498');
  const title =
    item.title === undefined ? kindLabel(item.kind) : `${kindLabel(item.kind)} “${item.title}”`;
  const archived = item.archived ? ' (archived)' : '';
  const relationship = item.relationship;
  if (relationship === undefined) return `${title}${archived}`;
  if (relationship === 'axis_action')
    return uiMessage('alignment.lifecycle-dialogs.499', { value0: title, value1: archived });
  if (relationship === 'axis_note')
    return uiMessage('alignment.lifecycle-dialogs.500', { value0: title, value1: archived });
  if (!isAlignmentRelationship(relationship)) return `${title}${archived}`;
  const direction = alignmentRelationshipRules[relationship].parentKind === target ? 'down' : 'up';
  return `${title}${archived} · ${relationshipLabel(relationship, direction)}`;
}

function ImpactList({
  items,
  label,
  target,
}: {
  readonly items: Bounded<ImpactItem>;
  readonly label: string;
  readonly target: AlignmentKind;
}): ReactNode {
  if (items.total === 0) return null;
  const more = items.total - items.items.length;
  return (
    <ul className="impact-list" aria-label={label}>
      {items.items.map((item) => (
        <li key={`${item.kind}:${item.id}`}>{impactItemText(item, target)}</li>
      ))}
      {more > 0 && (
        <li>{uiMessage('alignment.lifecycle-dialogs.501', { value0: String(more) })}</li>
      )}
    </ul>
  );
}

function removedHistoryText(view: DeleteImpactView): string | null {
  const parts = [
    ...(view.removedHistory.inactiveLinks > 0
      ? [
          plural(
            view.removedHistory.inactiveLinks,
            uiMessage('alignment.lifecycle-dialogs.502'),
            uiMessage('alignment.lifecycle-dialogs.503'),
          ),
        ]
      : []),
    ...(view.removedHistory.archivedPlacements > 0
      ? [
          plural(
            view.removedHistory.archivedPlacements,
            uiMessage('alignment.lifecycle-dialogs.504'),
            uiMessage('alignment.lifecycle-dialogs.505'),
          ),
        ]
      : []),
    ...(view.removedHistory.archivedSelections > 0
      ? [
          plural(
            view.removedHistory.archivedSelections,
            uiMessage('alignment.lifecycle-dialogs.506'),
            uiMessage('alignment.lifecycle-dialogs.507'),
          ),
        ]
      : []),
  ];
  return parts.length === 0
    ? null
    : uiMessage('alignment.lifecycle-dialogs.508', { value0: parts.join(', ') });
}

/** Review decisions about the object are kept and show “Deleted object”. */
export function keptReviewsText(view: DeleteImpactView): string | null {
  const count = view.historyReferences.reviews;
  if (count <= 0) return null;
  return count === 1
    ? uiMessage('alignment.lifecycle-dialogs.509')
    : uiMessage('alignment.lifecycle-dialogs.510', { value0: String(count) });
}

/**
 * Two steps: the impact (blockers explained, optional links and placements listed, and an explicit
 * choice to remove them), then the exact title typed to confirm. The delete button is never the
 * primary style and stays disabled until the title matches.
 */
export function DeleteDialog({
  onClose,
  open,
  parentPath,
  runner,
  target,
}: {
  readonly open: boolean;
  readonly target: LifecycleTarget;
  readonly parentPath: string;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const noticeNavigate = useNoticeNavigate();
  const id = useId();
  const label = kindLabel(target.kind);
  const confirmInput = useRef<HTMLInputElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const [session, setSession] = useState({
    open,
    policy: 'restrict' as PermanentDeletePolicy,
    step: 'impact' as 'impact' | 'confirm',
    confirmation: '',
    problem: null as string | null,
    attempt: 0,
  });
  let current = session;
  if (session.open !== open) {
    current = {
      open,
      policy: 'restrict',
      step: 'impact',
      confirmation: '',
      problem: null,
      attempt: session.attempt + 1,
    };
    setSession(current);
  }
  const update = (patch: Partial<typeof session>): void =>
    setSession((previous) => ({ ...previous, ...patch }));
  const [preview, setPreview] = useState<Loaded<DeleteImpactView>>({ status: 'loading' });
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreview({ status: 'loading' });
    alignment.previewDelete({ kind: target.kind, id: target.id }, current.policy).then(
      (view) => {
        if (live) setPreview({ status: 'ready', view });
      },
      () => {
        if (live) setPreview({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [alignment, open, current.policy, current.attempt, target.id, target.kind, target.revision]);
  const step = current.step;
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    if (step === 'confirm') confirmInput.current?.focus();
    else continueButton.current?.focus();
  }, [step]);

  const view = preview.status === 'ready' ? preview.view : null;
  const remove = async (): Promise<void> => {
    if (view === null || runner.busy || current.confirmation !== view.confirmationText) return;
    update({ problem: null });
    const outcome = await runForReceipt(
      runner,
      () =>
        alignment.deletePermanently({
          target: revisionRef(target),
          policy: current.policy,
          confirmation: current.confirmation,
        }),
      uiMessage('alignment.lifecycle-dialogs.511', { value0: label }),
    );
    if (!outcome.ok) {
      // Re-read the impact: something may have changed since the preview.
      update({ problem: outcome.message, attempt: current.attempt + 1 });
      return;
    }
    onClose();
    noticeNavigate(parentPath, uiMessage('alignment.lifecycle-dialogs.511', { value0: label }));
  };

  const blockers = view === null ? [] : deleteBlockerMessages(view);
  const optionalCount =
    view === null ? 0 : view.optionalLinks.total + view.placements + view.selections;
  const removing = current.policy === 'unlink_and_delete';
  const removedHistory = view === null ? null : removedHistoryText(view);
  const keptReviews = view === null ? null : keptReviewsText(view);
  const matches = view !== null && current.confirmation === view.confirmationText;
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('actions-ui.300')}
      title={uiMessage('alignment.lifecycle-dialogs.512', { value0: label })}
      className="delete-dialog"
      onClose={onClose}
    >
      {current.problem !== null && (
        <p className="validation-summary" role="alert">
          {current.problem}
        </p>
      )}
      {preview.status === 'loading' && (
        <p className="field-help">{uiMessage('alignment.lifecycle-dialogs.513')}</p>
      )}
      {preview.status === 'error' && (
        <p className="validation-summary" role="alert">
          {uiMessage('alignment.lifecycle-dialogs.514')}
        </p>
      )}
      {preview.status === 'ready' && view === null && (
        <p>{uiMessage('alignment.lifecycle-dialogs.515', { value0: label })}</p>
      )}
      {view !== null && step === 'impact' && (
        <>
          <p>
            <strong>{target.title}</strong>
          </p>
          {blockers.length > 0 ? (
            <div className="delete-blockers">
              <p>
                <strong>{uiMessage('alignment.lifecycle-dialogs.516')}</strong>
              </p>
              <ul>
                {blockers.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p>{uiMessage('alignment.lifecycle-dialogs.517', { value0: label })}</p>
          )}
          <ImpactList
            items={view.requiredChildren}
            label={uiMessage('alignment.lifecycle-dialogs.518', { value0: label })}
            target={target.kind}
          />
          {optionalCount > 0 && (
            <div className="delete-optional">
              <p>
                {removing
                  ? uiMessage('alignment.lifecycle-dialogs.519')
                  : uiMessage('alignment.lifecycle-dialogs.520')}
              </p>
              <ImpactList
                items={view.optionalLinks}
                label={uiMessage('alignment.lifecycle-dialogs.521')}
                target={target.kind}
              />
              {(view.placements > 0 || view.selections > 0) && (
                <p>
                  {[
                    ...(view.placements > 0
                      ? [
                          plural(
                            view.placements,
                            uiMessage('alignment.lifecycle-dialogs.522'),
                            uiMessage('alignment.lifecycle-dialogs.523'),
                          ),
                        ]
                      : []),
                    ...(view.selections > 0
                      ? [
                          plural(
                            view.selections,
                            uiMessage('alignment.lifecycle-dialogs.524'),
                            uiMessage('alignment.lifecycle-dialogs.525'),
                          ),
                        ]
                      : []),
                  ].join(uiMessage('plan.conflicts.1221'))}
                </p>
              )}
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={removing}
                  onChange={(event) =>
                    update({
                      policy: event.target.checked ? 'unlink_and_delete' : 'restrict',
                      problem: null,
                    })
                  }
                />
                {uiMessage('alignment.lifecycle-dialogs.526')}
              </label>
            </div>
          )}
          {keptReviews !== null && <p>{keptReviews}</p>}
          {removedHistory !== null && <p className="field-help">{removedHistory}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {uiMessage('account.account-dialogs.20')}
            </button>
            {view.allowed && (
              <button
                ref={continueButton}
                type="button"
                onClick={() => update({ step: 'confirm', confirmation: '', problem: null })}
              >
                {uiMessage('account.onboarding-sign-in.206')}
              </button>
            )}
          </div>
        </>
      )}
      {view !== null && step === 'confirm' && (
        <>
          <p>
            <strong>{uiMessage('alignment.lifecycle-dialogs.527')}</strong>
            {removing ? uiMessage('alignment.lifecycle-dialogs.528') : ''}
          </p>
          <div className="form-field">
            <label htmlFor={`${id}-confirm`}>
              {uiMessage('alignment.lifecycle-dialogs.529', { value0: label })}
            </label>
            <p id={`${id}-confirm-hint`} className="field-help">
              {uiMessage('alignment.lifecycle-dialogs.530')}
              <strong>{view.confirmationText}</strong>
            </p>
            <input
              ref={confirmInput}
              id={`${id}-confirm`}
              type="text"
              spellCheck={false}
              value={current.confirmation}
              aria-describedby={`${id}-confirm-hint`}
              onChange={(event) => update({ confirmation: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void remove();
                }
              }}
            />
          </div>
          <div className="dialog-actions">
            <button type="button" onClick={() => update({ step: 'impact', problem: null })}>
              {uiMessage('alignment.lifecycle-dialogs.531')}
            </button>
            <button
              type="button"
              className="alignment-destructive"
              disabled={!matches || runner.busy}
              onClick={() => void remove()}
            >
              {runner.busy ? uiMessage('account.account-dialogs.69') : uiMessage('actions-ui.307')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
