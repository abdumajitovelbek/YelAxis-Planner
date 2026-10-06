import { message as uiMessage } from '../messages';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type {
  AlignmentEdge,
  AlignmentNeighborhood,
  AlignmentNode,
  AlignmentNodeKind,
} from '@yelaxis/application';

import { kindLabel, relationshipLabel } from './labels';
import {
  edgeGroups,
  groupHeading,
  nodePath,
  operationsFor,
  stateText,
  type AlignmentOperation,
  type AlignmentOperationId,
  type EdgeGroup,
} from './operations';

import './alignment-map.css';

/** Props shared by the canonical relationship list and the optional map view. */
export interface AlignmentViewProps {
  readonly neighborhood: AlignmentNeighborhood;
  /** `nodeKey` of the object shown in the Inspect panel. */
  readonly inspectedKey: string;
  readonly onOperation: (
    operation: AlignmentOperationId,
    node: AlignmentNode,
    edge?: AlignmentEdge,
  ) => void;
  /** Load every link of a truncated group; absent when the largest page is already shown. */
  readonly onShowAll?: () => void;
  /** Id of the polite summary that describes the view. */
  readonly summaryId: string;
}

export const nodeKey = (node: { readonly kind: AlignmentNodeKind; readonly id: string }): string =>
  `${node.kind}:${node.id}`;

/** "Outcome · Primary Outcome · Active"; archived objects always say so in words. */
export function nodeMeta(node: AlignmentNode, edge?: AlignmentEdge): string {
  return [
    kindLabel(node.kind),
    edge === undefined
      ? uiMessage('alignment.alignment-map.371')
      : relationshipLabel(edge.relationship, edge.direction),
    stateText(node.state),
    ...(node.archived && node.state !== 'archived'
      ? [uiMessage('alignment.alignment-page.405')]
      : []),
  ].join(' · ');
}

/** One operation button. Inspect is a toggle: pressed while that object is being inspected. */
export function OperationButton({
  edge,
  inspected,
  node,
  onOperation,
  operation,
}: {
  readonly operation: AlignmentOperation;
  readonly node: AlignmentNode;
  readonly edge: AlignmentEdge | undefined;
  readonly inspected: boolean;
  readonly onOperation: AlignmentViewProps['onOperation'];
}): ReactNode {
  return (
    <button
      type="button"
      {...(operation.id === 'inspect' ? { 'aria-pressed': inspected } : {})}
      onClick={() => onOperation(operation.id, node, edge)}
    >
      {operation.label} <span className="sr-only">{operation.target}</span>
    </button>
  );
}

/** "Show all N" for a truncated group, or a note once the largest page is already shown. */
export function ShowAll({
  label,
  loaded,
  onShowAll,
  total,
}: {
  readonly label: string;
  readonly loaded: number;
  readonly total: number;
  readonly onShowAll: (() => void) | undefined;
}): ReactNode {
  if (total <= loaded) return null;
  if (onShowAll === undefined)
    return (
      <p className="field-help">
        {uiMessage('actions-ui.320')}
        {loaded}
        {uiMessage('actions-ui.321')}
        {total}
        {uiMessage('alignment.relationship-list.779')}
      </p>
    );
  return (
    <button type="button" className="text-button show-all" onClick={onShowAll}>
      {uiMessage('alignment.relationship-list.780')}
      {total} <span className="sr-only">{label}</span>
    </button>
  );
}

/** Links above the focus, all relationships in catalog order, with their hidden remainder. */
export function aboveEdges(neighborhood: AlignmentNeighborhood): {
  readonly edges: readonly AlignmentEdge[];
  readonly loaded: number;
  readonly total: number;
} {
  const groups = edgeGroups(neighborhood, 'up');
  const edges = groups.flatMap((group) => group.edges);
  return {
    edges,
    loaded: edges.length,
    total: groups.reduce((sum, group) => sum + group.total, 0),
  };
}

const edgeKey = (edge: AlignmentEdge): string =>
  `${edge.relationship}:${edge.linkId ?? nodeKey(edge.other)}`;

/**
 * The canonical relationship list: the selected object, everything directly above it, and its
 * direct children grouped by relationship. Every row offers the operations of `operationsFor`,
 * exactly like the map.
 */
export function RelationshipList({
  inspectedKey,
  neighborhood,
  onOperation,
  onShowAll,
  summaryId,
}: AlignmentViewProps): ReactNode {
  const aboveId = useId();
  const belowId = useId();
  const focus = neighborhood.focus;
  const above = aboveEdges(neighborhood);
  const below = edgeGroups(neighborhood, 'down');
  const focusOperations = operationsFor(focus).filter((operation) => operation.id !== 'open');
  const focusPath = nodePath(focus);
  return (
    <section
      className="relationship-list"
      aria-label={uiMessage('alignment.relationship-list.781', { value0: focus.title })}
      aria-describedby={summaryId}
    >
      <div
        className="relationship-row relationship-row-focus"
        data-inspected={inspectedKey === nodeKey(focus)}
      >
        <p className="relationship-row-title">
          {focusPath === null ? focus.title : <Link to={focusPath}>{focus.title}</Link>}
        </p>
        <p className="field-help">{nodeMeta(focus)}</p>
        <div className="control-row">
          {focusOperations.map((operation) => (
            <OperationButton
              key={operation.id}
              operation={operation}
              node={focus}
              edge={undefined}
              inspected={inspectedKey === nodeKey(focus)}
              onOperation={onOperation}
            />
          ))}
        </div>
      </div>

      <h3 id={aboveId}>{uiMessage('alignment.alignment-map.367')}</h3>
      {above.edges.length === 0 ? (
        <p className="quiet-empty">
          {uiMessage('alignment.alignment-map.368')}
          {kindLabel(focus.kind)}.
        </p>
      ) : (
        <ol
          className="relationship-rows"
          aria-label={uiMessage('alignment.alignment-map.369', { value0: focus.title })}
        >
          {above.edges.map((edge) => (
            <EdgeRow
              key={edgeKey(edge)}
              edge={edge}
              focus={focus}
              inspectedKey={inspectedKey}
              onOperation={onOperation}
            />
          ))}
        </ol>
      )}
      <ShowAll
        label={uiMessage('alignment.alignment-map.370', { value0: focus.title })}
        loaded={above.loaded}
        total={above.total}
        onShowAll={onShowAll}
      />

      <h3 id={belowId}>{uiMessage('alignment.alignment-map.372')}</h3>
      {below.length === 0 ? (
        <p className="quiet-empty">
          {uiMessage('alignment.alignment-map.373')}
          {kindLabel(focus.kind)}
          {uiMessage('alignment.alignment-map.374')}
        </p>
      ) : (
        below.map((group) => (
          <EdgeGroupList
            key={group.relationship}
            group={group}
            focus={focus}
            inspectedKey={inspectedKey}
            onOperation={onOperation}
            onShowAll={onShowAll}
          />
        ))
      )}
    </section>
  );
}

function EdgeGroupList({
  focus,
  group,
  inspectedKey,
  onOperation,
  onShowAll,
}: {
  readonly focus: AlignmentNode;
  readonly group: EdgeGroup;
  readonly inspectedKey: string;
  readonly onOperation: AlignmentViewProps['onOperation'];
  readonly onShowAll: (() => void) | undefined;
}): ReactNode {
  const headingId = useId();
  const heading = groupHeading(group.relationship);
  return (
    <section className="relationship-group" aria-labelledby={headingId}>
      <h4 id={headingId}>
        {heading} <span className="group-count">({group.total})</span>
      </h4>
      <ol
        className="relationship-rows"
        aria-label={uiMessage('alignment.alignment-map.375', {
          value0: heading,
          value1: focus.title,
        })}
      >
        {group.edges.map((edge) => (
          <EdgeRow
            key={edgeKey(edge)}
            edge={edge}
            focus={focus}
            inspectedKey={inspectedKey}
            onOperation={onOperation}
          />
        ))}
      </ol>
      <ShowAll
        label={heading}
        loaded={group.edges.length}
        total={group.total}
        onShowAll={onShowAll}
      />
    </section>
  );
}

function EdgeRow({
  edge,
  focus,
  inspectedKey,
  onOperation,
}: {
  readonly edge: AlignmentEdge;
  readonly focus: AlignmentNode;
  readonly inspectedKey: string;
  readonly onOperation: AlignmentViewProps['onOperation'];
}): ReactNode {
  const other = edge.other;
  const operations = operationsFor(focus, edge);
  const path = operations.some((operation) => operation.id === 'open') ? nodePath(other) : null;
  const inspected = inspectedKey === nodeKey(other);
  return (
    <li className="relationship-row" data-inspected={inspected} data-archived={other.archived}>
      <p className="relationship-row-title">
        {path === null ? other.title : <Link to={path}>{other.title}</Link>}
      </p>
      <p className="field-help">{nodeMeta(other, edge)}</p>
      <div className="control-row">
        {operations
          .filter((operation) => operation.id !== 'open')
          .map((operation) => (
            <OperationButton
              key={operation.id}
              operation={operation}
              node={other}
              edge={edge}
              inspected={inspected}
              onOperation={onOperation}
            />
          ))}
      </div>
    </li>
  );
}
