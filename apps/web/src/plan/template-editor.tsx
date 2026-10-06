import { message as uiMessage } from '../messages';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type { ApplicationError, CommandReceipt } from '@yelaxis/application';
import {
  templateLimits,
  templateParentKinds,
  type TemplateBlueprint,
  type TemplateBlueprintItemV2,
  type TemplateItemKind,
} from '@yelaxis/domain';

import { applicationErrorMessage } from './format';
import type { CommandRunner } from './planning-context';
import { usePlanning } from './planning-context';
import { runCommand } from './routine-form';
import { useUnsavedGuard } from './unsaved-guard';
import './templates.css';

export const templateKindLabels: Readonly<Record<TemplateItemKind, string>> = {
  axis: uiMessage('actions-ui.251'),
  outcome: uiMessage('alignment.milestone-detail.607'),
  milestone: uiMessage('actions-ui.276'),
  project: uiMessage('actions-ui.254'),
  action: uiMessage('actions-ui.282'),
  note: uiMessage('plan.routines.1606'),
  routine: uiMessage('plan.routine-form.1531'),
  commitment: uiMessage('plan.template-editor.1718'),
};

const placeableKinds: readonly TemplateItemKind[] = [
  'outcome',
  'milestone',
  'project',
  'action',
  'commitment',
];
const timedKinds: readonly TemplateItemKind[] = ['action', 'commitment'];
const editableKinds: readonly TemplateItemKind[] = ['action', 'note', 'project'];

const templateReasons: Readonly<Record<string, string>> = {
  shape: uiMessage('plan.template-editor.1719'),
  unsupported_version: uiMessage('plan.template-editor.1720'),
  item_count: uiMessage('plan.template-editor.1721'),
  template_key: uiMessage('plan.template-editor.1722'),
  unknown_field: uiMessage('plan.template-editor.1723'),
  kind: uiMessage('plan.template-editor.1724'),
  title: uiMessage('plan.template-editor.1725'),
  parent: uiMessage('plan.template-editor.1726'),
  note: uiMessage('plan.template-editor.1727'),
  estimate_minutes: uiMessage('plan.routine-form.1426'),
  energy: uiMessage('plan.template-editor.1728'),
  priority: uiMessage('plan.template-editor.1729'),
  relative_day_offset: uiMessage('plan.template-editor.1730'),
  local_start_time: uiMessage('plan.template-editor.1731'),
  local_start_time_requires_offset: uiMessage('plan.template-editor.1732'),
  duration_minutes: uiMessage('plan.template-editor.1733'),
  duration_requires_start_time: uiMessage('plan.template-editor.1734'),
  scheduling_not_supported: uiMessage('plan.template-editor.1735'),
  time_not_supported: uiMessage('plan.template-editor.1736'),
  duplicate_template_key: uiMessage('plan.template-editor.1737'),
  milestone_requires_outcome: uiMessage('plan.template-editor.1738'),
  dangling_parent: uiMessage('plan.template-editor.1739'),
  parent_kind: uiMessage('plan.template-editor.1740'),
};

/** Template command errors in words, naming the item when the domain reports it. */
export function templateErrorMessage(
  error: ApplicationError,
  titles: ReadonlyMap<string, string> = new Map(),
): string {
  if (error.code === 'domain_rejected') {
    const details = error.domainError.details;
    const reason = details?.['reason'];
    const key = details?.['templateKey'];
    if (typeof reason === 'string' && templateReasons[reason] !== undefined) {
      const title = typeof key === 'string' ? titles.get(key) : undefined;
      return title === undefined
        ? (templateReasons[reason] ?? '')
        : `${title}: ${templateReasons[reason] ?? ''}`;
    }
  }
  return applicationErrorMessage(error);
}

/** Id of the template a command created or changed, from its receipt. */
export function templateIdFrom(receipt: CommandReceipt | undefined): string | undefined {
  return receipt?.canonical.find((change) => change.ref.type === 'template')?.ref.id;
}

interface EditorItem {
  readonly key: string;
  readonly kind: TemplateItemKind;
  readonly title: string;
  readonly parentKey: string;
  readonly note: string;
  readonly estimate: string;
  readonly energy: string;
  readonly priority: string;
  readonly dayOffset: string;
  readonly startTime: string;
  readonly duration: string;
}

function editorItems(blueprint: TemplateBlueprint | undefined): EditorItem[] {
  if (blueprint === undefined) return [];
  return blueprint.items.map((item) => {
    const scheduled: Partial<TemplateBlueprintItemV2> = blueprint.version === 2 ? item : {};
    return {
      key: item.templateKey,
      kind: item.kind,
      title: item.title,
      parentKey: item.parentTemplateKey ?? '',
      note: item.note ?? '',
      estimate: item.estimateMinutes?.toString() ?? '',
      energy: item.energy ?? '',
      priority: item.priority ?? '',
      dayOffset: scheduled.relativeDayOffset?.toString() ?? '',
      startTime: scheduled.localStartTime ?? '',
      duration: scheduled.durationMinutes?.toString() ?? '',
    };
  });
}

const integer = (value: string): number | null =>
  /^-?\d+$/u.test(value.trim()) ? Number(value.trim()) : null;

function buildBlueprint(
  items: readonly EditorItem[],
): { readonly ok: true; readonly blueprint: unknown } | { readonly ok: false; errors: string[] } {
  const errors: string[] = [];
  if (items.length === 0) errors.push(uiMessage('plan.template-editor.1741'));
  if (items.length > 50) errors.push(uiMessage('plan.template-editor.1742'));
  const built = items.map((item, index) => {
    const name =
      item.title.trim() === ''
        ? uiMessage('plan.template-editor.1743', { value0: String(index + 1) })
        : item.title.trim();
    if (item.title.trim() === '')
      errors.push(uiMessage('plan.template-editor.1744', { value0: String(index + 1) }));
    else if (item.title.trim().length > 200)
      errors.push(uiMessage('plan.template-editor.1745', { value0: name }));
    const estimate = item.estimate.trim() === '' ? undefined : integer(item.estimate);
    if (estimate === null || (estimate !== undefined && (estimate < 1 || estimate > 10080)))
      errors.push(uiMessage('plan.template-editor.1746', { value0: name }));
    const offset = item.dayOffset.trim() === '' ? undefined : integer(item.dayOffset);
    if (offset === null || (offset !== undefined && Math.abs(offset) > 365))
      errors.push(uiMessage('plan.template-editor.1747', { value0: name }));
    const duration = item.duration.trim() === '' ? undefined : integer(item.duration);
    if (
      duration === null ||
      (duration !== undefined &&
        (duration < templateLimits.minDurationMinutes || duration > templateLimits.durationMinutes))
    )
      errors.push(uiMessage('plan.template-editor.1748', { value0: name }));
    const start = item.startTime.trim();
    if (start !== '' && offset === undefined)
      errors.push(uiMessage('plan.template-editor.1749', { value0: name }));
    if (duration !== undefined && start === '')
      errors.push(uiMessage('plan.template-editor.1750', { value0: name }));
    if (start !== '' && duration === undefined)
      errors.push(uiMessage('plan.template-editor.1751', { value0: name }));
    return {
      templateKey: item.key,
      kind: item.kind,
      title: item.title.trim(),
      ...(item.parentKey === '' ? {} : { parentTemplateKey: item.parentKey }),
      ...(item.note.trim() === '' ? {} : { note: item.note }),
      ...(typeof estimate === 'number' ? { estimateMinutes: estimate } : {}),
      ...(item.energy === '' ? {} : { energy: item.energy }),
      ...(item.priority === '' ? {} : { priority: item.priority }),
      ...(typeof offset === 'number' ? { relativeDayOffset: offset } : {}),
      ...(start === '' ? {} : { localStartTime: start }),
      ...(typeof duration === 'number' ? { durationMinutes: duration } : {}),
    };
  });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, blueprint: { version: 2, items: built } };
}

function nextKey(items: readonly EditorItem[], kind: TemplateItemKind): string {
  const used = new Set(items.map((item) => item.key));
  for (let index = items.length + 1; ; index += 1) {
    const key = `${kind}-${String(index)}`;
    if (!used.has(key)) return key;
  }
}

/**
 * Editor for a user-owned template. Saving goes through `saveTemplate`, which validates the
 * blueprint in the domain; reasons are shown in words. Leaving with unsaved edits asks first.
 */
export function TemplateEditor({
  blueprint,
  initialTitle,
  onCancel,
  onSaved,
  revision,
  runner,
  templateId,
}: {
  readonly blueprint?: TemplateBlueprint;
  readonly initialTitle: string;
  readonly onCancel: () => void;
  readonly onSaved: (templateId: string | undefined) => void;
  readonly revision?: number;
  readonly runner: CommandRunner;
  readonly templateId?: string;
}): ReactNode {
  const planning = usePlanning();
  const headingId = useId();
  const [title, setTitle] = useState(initialTitle);
  const [items, setItems] = useState<EditorItem[]>(() => editorItems(blueprint));
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify({ title: initialTitle, items: editorItems(blueprint) }),
  );
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify({ title, items }) !== baseline;
  const titles = new Map(items.map((item) => [item.key, item.title.trim() || item.key]));

  const save = async (): Promise<boolean> => {
    if (busy) return false;
    const problems: string[] = [];
    if (title.trim().length === 0) problems.push(uiMessage('plan.template-editor.1752'));
    else if (title.trim().length > 200) problems.push(uiMessage('plan.template-editor.1753'));
    const built = buildBlueprint(items);
    if (!built.ok) problems.push(...built.errors);
    if (problems.length > 0 || !built.ok) {
      setErrors(problems);
      return false;
    }
    setBusy(true);
    setErrors([]);
    const result = await runCommand(
      runner,
      () =>
        planning.saveTemplate({
          ...(templateId === undefined ? {} : { templateId }),
          ...(revision === undefined ? {} : { revision }),
          title: title.trim(),
          blueprint: built.blueprint,
        }),
      uiMessage('plan.template-editor.1754'),
      (error) => templateErrorMessage(error, titles),
    );
    setBusy(false);
    if (result.message !== null) {
      setErrors([result.message]);
      return false;
    }
    setBaseline(JSON.stringify({ title, items }));
    onSaved(templateIdFrom(result.receipt) ?? templateId);
    return true;
  };
  const { dialog, guard } = useUnsavedGuard(dirty, save);

  const update = (index: number, patch: Partial<EditorItem>): void =>
    setItems((current) =>
      current.map((item, position) => (position === index ? { ...item, ...patch } : item)),
    );
  const add = (kind: TemplateItemKind): void => {
    setItems((current) => [
      ...current,
      {
        key: nextKey(current, kind),
        kind,
        title: '',
        parentKey: '',
        note: '',
        estimate: '',
        energy: '',
        priority: '',
        dayOffset: '',
        startTime: '',
        duration: '',
      },
    ]);
    setAnnouncement(uiMessage('plan.template-editor.1755', { value0: templateKindLabels[kind] }));
    window.requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll<HTMLInputElement>('input[data-item-title]');
      inputs?.[inputs.length - 1]?.focus();
    });
  };
  const remove = (index: number): void => {
    const removed = items[index];
    if (removed === undefined) return;
    setItems((current) =>
      current
        .filter((_, position) => position !== index)
        .map((item) => (item.parentKey === removed.key ? { ...item, parentKey: '' } : item)),
    );
    setAnnouncement(
      uiMessage('plan.template-editor.1756', {
        value0: removed.title.trim() || templateKindLabels[removed.kind],
      }),
    );
    window.requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll<HTMLInputElement>('input[data-item-title]');
      const next = inputs?.[Math.min(index, (inputs.length || 1) - 1)];
      if (next !== undefined) next.focus();
      else addRef.current?.querySelector('button')?.focus();
    });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void save();
  };

  return (
    <section className="template-editor" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {templateId === undefined
          ? uiMessage('plan.template-editor.1757')
          : uiMessage('plan.template-editor.1758')}
      </h2>
      <p className="field-help">{uiMessage('plan.template-editor.1759')}</p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <form className="plan-form" noValidate onSubmit={submit}>
        {errors.length > 0 && (
          <div className="validation-summary" role="alert">
            <p>
              <strong>{uiMessage('plan.template-editor.1760')}</strong>
            </p>
            <ul>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}
        <label className="field-label">
          {uiMessage('plan.template-editor.1761')}
          <span>{uiMessage('actions-ui.326')}</span>
          <input
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {items.length === 0 ? (
          <p className="quiet-empty">{uiMessage('plan.template-editor.1762')}</p>
        ) : (
          <ol className="template-editor-items" ref={listRef}>
            {items.map((item, index) => (
              <EditorItemFields
                key={item.key}
                item={item}
                index={index}
                items={items}
                onChange={(patch) => update(index, patch)}
                onRemove={() => remove(index)}
              />
            ))}
          </ol>
        )}
        <div
          className="template-editor-add"
          role="group"
          aria-label={uiMessage('plan.template-editor.1763')}
          ref={addRef}
        >
          <button type="button" onClick={() => add('action')}>
            {uiMessage('plan.template-editor.1764')}
          </button>
          <button type="button" onClick={() => add('note')}>
            {uiMessage('plan.template-editor.1765')}
          </button>
          <button type="button" onClick={() => add('project')}>
            {uiMessage('plan.template-editor.1766')}
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={() => guard(onCancel)}>
            {uiMessage('account.account-dialogs.20')}
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy
              ? uiMessage('account.conflicts-page.133')
              : uiMessage('plan.scheduling-dialogs.1717')}
          </button>
        </div>
      </form>
      {dialog}
    </section>
  );
}

function EditorItemFields({
  index,
  item,
  items,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly item: EditorItem;
  readonly items: readonly EditorItem[];
  readonly onChange: (patch: Partial<EditorItem>) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const allowedParents = templateParentKinds[item.kind];
  const parents = items.filter(
    (candidate) => candidate.key !== item.key && allowedParents.includes(candidate.kind),
  );
  const kinds = editableKinds.includes(item.kind) ? editableKinds : [...editableKinds, item.kind];
  const placeable = placeableKinds.includes(item.kind);
  const timed = timedKinds.includes(item.kind);
  const name =
    item.title.trim() === ''
      ? uiMessage('plan.template-editor.1767', { value0: String(index + 1) })
      : item.title.trim();
  return (
    <li className="template-editor-item">
      <fieldset>
        <legend>
          {uiMessage('plan.template-editor.1768')}
          {index + 1}: {templateKindLabels[item.kind]}
        </legend>
        <div className="two-column-fields">
          <label className="field-label">
            {uiMessage('actions-ui.325')}
            <span>{uiMessage('plan.template-editor.1769')}</span>
            <input
              data-item-title
              required
              maxLength={200}
              value={item.title}
              onChange={(event) => onChange({ title: event.target.value })}
            />
          </label>
          <label className="field-label">
            {uiMessage('plan.template-editor.1770')}
            <select
              value={item.kind}
              onChange={(event) => {
                const kind = event.target.value as TemplateItemKind;
                onChange({
                  kind,
                  parentKey: '',
                  ...(placeableKinds.includes(kind) ? {} : { dayOffset: '' }),
                  ...(timedKinds.includes(kind) ? {} : { startTime: '', duration: '' }),
                });
              }}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {templateKindLabels[kind]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field-label">
          {uiMessage('plan.template-editor.1771')}
          <span>{uiMessage('alignment.object-forms.664')}</span>
          <select
            value={item.parentKey}
            disabled={parents.length === 0 && item.parentKey === ''}
            onChange={(event) => onChange({ parentKey: event.target.value })}
          >
            <option value="">{uiMessage('plan.template-editor.1772')}</option>
            {parents.map((parent) => (
              <option key={parent.key} value={parent.key}>
                {templateKindLabels[parent.kind]}: {parent.title.trim() || parent.key}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          {uiMessage('actions-ui.327')}
          <span>{uiMessage('alignment.object-forms.664')}</span>
          <textarea
            rows={2}
            maxLength={10000}
            value={item.note}
            onChange={(event) => onChange({ note: event.target.value })}
          />
        </label>
        <div className="three-column-fields">
          <label className="field-label">
            {uiMessage('actions-ui.335')}
            <span>{uiMessage('plan.capacity-settings.1205')}</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="10080"
              value={item.estimate}
              onChange={(event) => onChange({ estimate: event.target.value })}
            />
          </label>
          <label className="field-label">
            {uiMessage('actions-ui.337')}
            <select
              value={item.energy}
              onChange={(event) => onChange({ energy: event.target.value })}
            >
              <option value="">{uiMessage('actions-ui.338')}</option>
              <option value="low">{uiMessage('actions-ui.339')}</option>
              <option value="medium">{uiMessage('actions-ui.340')}</option>
              <option value="high">{uiMessage('actions-ui.341')}</option>
              <option value="focused">{uiMessage('actions-ui.342')}</option>
            </select>
          </label>
          <label className="field-label">
            {uiMessage('actions-ui.343')}
            <select
              value={item.priority}
              onChange={(event) => onChange({ priority: event.target.value })}
            >
              <option value="">{uiMessage('actions-ui.344')}</option>
              <option value="low">{uiMessage('actions-ui.339')}</option>
              <option value="normal">{uiMessage('actions-ui.345')}</option>
              <option value="high">{uiMessage('actions-ui.341')}</option>
            </select>
          </label>
        </div>
        {placeable ? (
          <div className="three-column-fields">
            <label className="field-label">
              {uiMessage('plan.template-editor.1773')}
              <span>{uiMessage('plan.template-editor.1774')}</span>
              <input
                type="number"
                inputMode="numeric"
                min="-365"
                max="365"
                value={item.dayOffset}
                onChange={(event) => onChange({ dayOffset: event.target.value })}
              />
            </label>
            {timed && (
              <>
                <label className="field-label">
                  {uiMessage('plan.template-editor.1775')}
                  <span>{uiMessage('plan.template-editor.1776')}</span>
                  <input
                    type="time"
                    value={item.startTime}
                    onChange={(event) => onChange({ startTime: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  {uiMessage('plan.routine-form.1498')}
                  <span>{uiMessage('plan.template-editor.1777')}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={templateLimits.minDurationMinutes}
                    max={templateLimits.durationMinutes}
                    value={item.duration}
                    onChange={(event) => onChange({ duration: event.target.value })}
                  />
                </label>
              </>
            )}
          </div>
        ) : (
          <p className="field-help">
            {templateKindLabels[item.kind]}
            {uiMessage('plan.template-editor.1778')}
          </p>
        )}
        <button type="button" className="text-button" onClick={onRemove}>
          {uiMessage('plan.plan-week.1373')}
          {name}
        </button>
      </fieldset>
    </li>
  );
}
