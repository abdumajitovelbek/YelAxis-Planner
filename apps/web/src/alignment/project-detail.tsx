import { message as uiMessage } from '../messages';
/**
 * `/projects/:projectId`: one Project with its desired result, target window, Axis, placement, next
 * action, Outcomes, Milestones, ordered Actions, notes, and history, plus every manual action:
 * edit, state changes, placement, this week's commitments, scheduling an Action, links, archive or
 * restore, and permanent deletion.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import type {
  ActionSummary,
  AlignmentEdge,
  AlignmentNode,
  AlignmentRelationship,
  ApplicationResult,
  CommandReceipt,
  LinkedItem,
  NextActionView,
  NodeRef,
  PlanProfile,
  ProjectDetail,
  RevisionRef,
} from '@yelaxis/application';
import { alignmentFieldLimits, nextActionStates, type ProjectState } from '@yelaxis/domain';

import { Modal } from '../plan/modal';
import {
  CommandFeedback,
  useActionsApplication,
  useAlignment,
  useCommandRunner,
  usePlanning,
  usePlanningToday,
  type CommandRunner,
} from '../plan/planning-context';
import { actionPath, axisOverviewPath, axisPath, outcomePath } from '../plan/routes';
import { ScheduleActionDialog } from '../plan/scheduling-dialogs';
import { HorizonSection, targetWindowText } from '../plan/theme-editor';
import { DialogError, useFocusRescue, ViewFeedback } from '../plan/timeline';
import { useUnsavedGuard } from '../plan/unsaved-guard';
import {
  alignmentNode,
  CommandButton,
  DetailList,
  edgeTo,
  lifecycleTarget,
  NodeLink,
  PlacementDialog,
  PlacementFact,
  UnlinkButton,
  type DetailRow,
} from './detail-parts';
import {
  BoundedNote,
  FactList,
  HistoryList,
  MoveButtons,
  ObjectHeader,
  ObjectPage,
  StatusPill,
} from './kit';
import { stateLabel } from './labels';
import { ArchivedNotice, ArchiveDialog, DangerZone } from './lifecycle-dialogs';
import { LinkDialog, UnlinkDialog } from './link-dialogs';
import { ProjectFormDialog } from './object-forms';

type ProjectData = ProjectDetail['project'];
type ProjectAction = ProjectDetail['actions']['items'][number];

interface StateChange {
  readonly to: Exclude<ProjectState, 'archived' | 'idea'>;
  readonly label: string;
  readonly done: string;
}

const pause: StateChange = {
  to: 'paused',
  label: uiMessage('alignment.outcome-detail.707'),
  done: uiMessage('alignment.project-detail.733'),
};
const complete: StateChange = {
  to: 'completed',
  label: uiMessage('actions-ui.257'),
  done: uiMessage('alignment.project-detail.734'),
};

/** The manual state changes offered from each state (state-machines.md). */
const stateChanges: Readonly<Record<ProjectState, readonly StateChange[]>> = {
  idea: [
    {
      to: 'active',
      label: uiMessage('alignment.project-detail.735'),
      done: uiMessage('alignment.project-detail.736'),
    },
    pause,
  ],
  active: [
    {
      to: 'blocked',
      label: uiMessage('alignment.project-detail.737'),
      done: uiMessage('alignment.project-detail.738'),
    },
    pause,
    complete,
  ],
  blocked: [
    {
      to: 'active',
      label: uiMessage('alignment.project-detail.739'),
      done: uiMessage('alignment.project-detail.740'),
    },
    pause,
    complete,
  ],
  paused: [
    {
      to: 'active',
      label: uiMessage('alignment.outcome-detail.712'),
      done: uiMessage('alignment.project-detail.741'),
    },
    complete,
  ],
  completed: [
    {
      to: 'active',
      label: uiMessage('alignment.milestone-detail.603'),
      done: uiMessage('alignment.project-detail.742'),
    },
  ],
  archived: [],
};

const outcomeRelationships: readonly AlignmentRelationship[] = [
  'outcome_primary_project',
  'outcome_secondary_project',
];

/** The most Actions one page shows ("Show all" raises the default to this bound). */
const allActionsLimit = 200;

type Dialog = 'edit' | 'place' | 'archive' | 'add-action' | 'schedule' | 'link' | 'unlink' | null;

export function ProjectDetailPage(): ReactNode {
  const alignment = useAlignment();
  const { projectId = '' } = useParams();
  // The Project whose full Action list was asked for; any other Project opens with the default.
  const showAllFor = useRef<string | null>(null);
  return (
    <ObjectPage
      kind="project"
      id={projectId}
      load={(id) =>
        alignment.getProject(
          id,
          showAllFor.current === id ? { actionLimit: allActionsLimit } : undefined,
        )
      }
    >
      {(detail, reload) => (
        <ProjectView
          detail={detail}
          onShowAllActions={() => {
            showAllFor.current = projectId;
            void reload();
          }}
        />
      )}
    </ObjectPage>
  );
}

/** Where Delete and the back link lead: the primary Outcome, else the Axis, else all Axes. */
function parentOf(project: ProjectData): { readonly to: string; readonly label: string } {
  if (project.primaryOutcome !== undefined)
    return { to: outcomePath(project.primaryOutcome.id), label: project.primaryOutcome.title };
  if (project.axis !== undefined)
    return { to: axisPath(project.axis.id), label: project.axis.title };
  return { to: axisOverviewPath, label: uiMessage('alignment.alignment-page.384') };
}

/**
 * A foreign-key parent (the primary Outcome) as a node. Unlinking it changes only the Project and
 * uses the Project's revision, so the parent's own revision is not part of this read model.
 */
function parentNode(kind: 'axis' | 'outcome', ref: NodeRef): AlignmentNode {
  return { ...ref, kind, localRevision: 0 };
}

/** The editable fields of a Project, kept as they are except for the given notes. */
function projectFields(project: ProjectData, notes: string | undefined) {
  return {
    title: project.title,
    ...(project.desiredResult === undefined ? {} : { desiredResult: project.desiredResult }),
    ...(project.description === undefined ? {} : { description: project.description }),
    ...(notes === undefined ? {} : { notes }),
    ...(project.targetStart === undefined ? {} : { targetStart: project.targetStart }),
    ...(project.targetEnd === undefined ? {} : { targetEnd: project.targetEnd }),
  };
}

/** An unfinished Action of the list, in the shape the Schedule dialog uses. */
function schedulable(action: ProjectAction): ActionSummary | null {
  const state = nextActionStates.find((candidate) => candidate === action.state);
  return state === undefined
    ? null
    : {
        id: action.id,
        title: action.title,
        state,
        localRevision: action.localRevision,
        orderKey: action.orderKey,
      };
}

function ProjectView({
  detail,
  onShowAllActions,
}: {
  readonly detail: ProjectDetail;
  readonly onShowAllActions: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const planning = usePlanning();
  const runner = useCommandRunner();
  const today = usePlanningToday();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusRescue(heading, runner, detail);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [linkRelationships, setLinkRelationships] =
    useState<readonly AlignmentRelationship[]>(outcomeRelationships);
  const [unlinkEdge, setUnlinkEdge] = useState<AlignmentEdge | null>(null);
  const [schedule, setSchedule] = useState<{
    readonly action: ActionSummary;
    readonly profile: PlanProfile;
  } | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const { project } = detail;
  const archived = project.state === 'archived';
  const busy = runner.busy;
  const ref: RevisionRef<'project'> = {
    kind: 'project',
    id: project.id,
    revision: project.localRevision,
  };
  const target = lifecycleTarget('project', project);
  const focus = alignmentNode('project', project);
  const parent = parentOf(project);
  const noDesiredResult = (project.desiredResult ?? '').trim() === '';
  const close = (): void => {
    runner.clearError();
    setDialog(null);
  };
  const link = (relationships: readonly AlignmentRelationship[]): void => {
    setLinkRelationships(relationships);
    setDialog('link');
  };
  const unlink = (edge: AlignmentEdge): void => {
    setUnlinkEdge(edge);
    setDialog('unlink');
  };
  const openSchedule = (action: ActionSummary): void => {
    setScheduleError(null);
    void planning.getCapacitySettings().then(
      (settings) => {
        setSchedule({ action, profile: settings.profile });
        setDialog('schedule');
      },
      () => setScheduleError(uiMessage('alignment.project-detail.743')),
    );
  };

  const primary = project.primaryOutcome;
  const primaryRows: readonly DetailRow[] =
    primary === undefined
      ? []
      : [
          {
            key: primary.id,
            kind: 'outcome',
            node: primary,
            ...(archived
              ? {}
              : {
                  controls: (
                    <UnlinkButton
                      title={primary.title}
                      disabled={busy}
                      onClick={() =>
                        unlink(
                          edgeTo('outcome_primary_project', 'up', parentNode('outcome', primary)),
                        )
                      }
                    />
                  ),
                }),
          },
        ];
  const joinRows = <K extends 'outcome' | 'milestone'>(
    kind: K,
    relationship: AlignmentRelationship,
    items: readonly LinkedItem<K>[],
  ): readonly DetailRow[] =>
    items.map((item) => ({
      key: item.id,
      kind,
      node: item,
      ...(archived
        ? {}
        : {
            controls: (
              <UnlinkButton
                title={item.title}
                disabled={busy}
                onClick={() => unlink(edgeTo(relationship, 'up', alignmentNode(kind, item), item))}
              />
            ),
          }),
    }));
  const actions = detail.actions.items;
  const lastAction = actions.length - 1;
  const actionRows: readonly DetailRow[] = actions.map((action, index) => {
    const summary = schedulable(action);
    return {
      key: action.id,
      kind: 'action',
      node: action,
      ...(archived
        ? {}
        : {
            controls: (
              <>
                <MoveButtons
                  itemLabel={action.title}
                  isFirst={index === 0}
                  isLast={index === lastAction && actions.length === detail.actions.total}
                  disabled={busy}
                  onMove={(direction) =>
                    void runner.run(
                      () =>
                        alignment.reorder({
                          target: { kind: 'action', id: action.id, revision: action.localRevision },
                          direction,
                          scope: { container: 'project_actions', projectId: project.id },
                        }),
                      uiMessage('alignment.outcome-detail.717', {
                        value0: action.title,
                        value1: direction,
                      }),
                    )
                  }
                />
                {summary !== null && (
                  <CommandButton busy={busy} onClick={() => openSchedule(summary)}>
                    {uiMessage('alignment.project-detail.744')}
                    <span className="sr-only">{action.title}</span>
                  </CommandButton>
                )}
                <UnlinkButton
                  title={action.title}
                  disabled={busy}
                  onClick={() =>
                    unlink(edgeTo('project_action', 'down', alignmentNode('action', action)))
                  }
                />
              </>
            ),
          }),
    };
  });
  const hiddenActions = detail.actions.total - actions.length;

  return (
    <section
      className="content-section alignment-page alignment-detail"
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <ObjectHeader
        kind="project"
        state={project.state}
        title={project.title}
        titleId={titleId}
        headingRef={heading}
        back={parent}
      />
      {archived && <ArchivedNotice target={target} runner={runner} />}
      {project.state === 'active' && (
        <NextAction
          next={project.nextAction}
          disabled={busy}
          onAdd={() => setDialog('add-action')}
        />
      )}
      <FactList
        items={[
          {
            term: uiMessage('alignment.object-forms.672'),
            value: noDesiredResult
              ? uiMessage('alignment.project-detail.745')
              : project.desiredResult,
          },
          {
            term: uiMessage('alignment.milestone-detail.606'),
            value: targetWindowText(project.targetStart, project.targetEnd),
          },
          {
            term: uiMessage('actions-ui.251'),
            value:
              project.axis === undefined ? (
                uiMessage('alignment.alignment-page.385')
              ) : (
                <NodeLink kind="axis" node={project.axis} />
              ),
          },
          {
            term: uiMessage('alignment.milestone-detail.608'),
            value: <PlacementFact placement={project.placement} />,
          },
          ...(project.description === undefined
            ? []
            : [{ term: uiMessage('alignment.object-forms.678'), value: project.description }]),
        ]}
      />
      {!archived && (
        <div
          className="detail-actions"
          role="group"
          aria-label={uiMessage('alignment.project-detail.746')}
        >
          <CommandButton busy={busy} onClick={() => setDialog('edit')}>
            {uiMessage('alignment.axis-detail.418')}
          </CommandButton>
          {stateChanges[project.state].map((change) => (
            <CommandButton
              key={change.to}
              busy={busy}
              onClick={() =>
                void runner.run(() => alignment.transitionProject(ref, change.to), change.done)
              }
            >
              {change.label}
            </CommandButton>
          ))}
          <CommandButton busy={busy} onClick={() => setDialog('place')}>
            {uiMessage('alignment.project-detail.747')}
          </CommandButton>
          {project.placement !== undefined && (
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
          <CommandButton
            busy={busy}
            onClick={() =>
              void runner.run(
                () =>
                  planning.addWeekCommitment({
                    weekDate: today,
                    target: { kind: 'project', id: project.id },
                  }),
                uiMessage('alignment.project-detail.748'),
              )
            }
          >
            {uiMessage('alignment.project-detail.749')}
          </CommandButton>
          <CommandButton busy={busy} onClick={() => setDialog('archive')}>
            {uiMessage('alignment.axis-detail.423')}
          </CommandButton>
        </div>
      )}
      {!archived && project.state === 'idea' && noDesiredResult && (
        <p className="field-help">{uiMessage('alignment.project-detail.750')}</p>
      )}
      <ViewFeedback runner={runner} showError={dialog === null} />
      {scheduleError !== null && (
        <p className="validation-summary" role="alert">
          {scheduleError}
        </p>
      )}

      <HorizonSection title={uiMessage('alignment.axis-detail.425')}>
        <div className="alignment-subsection">
          <h3>{uiMessage('alignment.object-forms.681')}</h3>
          <DetailList
            label={uiMessage('alignment.project-detail.751', { value0: project.title })}
            empty={uiMessage('alignment.project-detail.752')}
            rows={primaryRows}
          />
        </div>
        <div className="alignment-subsection">
          <h3>{uiMessage('alignment.outcome-detail.729')}</h3>
          <DetailList
            label={uiMessage('alignment.project-detail.753', { value0: project.title })}
            empty={uiMessage('alignment.project-detail.754')}
            rows={joinRows('outcome', 'outcome_secondary_project', detail.secondaryOutcomes)}
          />
        </div>
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => link(outcomeRelationships)}>
              {uiMessage('alignment.project-detail.755')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HorizonSection title={uiMessage('actions-ui.314')}>
        <DetailList
          label={uiMessage('alignment.project-detail.756', { value0: project.title })}
          empty={uiMessage('alignment.project-detail.757')}
          rows={joinRows('milestone', 'milestone_project', detail.milestones.items)}
        />
        <BoundedNote
          shown={detail.milestones.items.length}
          total={detail.milestones.total}
          noun={uiMessage('alignment.outcome-detail.2409')}
        />
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => link(['milestone_project'])}>
              {uiMessage('actions-ui.323')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HorizonSection title={uiMessage('alignment.project-detail.758')}>
        <DetailList
          ordered
          label={uiMessage('alignment.project-detail.759', { value0: project.title })}
          empty={uiMessage('alignment.project-detail.760')}
          rows={actionRows}
        />
        {hiddenActions > 0 &&
          (actions.length < allActionsLimit ? (
            <button type="button" className="text-button" onClick={onShowAllActions}>
              {detail.actions.total <= allActionsLimit
                ? uiMessage('alignment.project-detail.761', {
                    value0: String(detail.actions.total),
                  })
                : uiMessage('alignment.project-detail.762', {
                    value0: String(allActionsLimit),
                    value1: String(detail.actions.total),
                  })}
            </button>
          ) : (
            <BoundedNote
              shown={actions.length}
              total={detail.actions.total}
              noun={uiMessage('alignment.project-detail.2410')}
            />
          ))}
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => setDialog('add-action')}>
              {uiMessage('alignment.project-detail.763')}
            </CommandButton>
            <CommandButton busy={busy} onClick={() => link(['project_action'])}>
              {uiMessage('alignment.milestone-detail.625')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HorizonSection title={uiMessage('alignment.object-forms.679')}>
        <ProjectNotes project={project} readOnly={archived} />
        <div className="alignment-subsection">
          <h3>{uiMessage('alignment.project-detail.764')}</h3>
          {detail.capturedNotes.items.length === 0 ? (
            <p className="quiet-empty">{uiMessage('alignment.project-detail.765')}</p>
          ) : (
            <ul className="captured-notes" aria-label={uiMessage('alignment.project-detail.764')}>
              {detail.capturedNotes.items.map((note) => (
                <li key={note.id}>{note.title}</li>
              ))}
            </ul>
          )}
          <BoundedNote
            shown={detail.capturedNotes.items.length}
            total={detail.capturedNotes.total}
            noun={uiMessage('alignment.project-detail.2411')}
          />
        </div>
      </HorizonSection>

      <HistoryList entries={detail.history} />
      <DangerZone target={target} parentPath={parent.to} runner={runner} />

      <ProjectFormDialog
        open={dialog === 'edit'}
        mode="edit"
        initial={project}
        runner={runner}
        onClose={close}
      />
      <PlacementDialog
        open={dialog === 'place'}
        allowed={['year', 'month', 'week']}
        current={project.placement?.period}
        target={ref}
        title={project.title}
        runner={runner}
        onClose={close}
      />
      <ArchiveDialog open={dialog === 'archive'} target={target} runner={runner} onClose={close} />
      <AddActionDialog
        open={dialog === 'add-action'}
        project={project}
        runner={runner}
        onClose={close}
      />
      {schedule !== null && (
        <ScheduleActionDialog
          request={
            dialog === 'schedule'
              ? { kind: 'schedule', action: schedule.action, date: today }
              : null
          }
          profile={schedule.profile}
          runner={runner}
          onClose={close}
          onDone={() => setDialog(null)}
        />
      )}
      <LinkDialog
        open={dialog === 'link'}
        focus={focus}
        relationships={linkRelationships}
        runner={runner}
        onClose={close}
      />
      {unlinkEdge !== null && (
        <UnlinkDialog
          open={dialog === 'unlink'}
          focus={focus}
          edge={unlinkEdge}
          runner={runner}
          onClose={close}
        />
      )}
    </section>
  );
}

/** An active Project's next action, or a neutral notice when it has none. Never a block. */
function NextAction({
  disabled,
  next,
  onAdd,
}: {
  readonly next: NextActionView;
  readonly disabled: boolean;
  readonly onAdd: () => void;
}): ReactNode {
  switch (next.status) {
    case 'not_applicable':
      return null;
    case 'missing':
      return (
        <div className="next-action">
          <p className="next-action-missing">{uiMessage('alignment.kit.472')}</p>
          <CommandButton busy={disabled} onClick={onAdd}>
            {uiMessage('alignment.project-detail.766')}
          </CommandButton>
        </div>
      );
    case 'present':
      return (
        <p className="next-action">
          <span>{uiMessage('alignment.project-detail.767')}</span>{' '}
          <Link to={actionPath(next.action.id)}>{next.action.title}</Link>{' '}
          <StatusPill label={stateLabel('action', next.action.state)} />
        </p>
      );
  }
}

/**
 * The Project's own notes field, with its own feedback next to it. Captured Note records are listed
 * separately, read-only.
 */
function ProjectNotes({
  project,
  readOnly,
}: {
  readonly project: ProjectData;
  readonly readOnly: boolean;
}): ReactNode {
  const alignment = useAlignment();
  const runner = useCommandRunner();
  const idBase = useId();
  const limit = alignmentFieldLimits.projectNotes;
  const stored = project.notes ?? '';
  const [draft, setDraft] = useState(stored);
  const [baseline, setBaseline] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  if (baseline !== stored && draft === baseline) {
    // A committed change (Edit…, Undo) replaced the notes while they were not being edited.
    setBaseline(stored);
    setDraft(stored);
  }
  const dirty = draft !== baseline;
  const save = async (): Promise<boolean> => {
    if (draft.length > limit) {
      setError(uiMessage('alignment.project-detail.768', { value0: limit.toLocaleString() }));
      return false;
    }
    setError(null);
    const saved = await runner.run(
      () =>
        alignment.editProject(
          { kind: 'project', id: project.id, revision: project.localRevision },
          projectFields(project, draft.trim() === '' ? undefined : draft),
        ),
      uiMessage('alignment.project-detail.769'),
    );
    if (saved) setBaseline(draft);
    return saved;
  };
  const { dialog } = useUnsavedGuard(dirty && !readOnly, save);
  if (readOnly)
    return stored === '' ? (
      <p className="quiet-empty">{uiMessage('alignment.project-detail.770')}</p>
    ) : (
      <p className="project-notes-text">{stored}</p>
    );
  const described = [`${idBase}-count`, ...(error === null ? [] : [`${idBase}-error`])].join(' ');
  return (
    <form
      className="project-notes"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (dirty && !runner.busy) void save();
      }}
    >
      {error !== null && (
        <p id={`${idBase}-error`} className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <label className="field-label" htmlFor={`${idBase}-notes`}>
        {uiMessage('alignment.project-detail.771')}
      </label>
      <textarea
        id={`${idBase}-notes`}
        rows={6}
        value={draft}
        aria-invalid={error !== null}
        aria-describedby={described}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p id={`${idBase}-count`} className="field-help">
        {uiMessage('alignment.project-detail.772', {
          value0: draft.length.toLocaleString(),
          value1: limit.toLocaleString(),
        })}
      </p>
      <div className="detail-section-actions">
        {/* Stays focusable after saving, so focus does not jump away from the notes. */}
        <button type="submit" aria-disabled={runner.busy || !dirty}>
          {runner.busy
            ? uiMessage('account.conflicts-page.133')
            : uiMessage('alignment.project-detail.773')}
        </button>
      </div>
      <CommandFeedback runner={runner} />
      {dialog}
    </form>
  );
}

/** Capture's own undo belongs to the Action facade; the new Action can be archived from its page. */
function withoutUndo(result: ApplicationResult<CommandReceipt>): ApplicationResult<CommandReceipt> {
  return result.ok ? { ok: true, value: { ...result.value, undo: { available: false } } } : result;
}

/** Capture an Action that belongs to this Project. Without a date it waits in the Inbox. */
function AddActionDialog({
  onClose,
  open,
  project,
  runner,
}: {
  readonly open: boolean;
  readonly project: ProjectData;
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
      eyebrow={project.title}
      title={uiMessage('alignment.project-detail.774')}
      description={uiMessage('alignment.project-detail.775')}
      onClose={close}
    >
      {open && (
        <AddActionForm project={project} runner={runner} onCancel={close} onDone={onClose} />
      )}
    </Modal>
  );
}

function AddActionForm({
  onCancel,
  onDone,
  project,
  runner,
}: {
  readonly project: ProjectData;
  readonly runner: CommandRunner;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const actions = useActionsApplication();
  // One capture intent per dialog, so a retried submit keeps the same command id.
  const [intent] = useState(() => actions.newCaptureIntent('project'));
  const idBase = useId();
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<boolean> => {
    const value = title.trim();
    if (value === '') {
      setError(uiMessage('alignment.project-detail.776'));
      field.current?.focus();
      return false;
    }
    setError(null);
    const saved = await runner.run(
      async () =>
        withoutUndo(await actions.capture(intent, { title: value, projectId: project.id })),
      uiMessage('alignment.project-detail.777'),
    );
    if (saved) onDone();
    return saved;
  };
  const { dialog } = useUnsavedGuard(title.trim() !== '', submit);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error !== null && (
        <p id={`${idBase}-error`} className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <DialogError runner={runner} />
      <label className="field-label" htmlFor={`${idBase}-title`}>
        {uiMessage('alignment.object-forms.649')}
        <input
          id={`${idBase}-title`}
          ref={field}
          value={title}
          required
          aria-invalid={error !== null}
          {...(error === null ? {} : { 'aria-describedby': `${idBase}-error` })}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button type="submit" className="primary-button" disabled={runner.busy}>
          {runner.busy
            ? uiMessage('account.conflicts-page.133')
            : uiMessage('alignment.project-detail.778')}
        </button>
      </div>
      {dialog}
    </form>
  );
}
