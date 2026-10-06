import { message as uiMessage } from '../messages';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type {
  AlignmentEdge,
  AlignmentNeighborhood,
  AlignmentNode,
  AxisSummary,
  OutcomeProgressView,
} from '@yelaxis/application';

import {
  useAlignment,
  useCommandRunner,
  usePlanQuery,
  type CommandRunner,
} from '../plan/planning-context';
import { alignmentPath, axisOverviewPath } from '../plan/routes';
import { targetWindowText } from '../plan/theme-editor';
import { useFocusRescue, ViewFeedback } from '../plan/timeline';
import { AlignmentMap } from './alignment-map';
import { kindLabel, relationshipLabel } from './labels';
import {
  LinkDialog,
  ReparentMilestoneDialog,
  UnlinkDialog,
  type ReparentMilestoneDialogProps,
} from './link-dialogs';
import {
  countText,
  neighborhoodSummary,
  nodePath,
  parseAlignmentFocus,
  stateText,
  type AlignmentFocusRef,
  type AlignmentOperationId,
} from './operations';
import { nodeKey, RelationshipList, type AlignmentViewProps } from './relationship-list';

import './alignment-map.css';

type AlignmentView = 'list' | 'map';

/** Links loaded per relationship; "Show all" raises it to the hard cap of the query port. */
const defaultLimit = 50;
const maxLimit = 200;

/**
 * `/axis/alignment?focus=<kind>:<uuid>&view=list|map`: how one object connects above and below.
 * The relationship list is canonical and first; the map is an optional view with the same
 * operations. Centering only changes this view; it never changes a plan or a priority.
 */
export function AlignmentPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const titleId = useId();
  const focus = parseAlignmentFocus(params.get('focus'));
  const view: AlignmentView = params.get('view') === 'map' ? 'map' : 'list';
  const chooseView = (next: AlignmentView): void =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set('view', next);
        return updated;
      },
      { replace: true },
    );
  const center = (node: { readonly kind: string; readonly id: string }): void =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.set('focus', `${node.kind}:${node.id}`);
      return updated;
    });
  return (
    <section
      className="content-section alignment-page alignment-map-page"
      aria-labelledby={titleId}
    >
      <p className="eyebrow">{uiMessage('actions-ui.251')}</p>
      <h1 id={titleId}>{uiMessage('alignment.alignment-page.377')}</h1>
      <p className="page-message">{uiMessage('alignment.alignment-page.378')}</p>
      {focus === null ? (
        <AlignmentStart view={view} />
      ) : focus === 'invalid' ? (
        <UnavailableFocus />
      ) : (
        <FocusedAlignment focus={focus} view={view} onView={chooseView} onCenter={center} />
      )}
    </section>
  );
}

/* ───────────────────────── No focus: choose where to start ───────────────────────── */

function axisCounts(axis: AxisSummary): string {
  return [
    countText(axis.counts.outcomes, 'outcome'),
    countText(axis.counts.projects, 'project'),
    countText(axis.counts.routines, 'routine'),
  ].join(' · ');
}

function AlignmentStart({ view }: { readonly view: AlignmentView }): ReactNode {
  const alignment = useAlignment();
  const headingId = useId();
  const { state, reload } = usePlanQuery(async () => {
    const axes = await alignment.listAxes();
    const unassigned = await alignment.listUnassigned();
    return { axes, unassigned };
  }, [alignment]);
  const viewParam = view === 'map' ? 'map' : undefined;
  return (
    <section className="alignment-start" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('alignment.alignment-page.379')}</h2>
      <p className="field-help">{uiMessage('alignment.alignment-page.380')}</p>
      {state.status === 'loading' ? (
        <p className="field-help" role="status">
          {uiMessage('alignment.alignment-page.381')}
        </p>
      ) : state.status === 'error' ? (
        <div className="horizon-error">
          <p role="alert">{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      ) : (
        <>
          {state.data.axes.items.length === 0 ? (
            <>
              <p className="quiet-empty">{uiMessage('alignment.alignment-page.382')}</p>
              <Link className="inline-button" to={axisOverviewPath}>
                {uiMessage('alignment.alignment-page.383')}
              </Link>
            </>
          ) : (
            <ul
              className="alignment-start-list"
              aria-label={uiMessage('alignment.alignment-page.384')}
            >
              {state.data.axes.items.map((axis) => (
                <li key={axis.id}>
                  <Link to={alignmentPath({ kind: 'axis', id: axis.id }, viewParam)}>
                    {axis.title}
                  </Link>
                  <span className="field-help">{axisCounts(axis)}</span>
                </li>
              ))}
            </ul>
          )}
          {state.data.unassigned.outcomes.items.length +
            state.data.unassigned.projects.items.length >
            0 && (
            <>
              <h3>{uiMessage('alignment.alignment-page.385')}</h3>
              <ul
                className="alignment-start-list"
                aria-label={uiMessage('alignment.alignment-page.385')}
              >
                {[
                  ...state.data.unassigned.outcomes.items.map((item) => ({
                    kind: 'outcome' as const,
                    id: item.id,
                    title: item.title,
                    state: item.state,
                  })),
                  ...state.data.unassigned.projects.items.map((item) => ({
                    kind: 'project' as const,
                    id: item.id,
                    title: item.title,
                    state: item.state,
                  })),
                ].map((item) => (
                  <li key={nodeKey(item)}>
                    <Link to={alignmentPath({ kind: item.kind, id: item.id }, viewParam)}>
                      {item.title}
                    </Link>
                    <span className="field-help">
                      {kindLabel(item.kind)} · {stateText(item.state)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function UnavailableFocus({ kind }: { readonly kind?: AlignmentFocusRef['kind'] }): ReactNode {
  return (
    <section
      className="alignment-unavailable"
      aria-label={uiMessage('alignment.alignment-page.386')}
    >
      <h2>
        {kind === undefined
          ? uiMessage('alignment.alignment-page.387')
          : uiMessage('alignment.alignment-page.388', { value0: kindLabel(kind) })}
      </h2>
      <p className="page-message">{uiMessage('alignment.alignment-page.389')}</p>
      <div className="detail-actions">
        <Link className="inline-button" to={alignmentPath()}>
          {uiMessage('alignment.alignment-page.379')}
        </Link>
        <Link className="inline-button" to={axisOverviewPath}>
          {uiMessage('alignment.alignment-page.390')}
        </Link>
      </div>
    </section>
  );
}

/* ───────────────────────── Focused neighborhood ───────────────────────── */

type ReparentTarget = ReparentMilestoneDialogProps['milestone'];

/** Open dialogs stay mounted after closing so the Modal can return focus to its opener. */
interface DialogState {
  readonly link: boolean;
  readonly unlink: { readonly edge: AlignmentEdge; readonly open: boolean } | null;
  readonly reparent: { readonly milestone: ReparentTarget; readonly open: boolean } | null;
}

const closedDialogs: DialogState = { link: false, unlink: null, reparent: null };

/** Outcome progress in words; a milestone count is never shown as a percentage. */
function progressText(progress: OutcomeProgressView): string {
  switch (progress.mode) {
    case 'none':
      return uiMessage('alignment.alignment-page.391');
    case 'manual':
      return uiMessage('alignment.alignment-page.392', { value0: String(progress.percentage) });
    case 'milestone_derived': {
      const canceled =
        progress.canceled === undefined || progress.canceled === 0
          ? ''
          : uiMessage('alignment.alignment-page.393', { value0: String(progress.canceled) });
      if (progress.total === 0)
        return uiMessage('alignment.alignment-page.394', { value0: canceled });
      return uiMessage('alignment.alignment-page.395', {
        value0: String(progress.completed),
        value1: String(progress.total),
        value2: progress.total === 1 ? '' : 's',
        value3: canceled,
      });
    }
  }
}

function findInspected(
  neighborhood: AlignmentNeighborhood,
  key: string,
): { readonly node: AlignmentNode; readonly edge?: AlignmentEdge } {
  const edge = [...neighborhood.above, ...neighborhood.below].find(
    (candidate) => nodeKey(candidate.other) === key,
  );
  return edge === undefined ? { node: neighborhood.focus } : { node: edge.other, edge };
}

function reparentTarget(neighborhood: AlignmentNeighborhood, edge: AlignmentEdge): ReparentTarget {
  const milestone = edge.direction === 'up' ? neighborhood.focus : edge.other;
  const outcome = edge.direction === 'up' ? edge.other : neighborhood.focus;
  return {
    kind: 'milestone',
    id: milestone.id,
    revision: milestone.localRevision,
    title: milestone.title,
    outcomeId: outcome.id,
  };
}

function FocusedAlignment({
  focus,
  onCenter,
  onView,
  view,
}: {
  readonly focus: AlignmentFocusRef;
  readonly view: AlignmentView;
  readonly onView: (view: AlignmentView) => void;
  readonly onCenter: (node: AlignmentNode) => void;
}): ReactNode {
  const alignment = useAlignment();
  const runner = useCommandRunner();
  const focusKey = nodeKey(focus);
  const [limits, setLimits] = useState<{ readonly key: string; readonly limit: number }>({
    key: focusKey,
    limit: defaultLimit,
  });
  const limit = limits.key === focusKey ? limits.limit : defaultLimit;
  const { state, reload } = usePlanQuery(
    () => alignment.getNeighborhood(focus, { limit }),
    [alignment, focusKey, limit],
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingHeadingFocus = useRef(false);
  const shownKey = useRef<string | null>(null);
  const summaryId = useId();
  const [inspection, setInspection] = useState<{ readonly focus: string; readonly node: string }>({
    focus: focusKey,
    node: focusKey,
  });
  const inspectedKey = inspection.focus === focusKey ? inspection.node : focusKey;
  const [dialogs, setDialogs] = useState<DialogState>(closedDialogs);
  const data = state.status === 'ready' ? state.data : null;
  useFocusRescue(heading, runner, data);

  // "Selected: …" takes focus after Center, and whenever a newly shown item (the first choice from
  // the picker, or Back/Forward) would otherwise leave focus on the page body.
  useEffect(() => {
    if (data === null) return;
    const shown = nodeKey(data.focus);
    const changed = shownKey.current !== shown;
    shownKey.current = shown;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (pendingHeadingFocus.current || (changed && lost)) {
      pendingHeadingFocus.current = false;
      heading.current?.focus();
    }
  }, [data]);

  if (state.status === 'loading') {
    return (
      <p className="page-message" role="status">
        {uiMessage('alignment.alignment-page.396')}
        {kindLabel(focus.kind)}…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="horizon-error">
        <p role="alert">{state.message}</p>
        <div className="detail-actions">
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
          <Link className="inline-button" to={axisOverviewPath}>
            {uiMessage('alignment.alignment-page.390')}
          </Link>
        </div>
      </div>
    );
  }
  const neighborhood = state.data;
  if (neighborhood === null) return <UnavailableFocus kind={focus.kind} />;

  const operate: AlignmentViewProps['onOperation'] = (
    operation: AlignmentOperationId,
    node,
    edge,
  ) => {
    switch (operation) {
      case 'inspect': {
        const key = nodeKey(node);
        setInspection({
          focus: focusKey,
          node: key === inspectedKey && key !== focusKey ? focusKey : key,
        });
        return;
      }
      case 'center':
        pendingHeadingFocus.current = true;
        onCenter(node);
        return;
      case 'link':
        setDialogs((current) => ({ ...current, link: true }));
        return;
      case 'unlink':
        if (edge !== undefined)
          setDialogs((current) => ({ ...current, unlink: { edge, open: true } }));
        return;
      case 'reparent':
        if (edge !== undefined)
          setDialogs((current) => ({
            ...current,
            reparent: { milestone: reparentTarget(neighborhood, edge), open: true },
          }));
        return;
      case 'open':
        return;
    }
  };
  const viewProps: AlignmentViewProps = {
    neighborhood,
    inspectedKey,
    onOperation: operate,
    summaryId,
    ...(limit < maxLimit
      ? {
          onShowAll: () => {
            // The list reloads in full; focus then returns to "Selected: …", not the page body.
            pendingHeadingFocus.current = true;
            setLimits({ key: focusKey, limit: maxLimit });
          },
        }
      : {}),
  };
  const focusNode = neighborhood.focus;
  const chain = neighborhood.chain.filter((node) => nodeKey(node) !== nodeKey(focusNode));
  return (
    <div className="alignment-layout" aria-busy={state.refreshing}>
      <div className="alignment-main">
        <ViewFeedback
          runner={runner}
          showError={
            !dialogs.link && dialogs.unlink?.open !== true && dialogs.reparent?.open !== true
          }
        />
        {chain.length > 0 && (
          <nav className="alignment-chain" aria-label={uiMessage('alignment.alignment-page.397')}>
            <ol>
              {chain.map((node) => (
                <li key={nodeKey(node)}>
                  <Link
                    to={alignmentPath(
                      { kind: node.kind, id: node.id },
                      view === 'map' ? 'map' : undefined,
                    )}
                  >
                    {kindLabel(node.kind)}: {node.title}
                  </Link>
                </li>
              ))}
              <li aria-current="location">
                {kindLabel(focusNode.kind)}: {focusNode.title}
              </li>
            </ol>
          </nav>
        )}
        <h2 ref={heading} tabIndex={-1} className="alignment-selected" aria-describedby={summaryId}>
          {uiMessage('alignment.alignment-page.398')}
          {kindLabel(focusNode.kind)} {focusNode.title}
        </h2>
        <p id={summaryId} className="alignment-summary" aria-live="polite">
          {neighborhoodSummary(neighborhood)}
        </p>
        {focusNode.archived && (
          <p className="quiet-empty">{uiMessage('alignment.alignment-page.399')}</p>
        )}
        <fieldset className="compact-fieldset alignment-view-choice">
          <legend>{uiMessage('alignment.alignment-page.400')}</legend>
          <div className="segmented-options">
            {(['list', 'map'] as const).map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="alignment-view"
                  value={option}
                  checked={view === option}
                  onChange={() => onView(option)}
                />
                <span>
                  {option === 'list'
                    ? uiMessage('alignment.alignment-page.401')
                    : uiMessage('alignment.alignment-page.402')}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {view === 'list' ? <RelationshipList {...viewProps} /> : <AlignmentMap {...viewProps} />}
      </div>
      <InspectPanel neighborhood={neighborhood} inspectedKey={inspectedKey} />
      <AlignmentDialogs
        dialogs={dialogs}
        focus={focusNode}
        runner={runner}
        setDialogs={setDialogs}
      />
    </div>
  );
}

function AlignmentDialogs({
  dialogs,
  focus,
  runner,
  setDialogs,
}: {
  readonly dialogs: DialogState;
  readonly focus: AlignmentNode;
  readonly runner: CommandRunner;
  readonly setDialogs: (update: (current: DialogState) => DialogState) => void;
}): ReactNode {
  return (
    <>
      <LinkDialog
        open={dialogs.link}
        focus={focus}
        runner={runner}
        onClose={() => setDialogs((current) => ({ ...current, link: false }))}
      />
      {dialogs.unlink !== null && (
        <UnlinkDialog
          open={dialogs.unlink.open}
          focus={focus}
          edge={dialogs.unlink.edge}
          runner={runner}
          onClose={() =>
            setDialogs((current) => ({
              ...current,
              unlink: current.unlink === null ? null : { ...current.unlink, open: false },
            }))
          }
        />
      )}
      {dialogs.reparent !== null && (
        <ReparentMilestoneDialog
          open={dialogs.reparent.open}
          milestone={dialogs.reparent.milestone}
          runner={runner}
          onClose={() =>
            setDialogs((current) => ({
              ...current,
              reparent: current.reparent === null ? null : { ...current.reparent, open: false },
            }))
          }
        />
      )}
    </>
  );
}

/** Facts about the inspected object; read-only, so it adds no control to either view. */
function InspectPanel({
  inspectedKey,
  neighborhood,
}: {
  readonly neighborhood: AlignmentNeighborhood;
  readonly inspectedKey: string;
}): ReactNode {
  const headingId = useId();
  const { edge, node } = findInspected(neighborhood, inspectedKey);
  const focus = neighborhood.focus;
  const path = nodePath(node);
  const isFocus = edge === undefined;
  return (
    <aside className="inspect-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('alignment.alignment-map.376')}</h2>
      <p className="sr-only" aria-live="polite">
        {uiMessage('alignment.alignment-page.403')}
        {kindLabel(node.kind)} “{node.title}”.
      </p>
      <p className="eyebrow">
        {kindLabel(node.kind)} ·{' '}
        {isFocus
          ? uiMessage('alignment.alignment-map.371')
          : relationshipLabel(edge.relationship, edge.direction)}
      </p>
      <p className="inspect-title">{node.title}</p>
      <dl className="inspect-facts">
        <div>
          <dt>{uiMessage('alignment.alignment-page.404')}</dt>
          <dd>{stateText(node.state)}</dd>
        </div>
        {node.archived && (
          <div>
            <dt>{uiMessage('alignment.alignment-page.405')}</dt>
            <dd>{uiMessage('alignment.alignment-page.406')}</dd>
          </div>
        )}
        {edge?.required === true && (
          <div>
            <dt>{uiMessage('alignment.alignment-page.407')}</dt>
            <dd>{uiMessage('alignment.alignment-page.408')}</dd>
          </div>
        )}
        {isFocus && focus.progress !== undefined && (
          <div>
            <dt>{uiMessage('alignment.alignment-page.409')}</dt>
            <dd>{progressText(focus.progress)}</dd>
          </div>
        )}
        {isFocus && (focus.targetStart !== undefined || focus.targetEnd !== undefined) && (
          <div>
            <dt>{uiMessage('alignment.alignment-page.410')}</dt>
            <dd>{targetWindowText(focus.targetStart, focus.targetEnd)}</dd>
          </div>
        )}
      </dl>
      {path !== null && (
        <Link className="inline-button" to={path}>
          {uiMessage('alignment.alignment-page.411')}
          {kindLabel(node.kind)}
          {uiMessage('alignment.alignment-page.412')}
        </Link>
      )}
    </aside>
  );
}
