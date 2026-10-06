import { message as uiMessage } from '../messages';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { AlignmentEdge, AlignmentNode } from '@yelaxis/application';

import { kindLabel, relationshipLabel } from './labels';
import { edgeGroups, groupHeading, nodePath, operationsFor, stateText } from './operations';
import {
  aboveEdges,
  nodeKey,
  OperationButton,
  ShowAll,
  type AlignmentViewProps,
} from './relationship-list';

import './alignment-map.css';

type Placement = 'above' | 'focus' | 'below';

interface Connectors {
  readonly width: number;
  readonly height: number;
  readonly paths: readonly {
    readonly key: string;
    readonly d: string;
    readonly archived: boolean;
  }[];
}

const noConnectors: Connectors = { width: 0, height: 0, paths: [] };

const sameConnectors = (left: Connectors, right: Connectors): boolean =>
  left.width === right.width &&
  left.height === right.height &&
  left.paths.length === right.paths.length &&
  left.paths.every((path, index) => path.d === right.paths[index]?.d);

/**
 * Measure the layout and draw one quiet curve from each parent node down to the selected one, and
 * from the selected one down to the heading of each group of children.
 */
function measureConnectors(container: HTMLElement): Connectors {
  const box = container.getBoundingClientRect();
  const focus = container.querySelector<HTMLElement>('[data-map-node="focus"]');
  if (focus === null || box.width === 0) return noConnectors;
  const center = focus.getBoundingClientRect();
  const focusX = center.left + center.width / 2 - box.left;
  const paths = [
    ...container.querySelectorAll<HTMLElement>('[data-map-node="above"], [data-map-anchor]'),
  ].map((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - box.left;
    const above = element.dataset['mapNode'] === 'above';
    const start = above
      ? { x, y: rect.bottom - box.top }
      : { x: focusX, y: center.bottom - box.top };
    const end = above ? { x: focusX, y: center.top - box.top } : { x, y: rect.top - box.top };
    const middle = (start.y + end.y) / 2;
    const round = (value: number): string => value.toFixed(1);
    return {
      key: element.dataset['key'] ?? '',
      archived: element.dataset['archived'] === 'true',
      d: uiMessage('alignment.alignment-map.365', {
        value0: round(start.x),
        value1: round(start.y),
        value2: round(start.x),
        value3: round(middle),
        value4: round(end.x),
        value5: round(middle),
        value6: round(end.x),
        value7: round(end.y),
      }),
    };
  });
  return { width: box.width, height: box.height, paths };
}

/**
 * Optional map view of the same neighborhood as the relationship list: three bands (Above,
 * Selected, Below) in reading and tab order, with decorative connectors in one hidden SVG. Every
 * node offers exactly the operations of the list; there is no orbit, drift, or radial layout.
 */
export function AlignmentMap({
  inspectedKey,
  neighborhood,
  onOperation,
  onShowAll,
  summaryId,
}: AlignmentViewProps): ReactNode {
  const container = useRef<HTMLElement>(null);
  const [connectors, setConnectors] = useState<Connectors>(noConnectors);
  const focus = neighborhood.focus;
  const above = aboveEdges(neighborhood);
  const below = edgeGroups(neighborhood, 'down');

  useLayoutEffect(() => {
    const element = container.current;
    if (element === null) return;
    const draw = (): void => {
      const next = measureConnectors(element);
      setConnectors((current) => (sameConnectors(current, next) ? current : next));
    };
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    for (const node of element.querySelectorAll('[data-map-node], [data-map-anchor]'))
      observer.observe(node);
    return () => observer.disconnect();
  }, [neighborhood]);

  return (
    <section
      ref={container}
      className="alignment-map"
      aria-label={uiMessage('alignment.alignment-map.366', { value0: focus.title })}
      aria-describedby={summaryId}
    >
      <svg
        className="alignment-map-connectors"
        aria-hidden="true"
        focusable="false"
        width={connectors.width}
        height={connectors.height}
        viewBox={`0 0 ${String(connectors.width)} ${String(connectors.height)}`}
      >
        {connectors.paths.map((path, index) => (
          <path
            key={`${String(index)}:${path.key}`}
            d={path.d}
            {...(path.archived ? { className: 'connector-archived' } : {})}
          />
        ))}
      </svg>
      <div className="map-band map-band-above">
        <h3 className="map-band-title">{uiMessage('alignment.alignment-map.367')}</h3>
        {above.edges.length === 0 ? (
          <p className="quiet-empty">
            {uiMessage('alignment.alignment-map.368')}
            {kindLabel(focus.kind)}.
          </p>
        ) : (
          <ol
            className="map-nodes"
            aria-label={uiMessage('alignment.alignment-map.369', { value0: focus.title })}
          >
            {above.edges.map((edge) => (
              <MapNode
                key={`${edge.relationship}:${nodeKey(edge.other)}`}
                placement="above"
                node={edge.other}
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
      </div>
      <div className="map-band map-band-selected">
        <h3 className="map-band-title">{uiMessage('alignment.alignment-map.371')}</h3>
        <div className="map-nodes">
          <MapNode
            placement="focus"
            node={focus}
            edge={undefined}
            focus={focus}
            inspectedKey={inspectedKey}
            onOperation={onOperation}
          />
        </div>
      </div>
      <div className="map-band map-band-below">
        <h3 className="map-band-title">{uiMessage('alignment.alignment-map.372')}</h3>
        {below.length === 0 ? (
          <p className="quiet-empty">
            {uiMessage('alignment.alignment-map.373')}
            {kindLabel(focus.kind)}
            {uiMessage('alignment.alignment-map.374')}
          </p>
        ) : (
          <div className="map-groups">
            {below.map((group) => (
              <MapGroup
                key={group.relationship}
                heading={groupHeading(group.relationship)}
                edges={group.edges}
                total={group.total}
                focus={focus}
                inspectedKey={inspectedKey}
                onOperation={onOperation}
                onShowAll={onShowAll}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MapGroup({
  edges,
  focus,
  heading,
  inspectedKey,
  onOperation,
  onShowAll,
  total,
}: {
  readonly heading: string;
  readonly edges: readonly AlignmentEdge[];
  readonly total: number;
  readonly focus: AlignmentNode;
  readonly inspectedKey: string;
  readonly onOperation: AlignmentViewProps['onOperation'];
  readonly onShowAll: (() => void) | undefined;
}): ReactNode {
  const headingId = useId();
  return (
    <section className="map-group" aria-labelledby={headingId}>
      <h4 id={headingId} data-map-anchor="group" data-key={heading}>
        {heading} <span className="group-count">({total})</span>
      </h4>
      <ol
        className="map-nodes"
        aria-label={uiMessage('alignment.alignment-map.375', {
          value0: heading,
          value1: focus.title,
        })}
      >
        {edges.map((edge) => (
          <MapNode
            key={`${edge.relationship}:${nodeKey(edge.other)}`}
            placement="below"
            node={edge.other}
            edge={edge}
            focus={focus}
            inspectedKey={inspectedKey}
            onOperation={onOperation}
          />
        ))}
      </ol>
      <ShowAll label={heading} loaded={edges.length} total={total} onShowAll={onShowAll} />
    </section>
  );
}

/**
 * One node: its title is the Inspect toggle (named "Inspect {title}", as in the list), followed by
 * the same Center, Unlink, Move, and Open controls the list row offers.
 */
function MapNode({
  edge,
  focus,
  inspectedKey,
  node,
  onOperation,
  placement,
}: {
  readonly placement: Placement;
  readonly node: AlignmentNode;
  readonly edge: AlignmentEdge | undefined;
  readonly focus: AlignmentNode;
  readonly inspectedKey: string;
  readonly onOperation: AlignmentViewProps['onOperation'];
}): ReactNode {
  const operations = edge === undefined ? operationsFor(node) : operationsFor(focus, edge);
  const inspect = operations.find((operation) => operation.id === 'inspect');
  const inspected = inspectedKey === nodeKey(node);
  const path = nodePath(node);
  const content = (
    <>
      <p className="map-node-meta">
        {kindLabel(node.kind)}
        {edge === undefined ? '' : ` · ${relationshipLabel(edge.relationship, edge.direction)}`}
      </p>
      <button
        type="button"
        className="map-node-select"
        aria-pressed={inspected}
        onClick={() => onOperation('inspect', node, edge)}
      >
        <span className="sr-only">
          {inspect?.label ?? uiMessage('alignment.alignment-map.376')}
        </span>{' '}
        <span className="map-node-title">{node.title}</span>
      </button>
      <p className="map-node-state">
        <span className="status-pill">{stateText(node.state)}</span>
        {node.archived && node.state !== 'archived'
          ? uiMessage('alignment.alignment-map.2440')
          : ''}
      </p>
      <div className="control-row">
        {operations
          .filter((operation) => operation.id !== 'inspect')
          .map((operation) =>
            operation.id === 'open' ? (
              path === null ? null : (
                <Link key="open" to={path}>
                  {operation.label} <span className="sr-only">{operation.target}</span>
                </Link>
              )
            ) : (
              <OperationButton
                key={operation.id}
                operation={operation}
                node={node}
                edge={edge}
                inspected={inspected}
                onOperation={onOperation}
              />
            ),
          )}
      </div>
    </>
  );
  const shared = {
    className: 'map-node',
    'data-map-node': placement,
    'data-key': nodeKey(node),
    'data-archived': node.archived,
    'data-inspected': inspected,
  };
  return placement === 'focus' ? <div {...shared}>{content}</div> : <li {...shared}>{content}</li>;
}
