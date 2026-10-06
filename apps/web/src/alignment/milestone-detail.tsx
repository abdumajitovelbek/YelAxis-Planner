import { message as uiMessage } from '../messages';
/**
 * `/milestones/:milestoneId`: one Milestone with its checkpoint, target window, placement, the
 * alignment chain (Axis → Outcome → Milestone), the Projects and Actions that support it, and its
 * history, plus every manual action: complete or reopen, edit, move in time, move to another
 * Outcome, links, archive or restore, and permanent deletion.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import type {
  AlignmentEdge,
  AlignmentNode,
  AlignmentRelationship,
  MilestoneDetail,
  MilestoneItem,
  RevisionRef,
} from '@yelaxis/application';
import type { CalendarDate, MilestoneState } from '@yelaxis/domain';

import { Modal } from '../plan/modal';
import {
  useAlignment,
  useCommandRunner,
  usePlanning,
  type CommandRunner,
} from '../plan/planning-context';
import { outcomePath } from '../plan/routes';
import { HorizonSection, targetWindowText } from '../plan/theme-editor';
import { DialogError, isCalendarDate, useFocusRescue, ViewFeedback } from '../plan/timeline';
import {
  alignmentNode,
  CommandButton,
  DetailList,
  edgeTo,
  lifecycleTarget,
  NodeLink,
  PlacementFact,
  PlacementForm,
  UnlinkButton,
  type DetailRow,
} from './detail-parts';
import { BoundedNote, FactList, HistoryList, ObjectHeader, ObjectPage, StatusPill } from './kit';
import { stateLabel } from './labels';
import { ArchivedNotice, ArchiveDialog, DangerZone } from './lifecycle-dialogs';
import { LinkDialog, ReparentMilestoneDialog, UnlinkDialog } from './link-dialogs';
import { MilestoneFormDialog } from './object-forms';

interface StateChange {
  readonly to: Exclude<MilestoneState, 'archived'>;
  readonly label: string;
  readonly done: string;
}

/** Completion is always manual; moving or linking never changes the state. */
const stateChanges: Readonly<Record<MilestoneState, readonly StateChange[]>> = {
  active: [
    {
      to: 'completed',
      label: uiMessage('actions-ui.257'),
      done: uiMessage('alignment.milestone-detail.600'),
    },
    {
      to: 'canceled',
      label: uiMessage('alignment.milestone-detail.601'),
      done: uiMessage('alignment.milestone-detail.602'),
    },
  ],
  completed: [
    {
      to: 'active',
      label: uiMessage('alignment.milestone-detail.603'),
      done: uiMessage('alignment.milestone-detail.604'),
    },
  ],
  canceled: [
    {
      to: 'active',
      label: uiMessage('alignment.milestone-detail.603'),
      done: uiMessage('alignment.milestone-detail.604'),
    },
  ],
  archived: [],
};

type Dialog = 'edit' | 'move' | 'reparent' | 'archive' | 'link' | 'unlink' | null;

export function MilestoneDetailPage(): ReactNode {
  const alignment = useAlignment();
  const { milestoneId = '' } = useParams();
  return (
    <ObjectPage kind="milestone" id={milestoneId} load={(id) => alignment.getMilestone(id)}>
      {(detail) => <MilestoneView detail={detail} />}
    </ObjectPage>
  );
}

function MilestoneView({ detail }: { readonly detail: MilestoneDetail }): ReactNode {
  const alignment = useAlignment();
  const planning = usePlanning();
  const runner = useCommandRunner();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusRescue(heading, runner, detail);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [linkRelationships, setLinkRelationships] = useState<readonly AlignmentRelationship[]>([
    'milestone_project',
  ]);
  const [unlinkEdge, setUnlinkEdge] = useState<AlignmentEdge | null>(null);
  const { axis, milestone } = detail;
  const archived = milestone.state === 'archived';
  const busy = runner.busy;
  const ref: RevisionRef<'milestone'> = {
    kind: 'milestone',
    id: milestone.id,
    revision: milestone.localRevision,
  };
  const target = lifecycleTarget('milestone', milestone);
  const focus = alignmentNode('milestone', milestone);
  const parentPath = outcomePath(milestone.outcome.id);
  const close = (): void => {
    runner.clearError();
    setDialog(null);
  };
  const link = (relationship: AlignmentRelationship): void => {
    setLinkRelationships([relationship]);
    setDialog('link');
  };
  const unlink = (edge: AlignmentEdge): void => {
    setUnlinkEdge(edge);
    setDialog('unlink');
  };

  const projectRows: readonly DetailRow[] = detail.projects.items.map((project) => ({
    key: project.id,
    kind: 'project',
    node: project,
    ...(archived
      ? {}
      : {
          controls: (
            <UnlinkButton
              title={project.title}
              disabled={busy}
              onClick={() =>
                unlink(
                  edgeTo('milestone_project', 'down', alignmentNode('project', project), project),
                )
              }
            />
          ),
        }),
  }));
  const actionRows: readonly DetailRow[] = detail.actions.items.map((action) => ({
    key: action.id,
    kind: 'action',
    node: action,
    ...(archived
      ? {}
      : {
          controls: (
            <UnlinkButton
              title={action.title}
              disabled={busy}
              onClick={() =>
                unlink(edgeTo('milestone_action', 'down', alignmentNode('action', action), action))
              }
            />
          ),
        }),
  }));

  return (
    <section
      className="content-section alignment-page alignment-detail"
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <ObjectHeader
        kind="milestone"
        state={milestone.state}
        title={milestone.title}
        titleId={titleId}
        headingRef={heading}
        back={{ to: parentPath, label: milestone.outcome.title }}
      />
      {archived && <ArchivedNotice target={target} runner={runner} />}
      <FactList
        items={[
          {
            term: uiMessage('alignment.milestone-detail.605'),
            value: milestone.measurableCheckpoint,
          },
          {
            term: uiMessage('alignment.milestone-detail.606'),
            value: targetWindowText(milestone.targetStart, milestone.targetEnd),
          },
          {
            term: uiMessage('alignment.milestone-detail.607'),
            value: (
              <NodeLink
                kind="outcome"
                node={milestone.outcome}
                archivedText={uiMessage('alignment.milestone-detail.2407')}
              />
            ),
          },
          {
            term: uiMessage('alignment.milestone-detail.608'),
            value: <PlacementFact placement={milestone.placement} />,
          },
        ]}
      />
      {!archived && (
        <div
          className="detail-actions"
          role="group"
          aria-label={uiMessage('alignment.milestone-detail.609')}
        >
          {stateChanges[milestone.state].map((change) => (
            <CommandButton
              key={change.to}
              busy={busy}
              onClick={() =>
                void runner.run(() => alignment.transitionMilestone(ref, change.to), change.done)
              }
            >
              {change.label}
            </CommandButton>
          ))}
          <CommandButton busy={busy} onClick={() => setDialog('edit')}>
            {uiMessage('alignment.axis-detail.418')}
          </CommandButton>
          <CommandButton busy={busy} onClick={() => setDialog('move')}>
            {uiMessage('alignment.milestone-detail.610')}
          </CommandButton>
          <CommandButton busy={busy} onClick={() => setDialog('reparent')}>
            {uiMessage('alignment.milestone-detail.611')}
          </CommandButton>
          {milestone.placement !== undefined && (
            <CommandButton
              busy={busy}
              onClick={() =>
                void runner.run(
                  () => planning.unplace({ target: ref }),
                  uiMessage('alignment.milestone-detail.612'),
                )
              }
            >
              {uiMessage('alignment.milestone-detail.613')}
            </CommandButton>
          )}
          <CommandButton busy={busy} onClick={() => setDialog('archive')}>
            {uiMessage('alignment.axis-detail.423')}
          </CommandButton>
        </div>
      )}
      <ViewFeedback runner={runner} showError={dialog === null} />

      <HorizonSection
        title={uiMessage('alignment.alignment-page.377')}
        help={uiMessage('alignment.milestone-detail.614')}
      >
        <ol className="chain-list" aria-label={uiMessage('alignment.milestone-detail.615')}>
          <li className="chain-step">
            <p className="chain-kind">{uiMessage('actions-ui.251')}</p>
            <p className="horizon-item-title">
              {axis === undefined ? (
                uiMessage('alignment.milestone-detail.616')
              ) : (
                <NodeLink kind="axis" node={axis} />
              )}
            </p>
          </li>
          <li className="chain-step">
            <p className="chain-kind">{uiMessage('alignment.milestone-detail.607')}</p>
            <p className="horizon-item-title">
              <NodeLink
                kind="outcome"
                node={milestone.outcome}
                archivedText={uiMessage('alignment.milestone-detail.2407')}
              />
            </p>
            {!milestone.outcome.archived && (
              <p className="horizon-meta">
                <StatusPill label={stateLabel('outcome', milestone.outcome.state)} />
              </p>
            )}
          </li>
          <li className="chain-step chain-step-current">
            <p className="chain-kind">{uiMessage('alignment.milestone-detail.617')}</p>
            <p className="horizon-item-title">{milestone.title}</p>
            <p className="horizon-meta">
              <StatusPill label={stateLabel('milestone', milestone.state)} />
            </p>
          </li>
        </ol>
      </HorizonSection>

      <HorizonSection title={uiMessage('alignment.milestone-detail.618')}>
        <DetailList
          label={uiMessage('alignment.milestone-detail.619', { value0: milestone.title })}
          empty={uiMessage('alignment.milestone-detail.620')}
          rows={projectRows}
        />
        <BoundedNote
          shown={detail.projects.items.length}
          total={detail.projects.total}
          noun={uiMessage('alignment.axis-detail.429')}
        />
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => link('milestone_project')}>
              {uiMessage('alignment.milestone-detail.621')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HorizonSection title={uiMessage('alignment.milestone-detail.622')}>
        <DetailList
          label={uiMessage('alignment.milestone-detail.623', { value0: milestone.title })}
          empty={uiMessage('alignment.milestone-detail.624')}
          rows={actionRows}
        />
        <BoundedNote
          shown={detail.actions.items.length}
          total={detail.actions.total}
          noun={uiMessage('alignment.project-detail.758')}
        />
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => link('milestone_action')}>
              {uiMessage('alignment.milestone-detail.625')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HistoryList entries={detail.history} />
      <DangerZone target={target} parentPath={parentPath} runner={runner} />

      <MilestoneDialogs
        dialog={dialog}
        focus={focus}
        linkRelationships={linkRelationships}
        milestone={milestone}
        runner={runner}
        unlinkEdge={unlinkEdge}
        onClose={close}
      />
    </section>
  );
}

/** Every dialog stays mounted, so the shared Modal returns focus to the control that opened it. */
function MilestoneDialogs({
  dialog,
  focus,
  linkRelationships,
  milestone,
  onClose,
  runner,
  unlinkEdge,
}: {
  readonly dialog: Dialog;
  readonly focus: AlignmentNode;
  readonly linkRelationships: readonly AlignmentRelationship[];
  readonly milestone: MilestoneItem;
  readonly runner: CommandRunner;
  readonly unlinkEdge: AlignmentEdge | null;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <>
      <MilestoneFormDialog
        open={dialog === 'edit'}
        mode="edit"
        initial={milestone}
        runner={runner}
        onClose={onClose}
      />
      <MoveMilestoneDialog
        open={dialog === 'move'}
        milestone={milestone}
        runner={runner}
        onClose={onClose}
      />
      <ReparentMilestoneDialog
        open={dialog === 'reparent'}
        milestone={{
          kind: 'milestone',
          id: milestone.id,
          revision: milestone.localRevision,
          title: milestone.title,
          outcomeId: milestone.outcome.id,
        }}
        runner={runner}
        onClose={onClose}
      />
      <ArchiveDialog
        open={dialog === 'archive'}
        target={lifecycleTarget('milestone', milestone)}
        runner={runner}
        onClose={onClose}
      />
      <LinkDialog
        open={dialog === 'link'}
        focus={focus}
        relationships={linkRelationships}
        runner={runner}
        onClose={onClose}
      />
      {unlinkEdge !== null && (
        <UnlinkDialog
          open={dialog === 'unlink'}
          focus={focus}
          edge={unlinkEdge}
          runner={runner}
          onClose={onClose}
        />
      )}
    </>
  );
}

/**
 * Move a Milestone in time: its Month or Week placement and its target window, each saved on its
 * own. Moving never reopens or completes it; another Outcome is a separate command.
 */
function MoveMilestoneDialog({
  milestone,
  onClose,
  open,
  runner,
}: {
  readonly open: boolean;
  readonly milestone: MilestoneItem;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}): ReactNode {
  const placementId = useId();
  const windowId = useId();
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('plan.scheduling-dialogs.1647')}
      title={uiMessage('alignment.milestone-detail.626', { value0: milestone.title })}
      description={uiMessage('alignment.milestone-detail.627')}
      onClose={close}
    >
      {open && (
        <div className="move-sections">
          <DialogError runner={runner} />
          <section aria-labelledby={placementId}>
            <h3 id={placementId}>{uiMessage('alignment.milestone-detail.628')}</h3>
            <PlacementForm
              allowed={['month', 'week']}
              current={milestone.placement?.period}
              target={{ kind: 'milestone', id: milestone.id, revision: milestone.localRevision }}
              title={milestone.title}
              submitLabel={uiMessage('alignment.milestone-detail.2408')}
              runner={runner}
              onDone={onClose}
            />
          </section>
          <section aria-labelledby={windowId}>
            <h3 id={windowId}>{uiMessage('alignment.milestone-detail.606')}</h3>
            <TargetWindowForm milestone={milestone} runner={runner} onDone={onClose} />
          </section>
        </div>
      )}
    </Modal>
  );
}

function targetWindowProblem(start: string, end: string): string | null {
  if (start !== '' && !isCalendarDate(start)) return uiMessage('alignment.milestone-detail.629');
  if (end !== '' && !isCalendarDate(end)) return uiMessage('alignment.milestone-detail.630');
  if (start !== '' && end !== '' && start > end) return uiMessage('alignment.milestone-detail.631');
  return null;
}

/** The inclusive target window; either date may be left empty. Title and checkpoint stay as they are. */
function TargetWindowForm({
  milestone,
  onDone,
  runner,
}: {
  readonly milestone: MilestoneItem;
  readonly runner: CommandRunner;
  readonly onDone: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const idBase = useId();
  const [start, setStart] = useState<string>(milestone.targetStart ?? '');
  const [end, setEnd] = useState<string>(milestone.targetEnd ?? '');
  const [error, setError] = useState<string | null>(null);
  const problem = targetWindowProblem(start, end);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    const saved = await runner.run(
      () =>
        alignment.editMilestone(
          { kind: 'milestone', id: milestone.id, revision: milestone.localRevision },
          {
            title: milestone.title,
            measurableCheckpoint: milestone.measurableCheckpoint,
            ...(start === '' ? {} : { targetStart: start }),
            ...(end === '' ? {} : { targetEnd: end }),
          },
        ),
      uiMessage('alignment.milestone-detail.632'),
    );
    if (saved) onDone();
  };
  const described = [`${idBase}-help`, ...(error === null ? [] : [`${idBase}-error`])].join(' ');
  return (
    <form noValidate onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p id={`${idBase}-error`} className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <p id={`${idBase}-help`} className="field-help">
        {uiMessage('alignment.milestone-detail.633')}
      </p>
      <div className="two-column-fields">
        <label className="field-label" htmlFor={`${idBase}-start`}>
          {uiMessage('alignment.milestone-detail.634')}
          <input
            id={`${idBase}-start`}
            type="date"
            value={start}
            aria-invalid={error !== null}
            aria-describedby={described}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label className="field-label" htmlFor={`${idBase}-end`}>
          {uiMessage('alignment.milestone-detail.635')}
          <input
            id={`${idBase}-end`}
            type="date"
            value={end}
            aria-invalid={error !== null}
            aria-describedby={described}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
      </div>
      <p className="interval-summary" role="status">
        {problem ??
          targetWindowText(
            start === '' ? undefined : (start as CalendarDate),
            end === '' ? undefined : (end as CalendarDate),
          )}
      </p>
      <div className="dialog-actions">
        <button type="submit" className="primary-button" disabled={runner.busy}>
          {runner.busy
            ? uiMessage('account.conflicts-page.133')
            : uiMessage('alignment.milestone-detail.636')}
        </button>
      </div>
    </form>
  );
}
