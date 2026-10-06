import { message as uiMessage } from '../messages';
/**
 * `/axis/:axisId`: one Axis with its purpose, current Outcomes and Projects (finished ones on
 * request), Routines, its most recent review note, history, and every manual action:
 * edit, add, reorder, archive or restore, center in the alignment map, and permanent deletion.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { AxisDetail, AxisReviewNote } from '@yelaxis/application';

import { Modal } from '../plan/modal';
import {
  CommandFeedback,
  useAlignment,
  useCommandRunner,
  usePlanning,
  usePlanningToday,
} from '../plan/planning-context';
import { emptyRoutineForm, RoutineForm, runCommand } from '../plan/routine-form';
import {
  alignmentPath,
  axisOverviewPath,
  outcomePath,
  projectPath,
  reviewPeriodPath,
  routinePath,
} from '../plan/routes';
import { HorizonSection } from '../plan/theme-editor';
import { useFocusRescue } from '../plan/timeline';
import { periodRange } from '../review/review-text';
import {
  BoundedNote,
  FactList,
  HistoryList,
  MemberCounts,
  ObjectHeader,
  ObjectPage,
  OutcomeRows,
  ProjectRows,
  StatusPill,
  undoIdOf,
  useNoticeNavigate,
} from './kit';
import { AxisIcon } from './axis-icon';
import { axisIconLabel } from './axis-icons';
import { axisColorLabel, stateLabel } from './labels';
import { ArchivedNotice, ArchiveDialog, DangerZone } from './lifecycle-dialogs';
import { AxisFormDialog, OutcomeFormDialog, ProjectFormDialog } from './object-forms';

export function AxisDetailPage(): ReactNode {
  const alignment = useAlignment();
  const { axisId = '' } = useParams();
  // "Show finished" belongs to one Axis; opening another starts with current members only.
  const [finished, setFinished] = useState({ axisId, include: false });
  const includeFinished = finished.axisId === axisId && finished.include;
  return (
    <ObjectPage
      kind="axis"
      id={axisId}
      load={(id) => alignment.getAxis(id, { includeFinished })}
      deps={[includeFinished]}
    >
      {(detail) => (
        <AxisDetailView
          detail={detail}
          includeFinished={includeFinished}
          onIncludeFinished={(include) => setFinished({ axisId, include })}
        />
      )}
    </ObjectPage>
  );
}

type AxisDialog = 'edit' | 'outcome' | 'project' | 'routine' | 'archive' | null;

function AxisDetailView({
  detail,
  includeFinished,
  onIncludeFinished,
}: {
  readonly detail: AxisDetail;
  readonly includeFinished: boolean;
  readonly onIncludeFinished: (value: boolean) => void;
}): ReactNode {
  const planning = usePlanning();
  const today = usePlanningToday();
  const runner = useCommandRunner();
  const noticeNavigate = useNoticeNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [dialog, setDialog] = useState<AxisDialog>(null);
  useFocusRescue(heading, runner, detail);
  const { axis } = detail;
  const archived = axis.state === 'archived';
  const target = {
    kind: 'axis' as const,
    id: axis.id,
    revision: axis.localRevision,
    title: axis.title,
  };
  const close = (): void => setDialog(null);
  return (
    <section
      className="content-section alignment-page axis-detail"
      aria-labelledby={titleId}
      aria-busy={runner.busy}
    >
      <ObjectHeader
        kind="axis"
        state={axis.state}
        title={axis.title}
        titleId={titleId}
        headingRef={heading}
        back={{ to: axisOverviewPath, label: uiMessage('alignment.alignment-page.384') }}
      />
      {archived && <ArchivedNotice target={target} runner={runner} />}
      <FactList
        items={[
          {
            term: uiMessage('alignment.axis-detail.413'),
            value: axis.purpose ?? uiMessage('alignment.axis-detail.414'),
          },
          {
            term: uiMessage('alignment.axis-detail.415'),
            value: (
              <>
                <span
                  className="axis-swatch"
                  data-color={axis.color ?? 'none'}
                  aria-hidden="true"
                />
                {axisColorLabel(axis.color)}
              </>
            ),
          },
          {
            term: uiMessage('alignment.axis-detail.416'),
            value: (
              <span className="axis-icon-fact">
                <AxisIcon icon={axis.icon} title={axis.title} size="large" />
                {axisIconLabel(axis.icon)}
              </span>
            ),
          },
          {
            term: uiMessage('alignment.axis-detail.417'),
            value: <MemberCounts counts={axis.counts} />,
          },
        ]}
      />
      <div className="detail-actions">
        {!archived && (
          <>
            <button type="button" onClick={() => setDialog('edit')}>
              {uiMessage('alignment.axis-detail.418')}
            </button>
            <button type="button" onClick={() => setDialog('outcome')}>
              {uiMessage('alignment.axis-detail.419')}
            </button>
            <button type="button" onClick={() => setDialog('project')}>
              {uiMessage('alignment.axis-detail.420')}
            </button>
            <button type="button" onClick={() => setDialog('routine')}>
              {uiMessage('alignment.axis-detail.421')}
            </button>
          </>
        )}
        <Link className="inline-button" to={alignmentPath({ kind: 'axis', id: axis.id })}>
          {uiMessage('alignment.axis-detail.422')}
        </Link>
        {!archived && (
          <button type="button" onClick={() => setDialog('archive')}>
            {uiMessage('alignment.axis-detail.423')}
          </button>
        )}
      </div>
      <CommandFeedback runner={runner} />
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={includeFinished}
          onChange={(event) => onIncludeFinished(event.target.checked)}
        />
        {uiMessage('alignment.axis-detail.424')}
      </label>
      <HorizonSection
        title={uiMessage('alignment.axis-detail.425')}
        help={
          includeFinished
            ? uiMessage('alignment.axis-detail.426')
            : uiMessage('alignment.axis-detail.427')
        }
      >
        <OutcomeRows
          items={detail.outcomes.items}
          label={uiMessage('alignment.axis-detail.428', { value0: axis.title })}
          emptyText={uiMessage('alignment.axis-detail.2402')}
          runner={runner}
          {...(archived ? {} : { scope: { container: 'axis_outcomes', axisId: axis.id } as const })}
        />
        <BoundedNote
          shown={detail.outcomes.items.length}
          total={detail.outcomes.total}
          noun={uiMessage('alignment.axis-detail.425')}
        />
      </HorizonSection>
      <HorizonSection
        title={uiMessage('alignment.axis-detail.429')}
        help={
          includeFinished
            ? uiMessage('alignment.axis-detail.430')
            : uiMessage('alignment.axis-detail.431')
        }
      >
        <ProjectRows
          items={detail.projects.items}
          label={uiMessage('alignment.axis-detail.432', { value0: axis.title })}
          emptyText={uiMessage('alignment.axis-detail.2403')}
          runner={runner}
          {...(archived ? {} : { scope: { container: 'axis_projects', axisId: axis.id } as const })}
        />
        <BoundedNote
          shown={detail.projects.items.length}
          total={detail.projects.total}
          noun={uiMessage('alignment.axis-detail.429')}
        />
      </HorizonSection>
      <HorizonSection title={uiMessage('alignment.axis-detail.433')}>
        {detail.routines.items.length === 0 ? (
          <p className="quiet-empty">{uiMessage('alignment.axis-detail.434')}</p>
        ) : (
          <ul
            className="alignment-list"
            aria-label={uiMessage('alignment.axis-detail.435', { value0: axis.title })}
          >
            {detail.routines.items.map((routine) => (
              <li key={routine.id} className="alignment-row">
                <div className="alignment-row-main">
                  <p className="alignment-row-title">
                    <Link to={routinePath(routine.id)}>{routine.title}</Link>
                    <StatusPill label={stateLabel('routine', routine.state)} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <BoundedNote
          shown={detail.routines.items.length}
          total={detail.routines.total}
          noun={uiMessage('alignment.axis-detail.433')}
        />
      </HorizonSection>
      <HorizonSection title={uiMessage('alignment.axis-detail.436')}>
        {detail.reviewNote === null ? (
          <p className="quiet-empty">{uiMessage('alignment.axis-detail.437')}</p>
        ) : (
          <RecentReviewNote note={detail.reviewNote} today={today} />
        )}
      </HorizonSection>
      <HistoryList entries={detail.history} />
      <DangerZone target={target} parentPath={axisOverviewPath} runner={runner} />

      <AxisFormDialog
        open={dialog === 'edit'}
        mode="edit"
        initial={axis}
        runner={runner}
        onClose={close}
      />
      <OutcomeFormDialog
        open={dialog === 'outcome'}
        mode="create"
        preset={{ axisId: axis.id }}
        runner={runner}
        onClose={close}
        onSaved={(id, receipt) =>
          noticeNavigate(outcomePath(id), uiMessage('alignment.axis-detail.438'), undoIdOf(receipt))
        }
      />
      <ProjectFormDialog
        open={dialog === 'project'}
        mode="create"
        preset={{ axisId: axis.id }}
        runner={runner}
        onClose={close}
        onSaved={(id, receipt) =>
          noticeNavigate(projectPath(id), uiMessage('alignment.axis-detail.439'), undoIdOf(receipt))
        }
      />
      <ArchiveDialog open={dialog === 'archive'} target={target} runner={runner} onClose={close} />
      <Modal
        open={dialog === 'routine'}
        eyebrow={axis.title}
        title={uiMessage('alignment.axis-detail.440')}
        onClose={close}
      >
        <RoutineForm
          initial={emptyRoutineForm(today)}
          planning={planning}
          submitLabel={uiMessage('actions-ui.222')}
          onCancel={close}
          onSubmit={async (input) => {
            const result = await runCommand(
              runner,
              () => planning.createRoutine({ ...input, axisId: axis.id }),
              uiMessage('actions-ui.213'),
            );
            if (result.message === null) close();
            return result.message;
          }}
        />
      </Modal>
    </section>
  );
}

/** The most recent note written for this Axis in a finished review, with where it came from. */
function RecentReviewNote({
  note,
  today,
}: {
  readonly note: AxisReviewNote;
  readonly today: string;
}): ReactNode {
  return (
    <figure className="review-recent-note">
      <blockquote>{note.text}</blockquote>
      <figcaption>
        {uiMessage('alignment.axis-detail.441', {
          value0: note.reviewType,
          value1: periodRange(note.period, today),
        })}
        {' · '}
        <Link to={reviewPeriodPath(note.reviewType, note.period.key)}>
          {uiMessage('alignment.axis-detail.442')}
        </Link>
      </figcaption>
    </figure>
  );
}
