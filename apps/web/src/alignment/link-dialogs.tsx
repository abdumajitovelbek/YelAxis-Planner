import { message as uiMessage } from '../messages';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type {
  AlignmentApplication,
  AlignmentEdge,
  AlignmentNode,
  AlignmentNodeKind,
  AlignmentRelationship,
  Bounded,
  LinkInput,
  LinkPreview,
  RevisionRef,
  UnlinkInput,
} from '@yelaxis/application';
import { alignmentRelationshipRules, type AlignmentRelationshipRule } from '@yelaxis/domain';

import { Modal } from '../plan/modal';
import { useAlignment, type CommandRunner } from '../plan/planning-context';
import { DialogError, useDialogAutofocus } from '../plan/timeline';
import { kindLabel } from './labels';
import { linkableRelationships, stateText } from './operations';

import './alignment-map.css';

/* ───────────────────────── Link and unlink inputs ───────────────────────── */

type Candidate = AlignmentNode & { readonly alreadyLinked: boolean; readonly crossAxis: boolean };

/** Parent and child of a link between the focus and another object, in catalog direction. */
export function linkEnds(
  focus: AlignmentNode,
  edge: AlignmentEdge,
): { readonly parent: AlignmentNode; readonly child: AlignmentNode } {
  return edge.direction === 'up'
    ? { parent: edge.other, child: focus }
    : { parent: focus, child: edge.other };
}

const revisionRef = <K extends 'outcome' | 'project' | 'action'>(
  kind: K,
  node: AlignmentNode,
): RevisionRef<K> => ({ kind, id: node.id, revision: node.localRevision });

/**
 * The link command for `focus` and `other` under `rule`. Single-valued kinds carry the child's
 * revision; replacing its current parent and crossing Axes each need an explicit confirmation.
 */
export function buildLinkInput(
  rule: AlignmentRelationshipRule,
  focus: AlignmentNode,
  other: AlignmentNode,
  options: { readonly replaceExisting?: boolean; readonly confirmCrossAxis?: boolean } = {},
): LinkInput | null {
  const focusIsParent = rule.parentKind === focus.kind;
  const parent = focusIsParent ? focus : other;
  const child = focusIsParent ? other : focus;
  if (parent.kind !== rule.parentKind || child.kind !== rule.childKind) return null;
  const replace = options.replaceExisting === true ? { replaceExisting: true } : {};
  switch (rule.relationship) {
    case 'axis_outcome':
      return {
        relationship: 'axis_outcome',
        axisId: parent.id,
        outcome: revisionRef('outcome', child),
        ...replace,
      };
    case 'axis_project':
      return {
        relationship: 'axis_project',
        axisId: parent.id,
        project: revisionRef('project', child),
        ...replace,
      };
    case 'outcome_primary_project':
      return {
        relationship: 'outcome_primary_project',
        outcomeId: parent.id,
        project: revisionRef('project', child),
        ...replace,
      };
    case 'outcome_secondary_project':
      return {
        relationship: 'outcome_secondary_project',
        outcomeId: parent.id,
        projectId: child.id,
      };
    case 'milestone_project':
      return { relationship: 'milestone_project', milestoneId: parent.id, projectId: child.id };
    case 'milestone_action':
      return { relationship: 'milestone_action', milestoneId: parent.id, actionId: child.id };
    case 'project_action':
      return {
        relationship: 'project_action',
        projectId: parent.id,
        action: revisionRef('action', child),
        ...replace,
        ...(options.confirmCrossAxis === true ? { confirmCrossAxis: true } : {}),
      };
    case 'axis_routine':
    case 'outcome_milestone':
    case 'project_note':
      return null;
  }
}

/** The unlink command for one edge; null for required and display-only relationships. */
export function buildUnlinkInput(focus: AlignmentNode, edge: AlignmentEdge): UnlinkInput | null {
  const { child } = linkEnds(focus, edge);
  switch (edge.relationship) {
    case 'axis_outcome':
      return { relationship: 'axis_outcome', outcome: revisionRef('outcome', child) };
    case 'axis_project':
      return { relationship: 'axis_project', project: revisionRef('project', child) };
    case 'outcome_primary_project':
      return { relationship: 'outcome_primary_project', project: revisionRef('project', child) };
    case 'project_action':
      return { relationship: 'project_action', action: revisionRef('action', child) };
    case 'outcome_secondary_project':
    case 'milestone_project':
    case 'milestone_action':
      return edge.linkId === undefined || edge.linkRevision === undefined
        ? null
        : { relationship: edge.relationship, linkId: edge.linkId, revision: edge.linkRevision };
    case 'axis_routine':
    case 'outcome_milestone':
    case 'project_note':
      return null;
  }
}

/* ───────────────────────── Wording ───────────────────────── */

const withArticle = (kind: AlignmentNodeKind): string =>
  `${kind === 'axis' || kind === 'outcome' || kind === 'action' ? 'an' : 'a'} ${kindLabel(kind)}`;

/** How the object to choose relates to the focus, e.g. "A supporting Action". */
const linkOptionLabels: Readonly<
  Record<AlignmentRelationship, { readonly asParent: string; readonly asChild: string }>
> = {
  axis_outcome: {
    asParent: uiMessage('alignment.link-dialogs.532'),
    asChild: uiMessage('alignment.link-dialogs.533'),
  },
  axis_project: {
    asParent: uiMessage('alignment.link-dialogs.534'),
    asChild: uiMessage('alignment.link-dialogs.533'),
  },
  axis_routine: {
    asParent: uiMessage('alignment.link-dialogs.535'),
    asChild: uiMessage('alignment.link-dialogs.533'),
  },
  outcome_milestone: { asParent: 'A Milestone', asChild: uiMessage('alignment.link-dialogs.536') },
  outcome_primary_project: {
    asParent: uiMessage('alignment.link-dialogs.537'),
    asChild: uiMessage('alignment.link-dialogs.538'),
  },
  outcome_secondary_project: {
    asParent: uiMessage('alignment.link-dialogs.539'),
    asChild: uiMessage('alignment.link-dialogs.540'),
  },
  project_action: {
    asParent: uiMessage('alignment.link-dialogs.541'),
    asChild: uiMessage('alignment.link-dialogs.542'),
  },
  project_note: {
    asParent: uiMessage('alignment.link-dialogs.543'),
    asChild: uiMessage('alignment.link-dialogs.542'),
  },
  milestone_project: {
    asParent: uiMessage('alignment.link-dialogs.539'),
    asChild: uiMessage('alignment.link-dialogs.544'),
  },
  milestone_action: {
    asParent: uiMessage('alignment.link-dialogs.545'),
    asChild: uiMessage('alignment.link-dialogs.544'),
  },
};

export const linkOptionLabel = (
  rule: AlignmentRelationshipRule,
  focusKind: AlignmentNodeKind,
): string =>
  rule.parentKind === focusKind
    ? linkOptionLabels[rule.relationship].asParent
    : linkOptionLabels[rule.relationship].asChild;

/** The current parent a single-valued link replaces, e.g. "primary Outcome". */
const replacedRoles: Readonly<Partial<Record<AlignmentRelationship, string>>> = {
  axis_outcome: uiMessage('actions-ui.251'),
  axis_project: uiMessage('actions-ui.251'),
  outcome_primary_project: uiMessage('alignment.link-dialogs.546'),
  project_action: uiMessage('actions-ui.254'),
};

const reasonMessages: Readonly<Record<NonNullable<LinkPreview['reason']>, string>> = {
  archived_endpoint: uiMessage('alignment.link-dialogs.547'),
  cardinality_violation: uiMessage('alignment.link-dialogs.548'),
  primary_is_secondary: uiMessage('alignment.link-dialogs.549'),
  unsupported_relationship: uiMessage('alignment.link-dialogs.550'),
  not_found: uiMessage('alignment.link-dialogs.551'),
};

/** A preview blocks the link unless its only issue is a replacement the person can confirm. */
function previewBlocker(preview: LinkPreview, rule: AlignmentRelationshipRule): string | null {
  if (preview.alreadyLinked) return uiMessage('alignment.link-dialogs.552');
  if (preview.allowed) return null;
  if (preview.reason === 'cardinality_violation') {
    if (preview.replaces !== undefined) return null;
    return rule.relationship === 'outcome_secondary_project'
      ? uiMessage('alignment.link-dialogs.553')
      : uiMessage('alignment.link-dialogs.554', {
          value0: kindLabel(rule.childKind),
          value1: withArticle(rule.parentKind),
        });
  }
  return reasonMessages[preview.reason ?? 'unsupported_relationship'];
}

/* ───────────────────────── Link dialog ───────────────────────── */

export interface LinkDialogProps {
  readonly open: boolean;
  readonly focus: AlignmentNode;
  /** Offer only these relationships (for example `milestone_action` on Action detail). */
  readonly relationships?: readonly AlignmentRelationship[];
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}

/**
 * Link the focus to one more object. Only relationships the catalog allows for its kind and
 * non-archived candidates are offered; an existing link is shown as "Already linked", a replaced
 * single-valued parent is previewed by name, and a cross-Axis Action/Project link needs an explicit
 * confirmation.
 */
export function LinkDialog({
  focus,
  onClose,
  open,
  relationships,
  runner,
}: LinkDialogProps): ReactNode {
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('alignment.alignment-page.407')}
      title={uiMessage('alignment.link-dialogs.555', { value0: focus.title })}
      description={uiMessage('alignment.link-dialogs.556')}
      onClose={close}
    >
      {open && (
        <LinkForm
          focus={focus}
          relationships={relationships}
          runner={runner}
          onCancel={close}
          onDone={onClose}
        />
      )}
    </Modal>
  );
}

type CandidateState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly key: string;
      readonly result: Bounded<Candidate>;
    };

const candidateLimit = 50;

/** Candidates for one relationship and search, re-queried (debounced) as the search changes. */
function useCandidates(
  alignment: AlignmentApplication,
  focus: AlignmentNode,
  relationship: AlignmentRelationship | null,
  search: string,
): CandidateState {
  const [state, setState] = useState<CandidateState>({ status: 'loading' });
  const query = search.trim();
  const key = `${relationship ?? ''}|${query}`;
  useEffect(() => {
    if (relationship === null) return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        alignment
          .listLinkCandidates({
            focus: { kind: focus.kind, id: focus.id },
            relationship,
            ...(query === '' ? {} : { search: query }),
            limit: candidateLimit,
          })
          .then(
            (result) => {
              if (live) setState({ status: 'ready', key, result });
            },
            () => {
              if (live) setState({ status: 'error' });
            },
          );
      },
      query === '' ? 0 : 200,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [alignment, focus.kind, focus.id, relationship, query, key]);
  // Keep the previous results on screen while a new search runs for the same relationship.
  if (state.status === 'ready' && !state.key.startsWith(`${relationship ?? ''}|`))
    return { status: 'loading' };
  return state;
}

type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly key: string }
  | { readonly status: 'ready'; readonly key: string; readonly preview: LinkPreview }
  | { readonly status: 'error'; readonly key: string };

function useLinkPreview(
  alignment: AlignmentApplication,
  input: LinkInput | null,
  key: string | null,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    const current = inputRef.current;
    if (key === null || current === null) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    setState({ status: 'loading', key });
    alignment.previewLink(current).then(
      (preview) => {
        if (live) setState({ status: 'ready', key, preview });
      },
      () => {
        if (live) setState({ status: 'error', key });
      },
    );
    return () => {
      live = false;
    };
  }, [alignment, key]);
  return state.status !== 'idle' && state.key !== key ? { status: 'idle' } : state;
}

function LinkForm({
  focus,
  onCancel,
  onDone,
  relationships,
  runner,
}: {
  readonly focus: AlignmentNode;
  readonly relationships: readonly AlignmentRelationship[] | undefined;
  readonly runner: CommandRunner;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const idBase = useId();
  const container = useRef<HTMLFormElement>(null);
  const crossAxisField = useRef<HTMLInputElement>(null);
  useDialogAutofocus(container);
  const rules = linkableRelationships(focus.kind).filter(
    (rule) => relationships === undefined || relationships.includes(rule.relationship),
  );
  const [relationship, setRelationship] = useState<AlignmentRelationship | null>(
    rules[0]?.relationship ?? null,
  );
  const rule = relationship === null ? undefined : alignmentRelationshipRules[relationship];
  const candidateKind =
    rule === undefined
      ? undefined
      : rule.parentKind === focus.kind
        ? rule.childKind
        : rule.parentKind;
  const [search, setSearch] = useState('');
  const candidates = useCandidates(alignment, focus, relationship, search);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmCrossAxis, setConfirmCrossAxis] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = candidates.status === 'ready' ? candidates.result.items : [];
  const selected = items.find((candidate) => candidate.id === selectedId) ?? null;
  const previewInput =
    rule === undefined || selected === null ? null : buildLinkInput(rule, focus, selected);
  const previewKey =
    previewInput === null || selected === null ? null : `${relationship ?? ''}:${selected.id}`;
  const preview = useLinkPreview(alignment, previewInput, previewKey);
  const ready = preview.status === 'ready' ? preview.preview : null;

  if (focus.archived || rules.length === 0 || rule === undefined || candidateKind === undefined) {
    // The dialog heading's Close button is the only action here.
    return (
      <p className="quiet-empty">
        {focus.archived
          ? uiMessage('alignment.link-dialogs.557', { value0: kindLabel(focus.kind) })
          : uiMessage('alignment.link-dialogs.558', { value0: kindLabel(focus.kind) })}
      </p>
    );
  }

  const parentOf = (other: AlignmentNode): AlignmentNode =>
    rule.parentKind === focus.kind ? focus : other;
  const childOf = (other: AlignmentNode): AlignmentNode =>
    rule.parentKind === focus.kind ? other : focus;

  const chooseRelationship = (next: AlignmentRelationship): void => {
    setRelationship(next);
    setSelectedId(null);
    setConfirmCrossAxis(false);
    setError(null);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (selected === null) {
      setError(uiMessage('alignment.link-dialogs.559', { value0: withArticle(candidateKind) }));
      return;
    }
    const blocker = ready === null ? null : previewBlocker(ready, rule);
    if (blocker !== null) {
      setError(blocker);
      return;
    }
    if (ready?.crossAxis === true && !confirmCrossAxis) {
      setError(uiMessage('alignment.link-dialogs.560'));
      crossAxisField.current?.focus();
      return;
    }
    const input = buildLinkInput(rule, focus, selected, {
      replaceExisting: ready?.replaces !== undefined,
      confirmCrossAxis: ready?.crossAxis === true && confirmCrossAxis,
    });
    if (input === null) return;
    setError(null);
    const done = await runner.run(
      () => alignment.link(input),
      uiMessage('alignment.link-dialogs.561', {
        value0: childOf(selected).title,
        value1: parentOf(selected).title,
      }),
    );
    if (done) onDone();
  };

  const previewText = (): string => {
    if (selected === null) return '';
    if (preview.status === 'loading' || preview.status === 'idle')
      return uiMessage('alignment.link-dialogs.562');
    if (preview.status === 'error') return uiMessage('alignment.link-dialogs.563');
    const blocker = previewBlocker(preview.preview, rule);
    if (blocker !== null) return blocker;
    const role = replacedRoles[rule.relationship];
    if (preview.preview.replaces !== undefined)
      return uiMessage('alignment.link-dialogs.564', {
        value0: role ?? kindLabel(rule.parentKind),
        value1: preview.preview.replaces.title,
      });
    return uiMessage('alignment.link-dialogs.565', {
      value0: childOf(selected).title,
      value1: parentOf(selected).title,
    });
  };

  return (
    <form ref={container} noValidate onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <DialogError runner={runner} />
      {rules.length > 1 ? (
        <fieldset className="compact-fieldset">
          <legend>{uiMessage('alignment.link-dialogs.566')}</legend>
          {rules.map((option) => (
            <label
              key={option.relationship}
              className="check-row"
              htmlFor={`${idBase}-${option.relationship}`}
            >
              <input
                id={`${idBase}-${option.relationship}`}
                type="radio"
                name={`${idBase}-relationship`}
                checked={relationship === option.relationship}
                {...(relationship === option.relationship ? { 'data-autofocus': true } : {})}
                onChange={() => chooseRelationship(option.relationship)}
              />
              <span>{linkOptionLabel(option, focus.kind)}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="field-help">
          {uiMessage('alignment.link-dialogs.567')}
          {linkOptionLabel(rule, focus.kind)}
        </p>
      )}
      <label className="field-label" htmlFor={`${idBase}-search`}>
        {uiMessage('alignment.link-dialogs.568')}
        <input
          id={`${idBase}-search`}
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setError(null);
          }}
        />
      </label>
      <fieldset className="compact-fieldset link-candidates" aria-describedby={`${idBase}-help`}>
        <legend>
          {uiMessage('alignment.link-dialogs.569')}
          {withArticle(candidateKind)}
        </legend>
        <p id={`${idBase}-help`} className="field-help">
          {uiMessage('alignment.link-dialogs.570')}
        </p>
        {candidates.status === 'loading' && (
          <p className="field-help" role="status">
            {uiMessage('alignment.link-dialogs.571')}
          </p>
        )}
        {candidates.status === 'error' && (
          <p className="validation-summary" role="alert">
            {uiMessage('alignment.link-dialogs.572')}
          </p>
        )}
        {candidates.status === 'ready' && items.length === 0 && (
          <p className="quiet-empty">
            {search.trim() === ''
              ? uiMessage('alignment.link-dialogs.573', { value0: withArticle(candidateKind) })
              : uiMessage('alignment.link-dialogs.574', { value0: search.trim() })}
          </p>
        )}
        {items.length > 0 && (
          <ul className="link-candidate-list">
            {items.map((candidate) => (
              <li key={candidate.id}>
                <label className="check-row" htmlFor={`${idBase}-candidate-${candidate.id}`}>
                  <input
                    id={`${idBase}-candidate-${candidate.id}`}
                    type="radio"
                    name={`${idBase}-candidate`}
                    value={candidate.id}
                    checked={selectedId === candidate.id}
                    disabled={candidate.alreadyLinked}
                    onChange={() => {
                      setSelectedId(candidate.id);
                      setConfirmCrossAxis(false);
                      setError(null);
                    }}
                  />
                  <span>
                    <span className="link-candidate-title">{candidate.title}</span>
                    <span className="block-help">
                      {[
                        stateText(candidate.state),
                        ...(candidate.crossAxis ? [uiMessage('alignment.link-dialogs.575')] : []),
                        ...(candidate.alreadyLinked
                          ? [uiMessage('alignment.link-dialogs.576')]
                          : []),
                      ].join(' · ')}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {candidates.status === 'ready' && candidates.result.total > items.length && (
          <p className="field-help">
            {uiMessage('actions-ui.320')}
            {items.length}
            {uiMessage('actions-ui.321')}
            {candidates.result.total}
            {uiMessage('alignment.link-dialogs.577')}
          </p>
        )}
      </fieldset>
      {selected !== null && (
        <p className="interval-summary link-preview" role="status">
          {previewText()}
        </p>
      )}
      {ready?.crossAxis === true && previewBlocker(ready, rule) === null && (
        <label className="check-row" htmlFor={`${idBase}-cross-axis`}>
          <input
            ref={crossAxisField}
            id={`${idBase}-cross-axis`}
            type="checkbox"
            checked={confirmCrossAxis}
            onChange={(event) => setConfirmCrossAxis(event.target.checked)}
          />
          <span>
            {uiMessage('actions-ui.227')}
            <span className="block-help">{uiMessage('alignment.link-dialogs.578')}</span>
          </span>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button type="submit" className="primary-button" disabled={runner.busy}>
          {runner.busy
            ? uiMessage('alignment.link-dialogs.579')
            : ready?.replaces !== undefined
              ? uiMessage('alignment.link-dialogs.580')
              : uiMessage('alignment.alignment-page.407')}
        </button>
      </div>
    </form>
  );
}

/* ───────────────────────── Unlink dialog ───────────────────────── */

export interface UnlinkDialogProps {
  readonly open: boolean;
  readonly focus: AlignmentNode;
  readonly edge: AlignmentEdge;
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}

/** Remove one link. Both objects stay exactly as they are; Undo restores the link. */
export function UnlinkDialog({ edge, focus, onClose, open, runner }: UnlinkDialogProps): ReactNode {
  const { child, parent } = linkEnds(focus, edge);
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('alignment.link-dialogs.588')}
      title={uiMessage('alignment.link-dialogs.581', { value0: child.title, value1: parent.title })}
      description={uiMessage('alignment.link-dialogs.582')}
      onClose={close}
    >
      {open && (
        <UnlinkBody edge={edge} focus={focus} runner={runner} onCancel={close} onDone={onClose} />
      )}
    </Modal>
  );
}

function UnlinkBody({
  edge,
  focus,
  onCancel,
  onDone,
  runner,
}: {
  readonly edge: AlignmentEdge;
  readonly focus: AlignmentNode;
  readonly runner: CommandRunner;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const container = useRef<HTMLDivElement>(null);
  useDialogAutofocus(container);
  const input = buildUnlinkInput(focus, edge);
  const { child, parent } = linkEnds(focus, edge);
  const confirm = async (): Promise<void> => {
    if (input === null) return;
    const done = await runner.run(
      () => alignment.unlink(input),
      uiMessage('alignment.link-dialogs.583', { value0: child.title, value1: parent.title }),
    );
    if (done) onDone();
  };
  return (
    <div ref={container}>
      <DialogError runner={runner} />
      {input === null && (
        <p className="warning-note">
          {edge.required
            ? uiMessage('alignment.link-dialogs.584')
            : uiMessage('alignment.link-dialogs.585')}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" data-autofocus onClick={onCancel}>
          {uiMessage('alignment.link-dialogs.586')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={runner.busy || input === null}
          onClick={() => void confirm()}
        >
          {runner.busy
            ? uiMessage('alignment.link-dialogs.587')
            : uiMessage('alignment.link-dialogs.588')}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Move a Milestone to another Outcome ───────────────────────── */

export interface ReparentMilestoneDialogProps {
  readonly open: boolean;
  readonly milestone: RevisionRef<'milestone'> & {
    readonly title: string;
    readonly outcomeId: string;
  };
  readonly runner: CommandRunner;
  readonly onClose: () => void;
}

/** A Milestone always belongs to one Outcome, so it is moved (reparented), never unlinked. */
export function ReparentMilestoneDialog({
  milestone,
  onClose,
  open,
  runner,
}: ReparentMilestoneDialogProps): ReactNode {
  const close = (): void => {
    runner.clearError();
    onClose();
  };
  return (
    <Modal
      open={open}
      eyebrow={uiMessage('actions-ui.276')}
      title={uiMessage('alignment.link-dialogs.589', { value0: milestone.title })}
      description={uiMessage('alignment.link-dialogs.590')}
      onClose={close}
    >
      {open && (
        <ReparentForm milestone={milestone} runner={runner} onCancel={close} onDone={onClose} />
      )}
    </Modal>
  );
}

function ReparentForm({
  milestone,
  onCancel,
  onDone,
  runner,
}: {
  readonly milestone: ReparentMilestoneDialogProps['milestone'];
  readonly runner: CommandRunner;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const alignment = useAlignment();
  const fieldId = useId();
  const field = useRef<HTMLSelectElement>(null);
  const [choices, setChoices] = useState<readonly AlignmentNode[] | 'loading' | 'error'>('loading');
  const [outcomeId, setOutcomeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    alignment.listChoices('outcome').then(
      (outcomes) => {
        if (live)
          setChoices(
            outcomes.filter((outcome) => outcome.id !== milestone.outcomeId && !outcome.archived),
          );
      },
      () => {
        if (live) setChoices('error');
      },
    );
    return () => {
      live = false;
    };
  }, [alignment, milestone.outcomeId]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const target =
      typeof choices === 'string' ? undefined : choices.find((outcome) => outcome.id === outcomeId);
    if (target === undefined) {
      setError(uiMessage('alignment.link-dialogs.591'));
      field.current?.focus();
      return;
    }
    setError(null);
    const done = await runner.run(
      () =>
        alignment.reparentMilestone(
          { kind: 'milestone', id: milestone.id, revision: milestone.revision },
          target.id,
        ),
      uiMessage('alignment.link-dialogs.592', { value0: milestone.title, value1: target.title }),
    );
    if (done) onDone();
  };
  return (
    <form noValidate onSubmit={(event) => void submit(event)}>
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <DialogError runner={runner} />
      {choices === 'loading' ? (
        <p className="field-help" role="status">
          {uiMessage('alignment.link-dialogs.593')}
        </p>
      ) : choices === 'error' ? (
        <p className="validation-summary" role="alert">
          {uiMessage('alignment.link-dialogs.594')}
        </p>
      ) : choices.length === 0 ? (
        <p className="quiet-empty">{uiMessage('alignment.link-dialogs.595')}</p>
      ) : (
        <label className="field-label" htmlFor={fieldId}>
          {uiMessage('alignment.link-dialogs.596')}
          <select
            ref={field}
            id={fieldId}
            value={outcomeId}
            aria-invalid={error !== null}
            onChange={(event) => {
              setOutcomeId(event.target.value);
              setError(null);
            }}
          >
            <option value="">{uiMessage('alignment.link-dialogs.597')}</option>
            {choices.map((outcome) => (
              <option key={outcome.id} value={outcome.id}>
                {outcome.state === 'active'
                  ? outcome.title
                  : `${outcome.title} (${stateText(outcome.state)})`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          type="submit"
          className="primary-button"
          disabled={runner.busy || typeof choices === 'string' || choices.length === 0}
        >
          {runner.busy
            ? uiMessage('alignment.link-dialogs.598')
            : uiMessage('alignment.link-dialogs.599')}
        </button>
      </div>
    </form>
  );
}
