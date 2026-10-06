import { message as uiMessage } from '../messages';
/**
 * `/axis`: every Axis in its persisted order with neutral member counts, keyboard reordering,
 * archived Axes on request (`?archived=1`), and the Outcomes and Projects that are not in an Axis.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { AxisSummary, Bounded, UnassignedView } from '@yelaxis/application';

import {
  CommandFeedback,
  useAlignment,
  useCommandRunner,
  usePlanQuery,
  type CommandRunner,
} from '../plan/planning-context';
import { alignmentPath, axisPath, outcomePath, projectPath } from '../plan/routes';
import { HorizonSection } from '../plan/theme-editor';
import { useFocusRescue } from '../plan/timeline';
import {
  BoundedNote,
  MemberCounts,
  MoveButtons,
  OutcomeRows,
  ProjectRows,
  StatusPill,
  undoIdOf,
  useNoticeNavigate,
} from './kit';
import { AxisIcon } from './axis-icon';
import { AxisFormDialog, OutcomeFormDialog, ProjectFormDialog } from './object-forms';

type OverviewDialog = 'axis' | 'outcome' | 'project' | null;

interface OverviewData {
  readonly axes: Bounded<AxisSummary>;
  readonly unassigned: UnassignedView;
}

export function AxisOverviewPage(): ReactNode {
  const alignment = useAlignment();
  const runner = useCommandRunner();
  const noticeNavigate = useNoticeNavigate();
  const [params, setParams] = useSearchParams();
  const showArchived = params.get('archived') === '1';
  const [dialog, setDialog] = useState<OverviewDialog>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const { state, reload } = usePlanQuery<OverviewData>(async () => {
    const axes = await alignment.listAxes({ includeArchived: showArchived });
    const unassigned = await alignment.listUnassigned();
    return { axes, unassigned };
  }, [alignment, showArchived]);
  useFocusRescue(heading, runner, state.status === 'ready' ? state.data : null);
  return (
    <section
      className="content-section alignment-page axis-overview"
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading' || runner.busy}
    >
      <p className="eyebrow">{uiMessage('actions-ui.251')}</p>
      <h1 id={titleId} ref={heading} tabIndex={-1}>
        {uiMessage('alignment.alignment-page.384')}
      </h1>
      <p className="page-message">{uiMessage('alignment.axis-overview.445')}</p>
      <div className="alignment-toolbar">
        <button className="primary-button" type="button" onClick={() => setDialog('axis')}>
          {uiMessage('alignment.axis-overview.446')}
        </button>
        <Link className="inline-button" to={alignmentPath()}>
          {uiMessage('alignment.axis-overview.447')}
        </Link>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) =>
              setParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (event.target.checked) next.set('archived', '1');
                  else next.delete('archived');
                  return next;
                },
                { replace: true },
              )
            }
          />
          {uiMessage('alignment.axis-overview.448')}
        </label>
      </div>
      <CommandFeedback runner={runner} />
      {state.status === 'loading' && (
        <p className="page-message">{uiMessage('alignment.axis-overview.449')}</p>
      )}
      {state.status === 'error' && (
        <div className="horizon-error">
          <p className="validation-summary" role="alert">
            {state.message}
          </p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <AxisRows axes={state.data.axes} runner={runner} />
          <UnassignedSection
            unassigned={state.data.unassigned}
            runner={runner}
            onAddOutcome={() => setDialog('outcome')}
            onAddProject={() => setDialog('project')}
          />
        </>
      )}
      <AxisFormDialog
        open={dialog === 'axis'}
        mode="create"
        runner={runner}
        onClose={() => setDialog(null)}
        onSaved={(id, receipt) =>
          noticeNavigate(axisPath(id), uiMessage('alignment.axis-overview.450'), undoIdOf(receipt))
        }
      />
      <OutcomeFormDialog
        open={dialog === 'outcome'}
        mode="create"
        runner={runner}
        onClose={() => setDialog(null)}
        onSaved={(id, receipt) =>
          noticeNavigate(outcomePath(id), uiMessage('alignment.axis-detail.438'), undoIdOf(receipt))
        }
      />
      <ProjectFormDialog
        open={dialog === 'project'}
        mode="create"
        runner={runner}
        onClose={() => setDialog(null)}
        onSaved={(id, receipt) =>
          noticeNavigate(projectPath(id), uiMessage('alignment.axis-detail.439'), undoIdOf(receipt))
        }
      />
    </section>
  );
}

function AxisRows({
  axes,
  runner,
}: {
  readonly axes: Bounded<AxisSummary>;
  readonly runner: CommandRunner;
}): ReactNode {
  const alignment = useAlignment();
  if (axes.items.length === 0) {
    return (
      <div className="quiet-empty">
        <p>{uiMessage('alignment.alignment-page.382')}</p>
        <p>{uiMessage('alignment.axis-overview.451')}</p>
      </div>
    );
  }
  const active = axes.items.filter((axis) => axis.state === 'active');
  const move = (axis: AxisSummary, direction: 'up' | 'down'): void => {
    if (runner.busy) return;
    void runner.run(
      () =>
        alignment.reorder({
          target: { kind: 'axis', id: axis.id, revision: axis.localRevision },
          direction,
          scope: { container: 'axes' },
        }),
      uiMessage('alignment.axis-overview.452', { value0: axis.title, value1: direction }),
    );
  };
  return (
    <>
      <ol className="alignment-list" aria-label={uiMessage('alignment.alignment-page.384')}>
        {axes.items.map((axis) => {
          const position = active.indexOf(axis);
          return (
            <li key={axis.id} className="alignment-row">
              <span className="axis-swatch" data-color={axis.color ?? 'none'} aria-hidden="true" />
              <div className="alignment-row-main">
                <p className="alignment-row-title">
                  <AxisIcon icon={axis.icon} title={axis.title} />
                  <Link to={axisPath(axis.id)}>{axis.title}</Link>
                  {axis.state === 'archived' && (
                    <StatusPill label={uiMessage('alignment.alignment-page.405')} />
                  )}
                </p>
                {axis.purpose !== undefined && <p className="alignment-row-text">{axis.purpose}</p>}
                <p className="alignment-row-meta">
                  <MemberCounts counts={axis.counts} />
                </p>
              </div>
              {position >= 0 && (
                <MoveButtons
                  itemLabel={axis.title}
                  isFirst={position === 0}
                  isLast={position === active.length - 1}
                  disabled={runner.busy}
                  onMove={(direction) => move(axis, direction)}
                />
              )}
            </li>
          );
        })}
      </ol>
      <BoundedNote
        shown={axes.items.length}
        total={axes.total}
        noun={uiMessage('alignment.alignment-page.384')}
      />
    </>
  );
}

function UnassignedSection({
  onAddOutcome,
  onAddProject,
  runner,
  unassigned,
}: {
  readonly unassigned: UnassignedView;
  readonly runner: CommandRunner;
  readonly onAddOutcome: () => void;
  readonly onAddProject: () => void;
}): ReactNode {
  const outcomesId = useId();
  const projectsId = useId();
  const empty = unassigned.outcomes.total === 0 && unassigned.projects.total === 0;
  return (
    <HorizonSection
      title={uiMessage('alignment.alignment-page.385')}
      help={uiMessage('alignment.axis-overview.453')}
    >
      <div className="alignment-toolbar">
        <button type="button" onClick={onAddOutcome}>
          {uiMessage('alignment.axis-detail.419')}
        </button>
        <button type="button" onClick={onAddProject}>
          {uiMessage('alignment.axis-detail.420')}
        </button>
      </div>
      {empty ? (
        <p className="quiet-empty">{uiMessage('alignment.axis-overview.454')}</p>
      ) : (
        <div className="horizon-columns">
          <section className="alignment-subsection" aria-labelledby={outcomesId}>
            <h3 id={outcomesId}>{uiMessage('alignment.axis-detail.425')}</h3>
            <OutcomeRows
              items={unassigned.outcomes.items}
              label={uiMessage('alignment.axis-overview.455')}
              emptyText={uiMessage('alignment.axis-overview.2404')}
              runner={runner}
              scope={{ container: 'axis_outcomes', axisId: null }}
            />
            <BoundedNote
              shown={unassigned.outcomes.items.length}
              total={unassigned.outcomes.total}
              noun={uiMessage('alignment.axis-detail.425')}
            />
          </section>
          <section className="alignment-subsection" aria-labelledby={projectsId}>
            <h3 id={projectsId}>{uiMessage('alignment.axis-detail.429')}</h3>
            <ProjectRows
              items={unassigned.projects.items}
              label={uiMessage('alignment.axis-overview.456')}
              emptyText={uiMessage('alignment.axis-overview.2405')}
              runner={runner}
              scope={{ container: 'axis_projects', axisId: null }}
            />
            <BoundedNote
              shown={unassigned.projects.items.length}
              total={unassigned.projects.total}
              noun={uiMessage('alignment.axis-detail.429')}
            />
          </section>
        </div>
      )}
    </HorizonSection>
  );
}
