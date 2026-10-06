import { message as uiMessage } from '../messages';
/**
 * `/outcomes/:outcomeId`: one Outcome with its success definition, Axis, target window, placement,
 * progress, ordered Milestones, primary and supporting Projects, and history, plus every manual
 * action: edit, state changes, placement, links, archive or restore, and permanent deletion.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import type {
  AlignmentEdge,
  AlignmentNode,
  AlignmentRelationship,
  OutcomeDetail,
  OutcomeItem,
  RevisionRef,
} from '@yelaxis/application';
import type { OutcomeState } from '@yelaxis/domain';

import { formatPeriod } from '../plan/format';
import {
  useAlignment,
  useCommandRunner,
  usePlanning,
  type CommandRunner,
} from '../plan/planning-context';
import { axisOverviewPath, axisPath, projectPath } from '../plan/routes';
import { HorizonSection, targetWindowText } from '../plan/theme-editor';
import { useFocusRescue, ViewFeedback } from '../plan/timeline';
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
  undoIdOf,
  useNoticeNavigate,
} from './kit';
import { ArchivedNotice, ArchiveDialog, DangerZone } from './lifecycle-dialogs';
import { LinkDialog, UnlinkDialog } from './link-dialogs';
import {
  MilestoneFormDialog,
  OutcomeFormDialog,
  ProgressEditor,
  ProjectFormDialog,
} from './object-forms';

interface StateChange {
  readonly to: Exclude<OutcomeState, 'archived'>;
  readonly label: string;
  readonly done: string;
}

const abandonDone = uiMessage('alignment.outcome-detail.706');

/** The manual state changes offered from each state (state-machines.md). */
const stateChanges: Readonly<Record<OutcomeState, readonly StateChange[]>> = {
  active: [
    {
      to: 'paused',
      label: uiMessage('alignment.outcome-detail.707'),
      done: uiMessage('alignment.outcome-detail.708'),
    },
    {
      to: 'achieved',
      label: uiMessage('alignment.outcome-detail.709'),
      done: uiMessage('alignment.outcome-detail.710'),
    },
    { to: 'abandoned', label: uiMessage('alignment.outcome-detail.711'), done: abandonDone },
  ],
  paused: [
    {
      to: 'active',
      label: uiMessage('alignment.outcome-detail.712'),
      done: uiMessage('alignment.outcome-detail.713'),
    },
    {
      to: 'achieved',
      label: uiMessage('alignment.outcome-detail.709'),
      done: uiMessage('alignment.outcome-detail.710'),
    },
    { to: 'abandoned', label: uiMessage('alignment.outcome-detail.711'), done: abandonDone },
  ],
  achieved: [
    {
      to: 'active',
      label: uiMessage('alignment.outcome-detail.714'),
      done: uiMessage('alignment.outcome-detail.715'),
    },
  ],
  abandoned: [
    {
      to: 'active',
      label: uiMessage('alignment.outcome-detail.714'),
      done: uiMessage('alignment.outcome-detail.715'),
    },
  ],
  archived: [],
};

const projectRelationships: readonly AlignmentRelationship[] = [
  'outcome_primary_project',
  'outcome_secondary_project',
];

type Dialog =
  'edit' | 'place' | 'archive' | 'add-milestone' | 'add-project' | 'link' | 'unlink' | null;

export function OutcomeDetailPage(): ReactNode {
  const alignment = useAlignment();
  const { outcomeId = '' } = useParams();
  return (
    <ObjectPage kind="outcome" id={outcomeId} load={(id) => alignment.getOutcome(id)}>
      {(detail) => <OutcomeView detail={detail} />}
    </ObjectPage>
  );
}

function OutcomeView({ detail }: { readonly detail: OutcomeDetail }): ReactNode {
  const alignment = useAlignment();
  const planning = usePlanning();
  const runner = useCommandRunner();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusRescue(heading, runner, detail);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [unlinkEdge, setUnlinkEdge] = useState<AlignmentEdge | null>(null);
  const { outcome } = detail;
  const archived = outcome.state === 'archived';
  const busy = runner.busy;
  const ref: RevisionRef<'outcome'> = {
    kind: 'outcome',
    id: outcome.id,
    revision: outcome.localRevision,
  };
  const target = lifecycleTarget('outcome', outcome);
  const focus = alignmentNode('outcome', outcome);
  const parent =
    outcome.axis === undefined
      ? { to: axisOverviewPath, label: uiMessage('alignment.alignment-page.384') }
      : { to: axisPath(outcome.axis.id), label: outcome.axis.title };
  const close = (): void => {
    runner.clearError();
    setDialog(null);
  };
  const unlink = (edge: AlignmentEdge): void => {
    setUnlinkEdge(edge);
    setDialog('unlink');
  };

  const milestones = detail.milestones.items;
  const lastMilestone = milestones.length - 1;
  const milestoneRows: readonly DetailRow[] = milestones.map((milestone, index) => ({
    key: milestone.id,
    kind: 'milestone',
    node: alignmentNode('milestone', milestone),
    facts: [
      targetWindowText(milestone.targetStart, milestone.targetEnd),
      ...(milestone.placement === undefined
        ? []
        : [
            uiMessage('alignment.outcome-detail.716', {
              value0: formatPeriod(milestone.placement.period),
            }),
          ]),
    ],
    ...(archived
      ? {}
      : {
          controls: (
            <MoveButtons
              itemLabel={milestone.title}
              isFirst={index === 0}
              isLast={index === lastMilestone && milestones.length === detail.milestones.total}
              disabled={busy}
              onMove={(direction) =>
                void runner.run(
                  () =>
                    alignment.reorder({
                      target: {
                        kind: 'milestone',
                        id: milestone.id,
                        revision: milestone.localRevision,
                      },
                      direction,
                      scope: { container: 'outcome_milestones', outcomeId: outcome.id },
                    }),
                  uiMessage('alignment.outcome-detail.717', {
                    value0: milestone.title,
                    value1: direction,
                  }),
                )
              }
            />
          ),
        }),
  }));

  const primaryRows: readonly DetailRow[] = detail.primaryProjects.items.map((project) => {
    const node = alignmentNode('project', project);
    return {
      key: project.id,
      kind: 'project',
      node,
      facts: [
        targetWindowText(project.targetStart, project.targetEnd),
        ...(project.nextAction.status === 'missing'
          ? [uiMessage('alignment.outcome-detail.718')]
          : []),
      ],
      ...(archived
        ? {}
        : {
            controls: (
              <UnlinkButton
                title={project.title}
                disabled={busy}
                onClick={() => unlink(edgeTo('outcome_primary_project', 'down', node))}
              />
            ),
          }),
    };
  });

  const supportingRows: readonly DetailRow[] = detail.supportingProjects.items.map((project) => ({
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
                  edgeTo(
                    'outcome_secondary_project',
                    'down',
                    alignmentNode('project', project),
                    project,
                  ),
                )
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
        kind="outcome"
        state={outcome.state}
        title={outcome.title}
        titleId={titleId}
        headingRef={heading}
        back={parent}
      />
      {archived && <ArchivedNotice target={target} runner={runner} />}
      {outcome.state === 'abandoned' && (
        <p className="quiet-empty">{uiMessage('alignment.outcome-detail.719')}</p>
      )}
      <FactList
        items={[
          { term: uiMessage('alignment.outcome-detail.720'), value: outcome.successDefinition },
          {
            term: uiMessage('actions-ui.251'),
            value:
              outcome.axis === undefined ? (
                uiMessage('alignment.alignment-page.385')
              ) : (
                <NodeLink kind="axis" node={outcome.axis} />
              ),
          },
          {
            term: uiMessage('alignment.milestone-detail.606'),
            value: targetWindowText(outcome.targetStart, outcome.targetEnd),
          },
          {
            term: uiMessage('alignment.milestone-detail.608'),
            value: <PlacementFact placement={outcome.placement} />,
          },
        ]}
      />
      {!archived && (
        <div
          className="detail-actions"
          role="group"
          aria-label={uiMessage('alignment.outcome-detail.721')}
        >
          <CommandButton busy={busy} onClick={() => setDialog('edit')}>
            {uiMessage('alignment.axis-detail.418')}
          </CommandButton>
          {stateChanges[outcome.state].map((change) => (
            <CommandButton
              key={change.to}
              busy={busy}
              onClick={() =>
                void runner.run(() => alignment.transitionOutcome(ref, change.to), change.done)
              }
            >
              {change.label}
            </CommandButton>
          ))}
          <CommandButton busy={busy} onClick={() => setDialog('place')}>
            {uiMessage('alignment.outcome-detail.722')}
          </CommandButton>
          {outcome.placement !== undefined && (
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

      <ProgressEditor outcome={outcome} runner={runner} />

      <HorizonSection title={uiMessage('actions-ui.314')}>
        <DetailList
          ordered
          label={uiMessage('alignment.outcome-detail.723', { value0: outcome.title })}
          empty={uiMessage('alignment.outcome-detail.724')}
          rows={milestoneRows}
        />
        <BoundedNote
          shown={milestones.length}
          total={detail.milestones.total}
          noun={uiMessage('alignment.outcome-detail.2409')}
        />
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => setDialog('add-milestone')}>
              {uiMessage('alignment.outcome-detail.725')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HorizonSection title={uiMessage('alignment.axis-detail.429')}>
        <div className="alignment-subsection">
          <h3>{uiMessage('alignment.outcome-detail.726')}</h3>
          <DetailList
            label={uiMessage('alignment.outcome-detail.727', { value0: outcome.title })}
            empty={uiMessage('alignment.outcome-detail.728')}
            rows={primaryRows}
          />
          <BoundedNote
            shown={detail.primaryProjects.items.length}
            total={detail.primaryProjects.total}
            noun={uiMessage('alignment.axis-detail.429')}
          />
        </div>
        <div className="alignment-subsection">
          <h3>{uiMessage('alignment.outcome-detail.729')}</h3>
          <DetailList
            label={uiMessage('alignment.outcome-detail.730', { value0: outcome.title })}
            empty={uiMessage('alignment.outcome-detail.731')}
            rows={supportingRows}
          />
          <BoundedNote
            shown={detail.supportingProjects.items.length}
            total={detail.supportingProjects.total}
            noun={uiMessage('alignment.axis-detail.429')}
          />
        </div>
        {!archived && (
          <div className="detail-section-actions">
            <CommandButton busy={busy} onClick={() => setDialog('add-project')}>
              {uiMessage('alignment.outcome-detail.732')}
            </CommandButton>
            <CommandButton busy={busy} onClick={() => setDialog('link')}>
              {uiMessage('alignment.milestone-detail.621')}
            </CommandButton>
          </div>
        )}
      </HorizonSection>

      <HistoryList entries={detail.history} />
      <DangerZone target={target} parentPath={parent.to} runner={runner} />

      <OutcomeDialogs
        dialog={dialog}
        focus={focus}
        outcome={outcome}
        runner={runner}
        unlinkEdge={unlinkEdge}
        onClose={close}
      />
    </section>
  );
}

/** Every dialog stays mounted, so the shared Modal returns focus to the control that opened it. */
function OutcomeDialogs({
  dialog,
  focus,
  onClose,
  outcome,
  runner,
  unlinkEdge,
}: {
  readonly dialog: Dialog;
  readonly focus: AlignmentNode;
  readonly outcome: OutcomeItem;
  readonly runner: CommandRunner;
  readonly unlinkEdge: AlignmentEdge | null;
  readonly onClose: () => void;
}): ReactNode {
  const noticeNavigate = useNoticeNavigate();
  return (
    <>
      <OutcomeFormDialog
        open={dialog === 'edit'}
        mode="edit"
        initial={outcome}
        runner={runner}
        onClose={onClose}
      />
      <MilestoneFormDialog
        open={dialog === 'add-milestone'}
        mode="create"
        preset={{ outcomeId: outcome.id, outcomeTitle: outcome.title }}
        runner={runner}
        onClose={onClose}
      />
      <ProjectFormDialog
        open={dialog === 'add-project'}
        mode="create"
        preset={{
          primaryOutcomeId: outcome.id,
          ...(outcome.axis === undefined ? {} : { axisId: outcome.axis.id }),
        }}
        runner={runner}
        onClose={onClose}
        onSaved={(id, receipt) =>
          noticeNavigate(projectPath(id), uiMessage('alignment.axis-detail.439'), undoIdOf(receipt))
        }
      />
      <PlacementDialog
        open={dialog === 'place'}
        allowed={['year', 'month']}
        current={outcome.placement?.period}
        target={{ kind: 'outcome', id: outcome.id, revision: outcome.localRevision }}
        title={outcome.title}
        runner={runner}
        onClose={onClose}
      />
      <ArchiveDialog
        open={dialog === 'archive'}
        target={lifecycleTarget('outcome', outcome)}
        runner={runner}
        onClose={onClose}
      />
      <LinkDialog
        open={dialog === 'link'}
        focus={focus}
        relationships={projectRelationships}
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
