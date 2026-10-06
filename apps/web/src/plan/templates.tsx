import { message as uiMessage } from '../messages';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import type {
  PlanProfile,
  TemplateApplicationPreview,
  TemplateDetail,
  TemplateListItem,
} from '@yelaxis/application';
import type { TemplatePreviewIssue, TemplatePreviewItem } from '@yelaxis/domain';
import { exportTemplate } from '@yelaxis/application';
import { saveFile } from '../account/download';

import { formatDate, formatMonth, formatWallTime } from './format';
import { Modal } from './modal';
import {
  CommandFeedback,
  useCommandRunner,
  usePlanning,
  usePlanQuery,
  usePlanningToday,
  type CommandRunner,
} from './planning-context';
import { runCommand, useDialogAutofocus, usePlanProfile, ZonePicker } from './routine-form';
import { planPath, templatePath, templatesPath } from './routes';
import {
  TemplateEditor,
  templateErrorMessage,
  templateIdFrom,
  templateKindLabels,
} from './template-editor';
import './templates.css';

const newTemplateId = 'new';

const itemCountText = (count: number): string =>
  `${String(count)} ${count === 1 ? 'item' : 'items'}`;

/* ───────────────────────── Templates list ───────────────────────── */

export function TemplatesPage(): ReactNode {
  const planning = usePlanning();
  const runner = useCommandRunner();
  const [showArchived, setShowArchived] = useState(false);
  const [duplicating, setDuplicating] = useState<TemplateListItem | null>(null);
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const { state, reload } = usePlanQuery(
    () => planning.listTemplates({ includeArchived: showArchived }),
    [planning, showArchived],
  );
  const starters =
    state.status === 'ready' ? state.data.filter((t) => t.source === 'built_in') : [];
  const own = state.status === 'ready' ? state.data.filter((t) => t.source === 'user') : [];
  return (
    <section
      className="content-section templates-page"
      aria-labelledby="page-title"
      aria-busy={state.status === 'loading' || runner.busy}
    >
      <Link className="back-link" to="/plan">
        {uiMessage('plan.routines.1544')}
      </Link>
      <p className="eyebrow">{uiMessage('actions-ui.250')}</p>
      <h1 id="page-title">{uiMessage('plan.plan-shell.1342')}</h1>
      <p className="page-message">{uiMessage('plan.templates.1779')}</p>
      <CommandFeedback runner={runner} />
      {created !== null && runner.undoId !== null && (
        <p className="field-help">
          <Link to={templatePath(created.id)}>
            {uiMessage('notifications.notifications-page.991')}
            {created.title}
          </Link>
        </p>
      )}
      {state.status === 'loading' && (
        <p className="page-message">{uiMessage('plan.templates.1780')}</p>
      )}
      {state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          <section className="template-group" aria-labelledby="starter-templates-title">
            <h2 id="starter-templates-title">{uiMessage('plan.templates.1781')}</h2>
            {starters.length === 0 ? (
              <p className="field-help">{uiMessage('plan.templates.1782')}</p>
            ) : (
              <ul className="template-list">
                {starters.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    runner={runner}
                    onDuplicate={() => setDuplicating(template)}
                  />
                ))}
              </ul>
            )}
          </section>
          <section className="template-group" aria-labelledby="own-templates-title">
            <div className="template-group-heading">
              <h2 id="own-templates-title">{uiMessage('plan.templates.1783')}</h2>
              <div className="template-toolbar">
                <Link className="inline-button" to={templatePath(newTemplateId)}>
                  {uiMessage('plan.template-editor.1757')}
                </Link>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(event) => setShowArchived(event.target.checked)}
                  />
                  {uiMessage('plan.templates.1784')}
                </label>
              </div>
            </div>
            {own.length === 0 ? (
              <div className="quiet-empty">
                <p>{uiMessage('plan.templates.1785')}</p>
              </div>
            ) : (
              <ul className="template-list">
                {own.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    runner={runner}
                    onDuplicate={() => setDuplicating(template)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <Modal
        open={duplicating !== null}
        eyebrow={uiMessage('plan.plan-shell.1342')}
        title={uiMessage('plan.templates.1786')}
        description={uiMessage('plan.templates.1787')}
        onClose={() => setDuplicating(null)}
      >
        {duplicating !== null && (
          <DuplicateForm
            template={duplicating}
            runner={runner}
            onCancel={() => setDuplicating(null)}
            onDone={(id, title) => {
              setDuplicating(null);
              if (id !== undefined) setCreated({ id, title });
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function TemplateCard({
  onDuplicate,
  runner,
  template,
}: {
  readonly onDuplicate: () => void;
  readonly runner: CommandRunner;
  readonly template: TemplateListItem;
}): ReactNode {
  const planning = usePlanning();
  const archived = template.state === 'archived';
  const revision = template.localRevision;
  return (
    <li className="template-card">
      <div className="template-card-heading">
        <h3>{template.title}</h3>
        <span className="status-pill">
          {archived ? uiMessage('alignment.alignment-page.405') : itemCountText(template.itemCount)}
        </span>
      </div>
      {template.description !== undefined && <p>{template.description}</p>}
      {archived && <p className="field-help">{itemCountText(template.itemCount)}</p>}
      <div className="template-card-actions">
        {!archived && (
          <Link
            className="inline-button"
            to={templatePath(template.id)}
            aria-label={uiMessage('plan.templates.1788', { value0: template.title })}
          >
            {uiMessage('plan.templates.1789')}
          </Link>
        )}
        <button
          type="button"
          disabled={runner.busy}
          onClick={onDuplicate}
          aria-label={uiMessage('plan.templates.1790', { value0: template.title })}
        >
          {uiMessage('plan.templates.1786')}
        </button>
        {template.source === 'user' && !archived && (
          <Link
            className="inline-button"
            to={`${templatePath(template.id)}?edit=1`}
            aria-label={uiMessage('plan.capacity-settings.1190', { value0: template.title })}
          >
            {uiMessage('plan.capacity-settings.1191')}
          </Link>
        )}
        {template.source === 'user' && revision !== undefined && (
          <button
            type="button"
            disabled={runner.busy}
            aria-label={`${archived ? uiMessage('actions-ui.298') : uiMessage('actions-ui.258')} ${template.title}`}
            onClick={() =>
              void runner.run(
                () =>
                  archived
                    ? planning.restoreTemplate({ templateId: template.id, revision })
                    : planning.archiveTemplate({ templateId: template.id, revision }),
                archived ? uiMessage('plan.templates.1791') : uiMessage('plan.templates.1792'),
              )
            }
          >
            {archived ? uiMessage('actions-ui.298') : uiMessage('actions-ui.258')}
          </button>
        )}
      </div>
    </li>
  );
}

function DuplicateForm({
  onCancel,
  onDone,
  runner,
  template,
}: {
  readonly onCancel: () => void;
  readonly onDone: (id: string | undefined, title: string) => void;
  readonly runner: CommandRunner;
  readonly template: Pick<TemplateListItem, 'id' | 'title'>;
}): ReactNode {
  const planning = usePlanning();
  const [title, setTitle] = useState(`${template.title} (copy)`.slice(0, 200));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autofocusRef = useDialogAutofocus();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      setError(uiMessage('plan.routine-form.1459'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await runCommand(
      runner,
      () => planning.duplicateTemplate({ templateId: template.id, title: trimmed }),
      uiMessage('plan.templates.1793'),
      (failure) => templateErrorMessage(failure),
    );
    setBusy(false);
    if (result.message === null) onDone(templateIdFrom(result.receipt), trimmed);
    else setError(result.message);
  };
  return (
    <form
      ref={autofocusRef}
      className="plan-form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      {error !== null && (
        <p className="validation-summary" role="alert">
          {error}
        </p>
      )}
      <label className="field-label">
        {uiMessage('plan.templates.1794')}
        <span>{uiMessage('actions-ui.326')}</span>
        <input
          data-autofocus
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? uiMessage('account.conflicts-page.133') : uiMessage('plan.templates.1795')}
        </button>
      </div>
    </form>
  );
}

/* ───────────────────────── Template detail ───────────────────────── */

export function TemplateDetailPage(): ReactNode {
  const { templateId = '' } = useParams();
  return templateId === newTemplateId ? (
    <NewTemplatePage />
  ) : (
    <ExistingTemplatePage key={templateId} templateId={templateId} />
  );
}

function NewTemplatePage(): ReactNode {
  const runner = useCommandRunner();
  const navigate = useNavigate();
  return (
    <section className="content-section template-detail" aria-labelledby="page-title">
      <Link className="back-link" to={templatesPath}>
        {uiMessage('plan.templates.1796')}
      </Link>
      <p className="eyebrow">{uiMessage('plan.templates.1797')}</p>
      <h1 id="page-title">{uiMessage('plan.template-editor.1757')}</h1>
      <CommandFeedback runner={runner} />
      <TemplateEditor
        initialTitle=""
        runner={runner}
        onCancel={() => void navigate(templatesPath)}
        onSaved={(id) => void navigate(id === undefined ? templatesPath : templatePath(id))}
      />
    </section>
  );
}

function ExistingTemplatePage({ templateId }: { readonly templateId: string }): ReactNode {
  const planning = usePlanning();
  const runner = useCommandRunner();
  const profile = usePlanProfile(planning);
  const [searchParams, setSearchParams] = useSearchParams();
  const editing = searchParams.get('edit') === '1';
  const [duplicating, setDuplicating] = useState(false);
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
  const { state, reload } = usePlanQuery(
    () => planning.getTemplate(templateId),
    [planning, templateId],
  );
  const setEditing = (value: boolean): void =>
    setSearchParams(value ? { edit: '1' } : {}, { replace: true });
  if (state.status === 'loading')
    return (
      <section className="content-section template-detail" aria-busy="true">
        <p className="eyebrow">{uiMessage('plan.templates.1798')}</p>
        <h1>{uiMessage('plan.templates.1799')}</h1>
      </section>
    );
  if (state.status === 'error')
    return (
      <section className="content-section template-detail" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('plan.templates.1798')}</p>
        <h1 id="page-title">{uiMessage('plan.templates.1800')}</h1>
        <p className="validation-summary" role="alert">
          {state.message}
        </p>
        <button type="button" onClick={() => void reload()}>
          {uiMessage('account.account-dialogs.47')}
        </button>
      </section>
    );
  if (state.data === null)
    return (
      <section className="content-section template-detail" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('plan.templates.1798')}</p>
        <h1 id="page-title">{uiMessage('plan.templates.1801')}</h1>
        <p className="page-message">{uiMessage('plan.templates.1802')}</p>
        <Link className="inline-button" to={templatesPath}>
          {uiMessage('plan.templates.1803')}
        </Link>
      </section>
    );
  const template = state.data;
  const builtIn = template.source === 'built_in';
  const archived = template.state === 'archived';
  const revision = template.localRevision;
  return (
    <section
      className="content-section template-detail"
      aria-labelledby="page-title"
      aria-busy={runner.busy || state.refreshing}
    >
      <Link className="back-link" to={templatesPath}>
        {uiMessage('plan.templates.1796')}
      </Link>
      <p className="eyebrow">
        {builtIn ? uiMessage('plan.templates.1804') : uiMessage('plan.templates.1797')}
        {archived ? uiMessage('plan.templates.2475') : ''}
      </p>
      <h1 id="page-title">{template.title}</h1>
      {template.description !== undefined && <p className="page-message">{template.description}</p>}
      <CommandFeedback runner={runner} />
      {created !== null && runner.undoId !== null && (
        <p className="field-help">
          <Link to={templatePath(created.id)}>
            {uiMessage('notifications.notifications-page.991')}
            {created.title}
          </Link>
        </p>
      )}
      {builtIn && <p className="quiet-empty">{uiMessage('plan.templates.1805')}</p>}
      {archived && <p className="quiet-empty">{uiMessage('plan.templates.1806')}</p>}
      <div className="detail-actions template-actions">
        <button
          type="button"
          disabled={runner.busy}
          onClick={() =>
            saveFile({
              fileName: 'yelaxis-template.json',
              blob: new Blob([exportTemplate(template.title, template.blueprint)], {
                type: 'application/json;charset=utf-8',
              }),
            })
          }
        >
          {uiMessage('plan.templates.1807')}
        </button>
        <button type="button" disabled={runner.busy} onClick={() => setDuplicating(true)}>
          {uiMessage('plan.templates.1786')}
        </button>
        {!builtIn && !archived && !editing && (
          <button type="button" disabled={runner.busy} onClick={() => setEditing(true)}>
            {uiMessage('plan.template-editor.1758')}
          </button>
        )}
        {!builtIn && revision !== undefined && (
          <button
            type="button"
            disabled={runner.busy}
            onClick={() =>
              void runner.run(
                () =>
                  archived
                    ? planning.restoreTemplate({ templateId: template.id, revision })
                    : planning.archiveTemplate({ templateId: template.id, revision }),
                archived ? uiMessage('plan.templates.1791') : uiMessage('plan.templates.1792'),
              )
            }
          >
            {archived ? uiMessage('actions-ui.298') : uiMessage('actions-ui.258')}
          </button>
        )}
      </div>
      {editing && !builtIn && !archived ? (
        <TemplateEditor
          key={`${template.id}:${String(revision ?? 0)}`}
          templateId={template.id}
          {...(revision === undefined ? {} : { revision })}
          initialTitle={template.title}
          blueprint={template.blueprint}
          runner={runner}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : archived ? null : (
        <ApplyPanel template={template} profile={profile} runner={runner} />
      )}
      <Modal
        open={duplicating}
        eyebrow={uiMessage('plan.plan-shell.1342')}
        title={uiMessage('plan.templates.1786')}
        description={uiMessage('plan.templates.1787')}
        onClose={() => setDuplicating(false)}
      >
        <DuplicateForm
          template={template}
          runner={runner}
          onCancel={() => setDuplicating(false)}
          onDone={(id, title) => {
            setDuplicating(false);
            if (id !== undefined) setCreated({ id, title });
          }}
        />
      </Modal>
    </section>
  );
}

/* ───────────────────────── Apply panel ───────────────────────── */

type PreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: TemplateApplicationPreview }
  | { readonly status: 'error'; readonly message: string };

/** One blocking issue in words. */
export function issueMessage(
  issue: TemplatePreviewIssue,
  titles: ReadonlyMap<string, string>,
): string {
  const title = (key: string | undefined): string =>
    key === undefined
      ? uiMessage('plan.templates.1808')
      : (titles.get(key) ?? uiMessage('plan.templates.1808'));
  switch (issue.code) {
    case 'nothing_selected':
      return uiMessage('plan.templates.1809');
    case 'parent_deselected':
      return uiMessage('plan.templates.1810', {
        value0: title(issue.templateKey),
        value1: title(issue.parentTemplateKey),
      });
    case 'unsupported_kind':
      return uiMessage('plan.templates.1811');
    case 'success_definition_required':
      return uiMessage('plan.templates.1812', { value0: title(issue.templateKey) });
    case 'checkpoint_required':
      return uiMessage('plan.templates.1813', { value0: title(issue.templateKey) });
    case 'commitment_time_required':
      return uiMessage('plan.templates.1814', { value0: title(issue.templateKey) });
    case 'duration_required':
      return uiMessage('plan.templates.1815', { value0: title(issue.templateKey) });
  }
}

function scheduleText(
  item: TemplatePreviewItem,
  zone: string,
  timeFormat: PlanProfile['timeFormat'],
): { readonly text: string; readonly note?: string } {
  const schedule = item.schedule;
  switch (schedule.kind) {
    case 'unscheduled':
      return {
        text:
          item.kind === 'action'
            ? uiMessage('plan.templates.1816')
            : uiMessage('plan.templates.1817'),
      };
    case 'date':
      if (schedule.placement === 'day')
        return {
          text: uiMessage('plan.templates.1818', { value0: formatDate(schedule.date, 'weekday') }),
        };
      if (schedule.placement === 'week')
        return {
          text: uiMessage('plan.templates.1819', { value0: formatDate(schedule.date, 'weekday') }),
        };
      return {
        text: uiMessage('alignment.outcome-detail.716', {
          value0: formatMonth(schedule.date.slice(0, 7)),
        }),
      };
    case 'timed': {
      const endsLater =
        schedule.endDate === schedule.date
          ? ''
          : uiMessage('plan.templates.1820', { value0: formatDate(schedule.endDate, 'weekday') });
      const text = uiMessage('plan.templates.1821', {
        value0: formatDate(schedule.date, 'weekday'),
        value1: formatWallTime(schedule.localStart, timeFormat),
        value2: formatWallTime(schedule.localEnd, timeFormat),
        value3: endsLater,
        value4: zone.replace(/_/gu, ' '),
        value5: schedule.utcOffset,
      });
      if (schedule.adjustment === 'dst_gap_shifted')
        return {
          text,
          note: uiMessage('plan.templates.1822', {
            value0: formatWallTime(schedule.localStart, timeFormat),
          }),
        };
      if (schedule.adjustment === 'dst_repeated_earlier')
        return {
          text,
          note: uiMessage('plan.templates.1823'),
        };
      return { text };
    }
  }
}

function depthOf(
  item: TemplatePreviewItem,
  byKey: ReadonlyMap<string, TemplatePreviewItem>,
): number {
  let depth = 0;
  let parent = item.parentTemplateKey;
  const seen = new Set<string>();
  while (parent !== undefined && !seen.has(parent) && depth < 6) {
    seen.add(parent);
    depth += 1;
    parent = byKey.get(parent)?.parentTemplateKey;
  }
  return depth;
}

function ApplyPanel({
  profile,
  runner,
  template,
}: {
  readonly profile: PlanProfile | null;
  readonly runner: CommandRunner;
  readonly template: TemplateDetail;
}): ReactNode {
  const planning = usePlanning();
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Follows planning-zone today until the user picks a date.
  const planningToday = usePlanningToday();
  const [chosenAnchor, setAnchorDate] = useState<string | null>(null);
  const anchorDate = chosenAnchor ?? planningToday;
  const [timeZone, setTimeZone] = useState<string>('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(template.blueprint.items.map((item) => item.templateKey)),
  );
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ anchorDate: string; count: number } | null>(null);
  // The explicit Keep-overlap choice; any change to date, zone, or selection asks again.
  const [keepOverlaps, setKeepOverlaps] = useState(false);
  const overlapSignature = useRef('');
  const zone = timeZone === '' ? (profile?.planningTimeZone ?? deviceZone) : timeZone;
  const timeFormat = profile?.timeFormat ?? '24_hour';
  const selectedKeys = template.blueprint.items
    .map((item) => item.templateKey)
    .filter((key) => selected.has(key));
  const selectionKey = selectedKeys.join('\u0000');
  const validDate = /^\d{4}-\d{2}-\d{2}$/u.test(anchorDate);
  useEffect(() => {
    if (!validDate) {
      setPreview({ status: 'error', message: uiMessage('plan.templates.1824') });
      return;
    }
    let active = true;
    setPreview((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    const timer = window.setTimeout(() => {
      planning
        .previewTemplate({ templateId: template.id, anchorDate, timeZone: zone, selectedKeys })
        .then((result) => {
          if (!active) return;
          // A choice made against different overlaps is not a choice about these ones.
          const signature = result.ok ? JSON.stringify(result.value.overlaps) : '';
          if (signature !== overlapSignature.current) {
            overlapSignature.current = signature;
            setKeepOverlaps(false);
          }
          setPreview(
            result.ok
              ? { status: 'ready', preview: result.value }
              : { status: 'error', message: templateErrorMessage(result.error) },
          );
        })
        .catch(() => {
          if (active)
            setPreview({
              status: 'error',
              message: uiMessage('plan.templates.1825'),
            });
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [planning, template.id, anchorDate, zone, selectionKey, validDate]);

  const items = preview.status === 'ready' ? preview.preview.items : [];
  const issues = preview.status === 'ready' ? preview.preview.issues : [];
  const titles = new Map(template.blueprint.items.map((item) => [item.templateKey, item.title]));
  const byKey = new Map(items.map((item) => [item.templateKey, item]));
  const summary = [...new Set(issues.map((issue) => issueMessage(issue, titles)))];
  const overlaps = new Map(
    (preview.status === 'ready' ? preview.preview.overlaps : []).map((item) => [
      item.templateKey,
      item.overlaps.map((overlap) => overlap.title),
    ]),
  );
  const hasOverlaps = overlaps.size > 0;
  const canApply =
    preview.status === 'ready' &&
    issues.length === 0 &&
    (!hasOverlaps || keepOverlaps) &&
    !runner.busy;
  const toggle = (key: string, checked: boolean): void => {
    setApplied(null);
    setKeepOverlaps(false);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const apply = async (): Promise<void> => {
    if (!canApply) return;
    setApplyError(null);
    const count = selectedKeys.length;
    const result = await runCommand(
      runner,
      () =>
        planning.applyTemplate({
          templateId: template.id,
          anchorDate,
          timeZone: zone,
          selectedKeys,
          overlapAcknowledged: hasOverlaps && keepOverlaps,
        }),
      uiMessage('plan.templates.1826'),
      (error) => templateErrorMessage(error, titles),
    );
    if (result.message === null) setApplied({ anchorDate, count });
    else setApplyError(result.message);
  };
  return (
    <section className="template-apply" aria-labelledby="template-apply-title">
      <h2 id="template-apply-title">{uiMessage('plan.templates.1827')}</h2>
      <p className="field-help">{uiMessage('plan.templates.1828')}</p>
      <div className="two-column-fields template-apply-fields">
        <label className="field-label">
          {uiMessage('plan.templates.1829')}
          <span>{uiMessage('plan.templates.1830')}</span>
          <input
            type="date"
            required
            value={anchorDate}
            onChange={(event) => {
              setApplied(null);
              setKeepOverlaps(false);
              setAnchorDate(event.target.value);
            }}
          />
        </label>
        <ZonePicker
          label={uiMessage('plan.templates.1831')}
          value={zone}
          onChange={(value) => {
            setApplied(null);
            setKeepOverlaps(false);
            setTimeZone(value);
          }}
        />
      </div>
      {preview.status === 'loading' && (
        <p className="field-help">{uiMessage('plan.templates.1832')}</p>
      )}
      {preview.status === 'error' && <p className="warning-note">{preview.message}</p>}
      {preview.status === 'ready' && (
        <ul className="template-items" aria-label={uiMessage('plan.templates.1833')}>
          {items.map((item) => {
            const schedule = scheduleText(item, preview.preview.timeZone, timeFormat);
            const itemIssues = issues.filter(
              (issue) =>
                issue.templateKey === item.templateKey && issue.code !== 'nothing_selected',
            );
            const depth = depthOf(item, byKey);
            const itemOverlaps = item.selected ? overlaps.get(item.templateKey) : undefined;
            return (
              <li
                key={item.templateKey}
                className={itemIssues.length > 0 ? 'template-item has-issue' : 'template-item'}
                style={{ '--depth': String(depth) } as CSSProperties}
              >
                <label className="template-item-choice">
                  <input
                    type="checkbox"
                    checked={selected.has(item.templateKey)}
                    onChange={(event) => toggle(item.templateKey, event.target.checked)}
                  />
                  <span className="template-kind">{templateKindLabels[item.kind]}</span>{' '}
                  <span className="template-item-title">{item.title}</span>
                </label>
                <p className="template-item-schedule">
                  {item.selected ? schedule.text : uiMessage('plan.templates.1834')}
                </p>
                {item.selected && schedule.note !== undefined && (
                  <p className="warning-text">{schedule.note}</p>
                )}
                {itemOverlaps !== undefined && (
                  <p className="warning-text">
                    {uiMessage('plan.templates.1835')}
                    {itemOverlaps.join(', ')}
                  </p>
                )}
                {itemIssues.map((issue) => (
                  <p key={issue.code} className="warning-text">
                    {uiMessage('plan.templates.1836')}
                    {issueMessage(issue, titles)}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {summary.length > 0 && (
        <div className="warning-note" aria-live="polite">
          <p>
            <strong>{uiMessage('plan.templates.1837')}</strong>
          </p>
          <ul>
            {summary.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {hasOverlaps && summary.length === 0 && (
        <div className="warning-note template-overlaps">
          <p>{uiMessage('plan.templates.1838')}</p>
          <label className="template-item-choice">
            <input
              type="checkbox"
              checked={keepOverlaps}
              onChange={(event) => setKeepOverlaps(event.target.checked)}
            />
            {uiMessage('plan.templates.1839')}
          </label>
        </div>
      )}
      {applyError !== null && (
        <p className="validation-summary" role="alert">
          {applyError}
        </p>
      )}
      {applied !== null && runner.announcement !== 'Change undone.' ? (
        <div className="template-applied">
          <p>
            {uiMessage('plan.templates.1840')}
            {itemCountText(applied.count)}{' '}
            {applied.count === 1
              ? uiMessage('plan.templates.2476')
              : uiMessage('plan.templates.2477')}{' '}
            {uiMessage('plan.templates.1841')}
          </p>
          <Link className="inline-button" to={planPath('week', applied.anchorDate)}>
            {uiMessage('plan.templates.1842')}
            {formatDate(applied.anchorDate, 'weekday')}
          </Link>
        </div>
      ) : (
        <div className="dialog-actions">
          <button
            className="primary-button"
            type="button"
            disabled={!canApply}
            onClick={() => void apply()}
          >
            {runner.busy
              ? uiMessage('plan.templates.1843')
              : uiMessage('plan.templates.1844', { value0: itemCountText(selectedKeys.length) })}
          </button>
        </div>
      )}
    </section>
  );
}
