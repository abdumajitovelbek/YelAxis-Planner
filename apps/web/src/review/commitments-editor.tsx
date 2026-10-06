import { message as uiMessage } from '../messages';
/**
 * Choosing the planning Week's commitments in the weekly review (planning Week-commitment
 * rules): up to three Actions, Projects, or Milestones in the person's own order. Candidates are
 * listed in plan order and never ranked; only the Week's current commitments start chosen. Nothing
 * is saved here: the review saves or applies the choice.
 */
import { useRef, type ReactNode } from 'react';

import type { Bounded, ReviewCommitmentCandidate } from '@yelaxis/application';
import { reviewLimits } from '@yelaxis/domain';

import { stateLabel } from '../alignment/labels';
import { useFocusReturn } from '../today/choose-focus-dialog';

/** One chosen commitment, in order. */
export interface CommitmentChoice {
  readonly kind: ReviewCommitmentCandidate['kind'];
  readonly id: string;
  readonly title: string;
  /** "Action · Planned", when known. */
  readonly detail?: string;
}

export const commitmentKey = (choice: Pick<CommitmentChoice, 'kind' | 'id'>): string =>
  `${choice.kind}:${choice.id.toLowerCase()}`;

const kindWords: Readonly<Record<CommitmentChoice['kind'], string>> = {
  action: uiMessage('actions-ui.282'),
  project: uiMessage('actions-ui.254'),
  milestone: uiMessage('actions-ui.276'),
};

/** "Action · Planned". */
export function commitmentDetail(kind: CommitmentChoice['kind'], state: string): string {
  return `${kindWords[kind]} · ${stateLabel(kind, state)}`;
}

export const commitmentLimitReason = uiMessage('review.commitments-editor.1916');

const groups = [
  { kind: 'action', legend: uiMessage('alignment.project-detail.758') },
  { kind: 'project', legend: uiMessage('alignment.axis-detail.429') },
  { kind: 'milestone', legend: uiMessage('actions-ui.314') },
] as const;

/**
 * Check up to three candidates, then put them in order with Move up, Move down, and Remove. A
 * chosen commitment that is not a candidate any more (finished elsewhere) stays in the order list,
 * where it can be removed.
 */
export function CommitmentsEditor({
  candidates,
  idPrefix,
  onChange,
  value,
}: {
  readonly candidates: Bounded<ReviewCommitmentCandidate>;
  readonly value: readonly CommitmentChoice[];
  readonly onChange: (value: readonly CommitmentChoice[]) => void;
  readonly idPrefix: string;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const focusReturn = useFocusReturn(root);
  const latest = useRef(value);
  latest.current = value;
  const changedFrom = (before: readonly CommitmentChoice[]) => () => latest.current !== before;
  const limit = reviewLimits.commitments;
  const chosen = new Set(value.map(commitmentKey));
  const full = value.length >= limit;
  const limitId = `${idPrefix}-limit`;
  const orderHeadingId = `${idPrefix}-order-heading`;
  const details = new Map<string, string>();
  for (const candidate of candidates.items)
    details.set(commitmentKey(candidate), commitmentDetail(candidate.kind, candidate.state));

  const toggle = (candidate: ReviewCommitmentCandidate, checked: boolean): void => {
    const key = commitmentKey(candidate);
    if (checked) {
      if (chosen.has(key) || full) return;
      onChange([
        ...value,
        {
          kind: candidate.kind,
          id: candidate.id,
          title: candidate.title,
          detail: commitmentDetail(candidate.kind, candidate.state),
        },
      ]);
    } else onChange(value.filter((item) => commitmentKey(item) !== key));
  };
  const move = (index: number, direction: 'up' | 'down'): void => {
    const other = direction === 'up' ? index - 1 : index + 1;
    const item = value[index];
    const neighbor = value[other];
    if (item === undefined || neighbor === undefined) return;
    const next = [...value];
    next[index] = neighbor;
    next[other] = item;
    const key = commitmentKey(item);
    const opposite = direction === 'up' ? 'down' : 'up';
    focusReturn.request([`${key}:${direction}`, `${key}:${opposite}`], changedFrom(value));
    onChange(next);
  };
  const remove = (index: number): void => {
    const next = value.filter((_, position) => position !== index);
    const after = next[index] ?? next[index - 1];
    focusReturn.request(
      after === undefined ? ['order-empty'] : [`${commitmentKey(after)}:remove`],
      changedFrom(value),
    );
    onChange(next);
  };

  return (
    <div ref={root} className="focus-draft review-commitments">
      {candidates.items.length === 0 ? (
        <p className="quiet-empty">{uiMessage('review.commitments-editor.1917')}</p>
      ) : (
        groups.map(({ kind, legend }) => {
          const group = candidates.items.filter((candidate) => candidate.kind === kind);
          if (group.length === 0) return null;
          return (
            <fieldset key={kind} className="focus-choice-group">
              <legend>{legend}</legend>
              <ul className="focus-choice-list">
                {group.map((candidate) => {
                  const key = commitmentKey(candidate);
                  const checked = chosen.has(key);
                  const blocked = !checked && full;
                  const id = `${idPrefix}-choice-${key}`;
                  const detailId = `${id}-detail`;
                  return (
                    <li key={key} className="focus-choice">
                      <label className="check-row" htmlFor={id}>
                        <input
                          id={id}
                          type="checkbox"
                          checked={checked}
                          aria-disabled={blocked ? true : undefined}
                          aria-describedby={blocked ? `${detailId} ${limitId}` : detailId}
                          onChange={(event) => toggle(candidate, event.target.checked)}
                        />
                        <span>{candidate.title}</span>
                      </label>
                      <p id={detailId} className="field-help focus-choice-detail">
                        {details.get(key)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })
      )}
      {candidates.total > candidates.items.length && (
        <p className="field-help">
          {uiMessage('review.commitments-editor.1918', {
            value0: String(candidates.items.length),
            value1: String(candidates.total),
          })}
        </p>
      )}
      <p className="focus-draft-count" aria-live="polite">
        {uiMessage('review.commitments-editor.1919', {
          value0: String(value.length),
          value1: String(limit),
        })}
      </p>
      {full && (
        <p id={limitId} className="field-help">
          {commitmentLimitReason}
        </p>
      )}
      <h3 id={orderHeadingId} className="focus-order-heading">
        {uiMessage('review.commitments-editor.1920')}
      </h3>
      {value.length === 0 ? (
        <p className="quiet-empty" data-focus-key="order-empty" tabIndex={-1}>
          {uiMessage('review.commitments-editor.1921')}
        </p>
      ) : (
        <ol className="focus-order" aria-labelledby={orderHeadingId}>
          {value.map((item, index) => {
            const key = commitmentKey(item);
            const detail = item.detail ?? details.get(key);
            return (
              <li key={key} className="focus-order-item">
                <span className="focus-position" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="focus-order-main">
                  <p className="focus-order-title">{item.title}</p>
                  {detail !== undefined && (
                    <p className="field-help focus-order-detail">{detail}</p>
                  )}
                  <div className="control-row">
                    <button
                      type="button"
                      data-focus-key={`${key}:up`}
                      aria-label={uiMessage('actions-ui.266', { value0: item.title })}
                      aria-disabled={index === 0 ? true : undefined}
                      onClick={() => {
                        if (index > 0) move(index, 'up');
                      }}
                    >
                      {uiMessage('review.commitments-editor.1922')}
                    </button>
                    <button
                      type="button"
                      data-focus-key={`${key}:down`}
                      aria-label={uiMessage('actions-ui.267', { value0: item.title })}
                      aria-disabled={index === value.length - 1 ? true : undefined}
                      onClick={() => {
                        if (index < value.length - 1) move(index, 'down');
                      }}
                    >
                      {uiMessage('review.commitments-editor.1923')}
                    </button>
                    <button
                      type="button"
                      data-focus-key={`${key}:remove`}
                      onClick={() => remove(index)}
                    >
                      {uiMessage('plan.plan-week.1373')}
                      <span className="sr-only">{item.title}</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
