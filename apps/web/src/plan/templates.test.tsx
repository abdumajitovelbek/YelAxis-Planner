// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  ApplicationResult,
  CapacitySettings,
  CommandReceipt,
  PlanProfile,
  PlanningApplication,
  TemplateDetail,
  TemplateItemOverlaps,
  TemplateListItem,
} from '@yelaxis/application';
import {
  previewTemplateApplication,
  type CommandId,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type TemplateBlueprintV2,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';

import { PlanningProvider } from './planning-context';
import { TemplateDetailPage, TemplatesPage } from './templates';

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

afterEach(() => cleanup());

const profile: PlanProfile = {
  profileId: '30000000-0000-4000-8000-000000000001' as UUID,
  planningTimeZone: 'America/New_York' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
const settings: CapacitySettings = {
  profile,
  availability: [],
  rules: {} as CapacitySettings['rules'],
};

const sprintBlueprint: TemplateBlueprintV2 = {
  version: 2,
  items: [
    {
      templateKey: 'sprint',
      kind: 'project',
      title: 'Sprint',
      note: 'Ship the first version.',
      relativeDayOffset: 0,
    },
    {
      templateKey: 'plan',
      kind: 'action',
      title: 'Plan sprint',
      parentTemplateKey: 'sprint',
      relativeDayOffset: 0,
      localStartTime: '09:00' as WallTime,
      durationMinutes: 45,
    },
    { templateKey: 'later', kind: 'action', title: 'Tidy notes' },
  ],
};

const starter: TemplateDetail = {
  id: '00000000-0000-4000-a000-000000000001' as UUID,
  source: 'built_in',
  title: 'Weekly Reset',
  description: 'A short planning pass.',
  itemCount: 3,
  blueprintVersion: 2,
  state: 'active',
  catalogVersion: 1,
  blueprint: sprintBlueprint,
};
const own: TemplateDetail = {
  id: '90000000-0000-4000-8000-000000000001' as UUID,
  source: 'user',
  title: 'My sprint',
  itemCount: 3,
  blueprintVersion: 2,
  state: 'active',
  localRevision: 4,
  blueprint: sprintBlueprint,
};
const archived: TemplateListItem = {
  id: '90000000-0000-4000-8000-000000000002' as UUID,
  source: 'user',
  title: 'Old plan',
  itemCount: 1,
  blueprintVersion: 1,
  state: 'archived',
  localRevision: 2,
};

function receipt(): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: '10000000-0000-4000-8000-000000000009' as CommandId,
      ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
      actor: 'user',
      acceptedAt: '2026-09-27T12:00:00.000Z' as Instant,
      canonical: [
        {
          ref: {
            type: 'template',
            id: '90000000-0000-4000-8000-000000000099' as UUID,
            ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
          },
          localRevision: 1,
        },
      ],
      eventIds: [],
      undo: { available: true, undoId: '60000000-0000-4000-8000-000000000001' as UUID },
      sync: { queued: false },
    },
  };
}

const planningMethods: Record<keyof PlanningApplication, true> = {
  getDayPlan: true,
  getWeekPlan: true,
  getMonthPlan: true,
  getYearPlan: true,
  getMilestoneChain: true,
  resolveLocalInterval: true,
  listRoutines: true,
  getRoutine: true,
  previewRoutine: true,
  listTemplates: true,
  getTemplate: true,
  previewTemplate: true,
  getCapacitySettings: true,
  listAxes: true,
  listProjects: true,
  createCustomBlock: true,
  scheduleAction: true,
  moveBlock: true,
  shortenBlock: true,
  setBlockState: true,
  keepOverlap: true,
  createCommitment: true,
  place: true,
  unplace: true,
  carryForward: true,
  reorderPlacement: true,
  addWeekCommitment: true,
  removeWeekCommitment: true,
  createRoutine: true,
  repeatAfterAction: true,
  editRoutineDetails: true,
  editRoutineThisAndFuture: true,
  pauseRoutine: true,
  resumeRoutine: true,
  archiveRoutine: true,
  restoreRoutine: true,
  completeOccurrence: true,
  skipOccurrence: true,
  reopenOccurrence: true,
  editOccurrence: true,
  applyTemplate: true,
  duplicateTemplate: true,
  saveTemplate: true,
  archiveTemplate: true,
  restoreTemplate: true,
  saveWeekAsTemplate: true,
  addAvailability: true,
  editAvailability: true,
  archiveConstraint: true,
  setCapacityCap: true,
  setMonthTheme: true,
  clearMonthTheme: true,
  setYearDirection: true,
  clearYearDirection: true,
  previewPlanningZoneChange: true,
  changePlanningZone: true,
  getTimeBlockReminder: true,
  setTimeBlockReminder: true,
  turnOffTimeBlockReminder: true,
  setRoutineReminder: true,
  turnOffRoutineReminder: true,
  undo: true,
};

/** Preview through the real pure domain function so schedule text is realistic. */
const domainPreview =
  (
    template: TemplateDetail,
    overlaps: readonly TemplateItemOverlaps[] = [],
  ): PlanningApplication['previewTemplate'] =>
  (input) => {
    const result = previewTemplateApplication(template.blueprint, {
      anchorDate: input.anchorDate,
      timeZone: input.timeZone,
      ...(input.selectedKeys === undefined ? {} : { selectedKeys: new Set(input.selectedKeys) }),
    });
    return Promise.resolve(
      result.ok
        ? { ok: true, value: { ...result.value, overlaps } }
        : { ok: false, error: { code: 'domain_rejected', domainError: result.error } },
    );
  };

function fakePlanning(overrides: Partial<PlanningApplication> = {}): PlanningApplication {
  const base = Object.fromEntries(
    Object.keys(planningMethods).map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected planning call: ${name}`)),
    ]),
  ) as unknown as PlanningApplication;
  return {
    ...base,
    getCapacitySettings: () => Promise.resolve(settings),
    listTemplates: () => Promise.resolve([starter, own]),
    ...overrides,
  };
}

function stubActions(): ActionApplication {
  const unused = () => Promise.reject(new Error('Unexpected Action application call'));
  return {
    newCaptureIntent: unused as unknown as ActionApplication['newCaptureIntent'],
    capture: unused,
    listInbox: unused,
    listAllInbox: unused,
    getAction: unused,
    listAxes: unused,
    listProjects: unused,
    edit: unused,
    triage: unused,
    transition: unused,
    reorder: unused,
    bulk: unused,
    undo: unused,
    deletePermanently: unused,
    listMilestones: unused,
  };
}

function renderWith(planning: PlanningApplication, element: ReactNode, path = '/plan/templates') {
  return render(
    <PlanningProvider planning={planning} actions={stubActions()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/plan/templates" element={element} />
          <Route path="/plan/templates/:templateId" element={element} />
        </Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('Templates page', () => {
  it('separates starter and user templates and offers the right actions', async () => {
    const listTemplates = vi
      .fn()
      .mockResolvedValueOnce([starter, own])
      .mockResolvedValue([starter, own, archived]);
    const archiveTemplate = vi.fn().mockResolvedValue(receipt());
    renderWith(fakePlanning({ listTemplates, archiveTemplate }), <TemplatesPage />);

    const starters = await screen.findByRole('region', { name: 'Starter templates' });
    expect(within(starters).getByRole('heading', { name: 'Weekly Reset' })).toBeVisible();
    expect(within(starters).getByText('3 items')).toBeVisible();
    expect(within(starters).queryByRole('button', { name: /Archive/u })).not.toBeInTheDocument();
    expect(within(starters).getByRole('link', { name: /Preview and apply/u })).toHaveAttribute(
      'href',
      `/plan/templates/${starter.id}`,
    );
    const yours = screen.getByRole('region', { name: 'Your templates' });
    expect(within(yours).getByRole('link', { name: /Edit/u })).toHaveAttribute(
      'href',
      `/plan/templates/${own.id}?edit=1`,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    const user = userEvent.setup();
    await user.click(within(yours).getByRole('button', { name: /Archive My sprint/u }));
    await waitFor(() =>
      expect(archiveTemplate).toHaveBeenCalledWith({ templateId: own.id, revision: 4 }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Show archived templates' }));
    await waitFor(() => expect(listTemplates).toHaveBeenLastCalledWith({ includeArchived: true }));
    expect(
      await within(screen.getByRole('region', { name: 'Your templates' })).findByRole('button', {
        name: /Restore Old plan/u,
      }),
    ).toBeVisible();
  });

  it('duplicates a starter template with a chosen title', async () => {
    const duplicateTemplate = vi.fn().mockResolvedValue(receipt());
    renderWith(fakePlanning({ duplicateTemplate }), <TemplatesPage />);
    const user = userEvent.setup();
    const starters = await screen.findByRole('region', { name: 'Starter templates' });
    await user.click(
      within(starters).getByRole('button', { name: /Duplicate to customize Weekly Reset/u }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate to customize' });
    const title = within(dialog).getByRole('textbox', { name: /Title of the copy/u });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveValue('Weekly Reset (copy)');
    await user.clear(title);
    await user.type(title, 'My reset');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(duplicateTemplate).toHaveBeenCalledWith({ templateId: starter.id, title: 'My reset' }),
    );
    expect(await screen.findByRole('link', { name: 'Open My reset' })).toHaveAttribute(
      'href',
      '/plan/templates/90000000-0000-4000-8000-000000000099',
    );
  });

  it('shows a recoverable error state', async () => {
    const listTemplates = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue([starter]);
    renderWith(fakePlanning({ listTemplates }), <TemplatesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Starter templates' })).toBeVisible();
    expect(screen.getByText(/No templates of your own yet/u)).toBeVisible();
  });
});

describe('Template detail and apply', () => {
  it('previews resolved times, blocks a missing parent, and applies in one step', async () => {
    const previewTemplate = vi.fn(domainPreview(starter));
    const applyTemplate = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({
        getTemplate: () => Promise.resolve(starter),
        previewTemplate,
        applyTemplate,
      }),
      <TemplateDetailPage />,
      `/plan/templates/${starter.id}`,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly Reset' })).toBeVisible();
    expect(screen.getByText(/Starter templates are read-only/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit template' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Start date/u), { target: { value: '2026-08-10' } });
    const items = await screen.findByRole('list', { name: 'Template items' });
    expect(
      await within(items).findByText(/Aug 10, 09:00 to 09:45 \(America\/New York, UTC-04:00\)/u),
    ).toBeVisible();
    expect(within(items).getByText('Unscheduled – goes to Backlog')).toBeVisible();
    expect(within(items).getByText(/Placed on the week of/u)).toBeVisible();

    const user = userEvent.setup();
    await user.click(within(items).getByRole('checkbox', { name: /Project Sprint/u }));
    expect(
      (await screen.findAllByText(/Plan sprint needs its parent Sprint selected\./u)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Apply/u })).toBeDisabled();

    await user.click(within(items).getByRole('checkbox', { name: /Project Sprint/u }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Apply 3 items/u })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /^Apply 3 items/u }));
    await waitFor(() =>
      expect(applyTemplate).toHaveBeenCalledWith({
        templateId: starter.id,
        anchorDate: '2026-08-10',
        timeZone: 'America/New_York',
        selectedKeys: ['sprint', 'plan', 'later'],
        overlapAcknowledged: false,
      }),
    );
    expect(await screen.findByText(/Template applied\. 3 items were added/u)).toBeVisible();
    // Announced once, by the single polite region; the visible summary is not a second live region.
    const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')];
    expect(live.filter((element) => /Template applied/u.test(element.textContent))).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Open the Week plan/u })).toHaveAttribute(
      'href',
      '/plan/week/2026-08-10',
    );
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('names what a timed item overlaps and applies only after the overlaps are kept', async () => {
    const applyTemplate = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({
        getTemplate: () => Promise.resolve(starter),
        previewTemplate: domainPreview(starter, [
          {
            templateKey: 'plan',
            overlaps: [
              { key: 'block:50000000-0000-4000-8000-000000000001', title: 'Dentist' },
              { key: 'template:later', title: 'Tidy notes' },
            ],
          },
        ]),
        applyTemplate,
      }),
      <TemplateDetailPage />,
      `/plan/templates/${starter.id}`,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly Reset' })).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Start date/u), { target: { value: '2026-08-10' } });
    const items = await screen.findByRole('list', { name: 'Template items' });
    expect(await within(items).findByText('This time overlaps: Dentist, Tidy notes')).toBeVisible();
    const keep = screen.getByRole('checkbox', { name: /Keep these overlaps/u });
    expect(keep).not.toBeChecked();
    const applyButton = screen.getByRole('button', { name: /^Apply 3 items/u });
    expect(applyButton).toBeDisabled();

    const user = userEvent.setup();
    await user.click(keep);
    await waitFor(() => expect(applyButton).toBeEnabled());
    await user.click(applyButton);
    await waitFor(() =>
      expect(applyTemplate).toHaveBeenCalledWith({
        templateId: starter.id,
        anchorDate: '2026-08-10',
        timeZone: 'America/New_York',
        selectedKeys: ['sprint', 'plan', 'later'],
        overlapAcknowledged: true,
      }),
    );
  });

  it('asks to deselect routine items and reports nothing selected', async () => {
    const withRoutine: TemplateDetail = {
      ...own,
      blueprint: {
        version: 2,
        items: [
          { templateKey: 'walk', kind: 'routine', title: 'Daily walk' },
          { templateKey: 'call', kind: 'action', title: 'Call home' },
        ],
      },
    };
    renderWith(
      fakePlanning({
        getTemplate: () => Promise.resolve(withRoutine),
        previewTemplate: domainPreview(withRoutine),
      }),
      <TemplateDetailPage />,
      `/plan/templates/${own.id}`,
    );
    expect(
      (await screen.findAllByText(/Routine items cannot be applied yet; deselect them\./u)).length,
    ).toBeGreaterThan(0);
    const user = userEvent.setup();
    const items = screen.getByRole('list', { name: 'Template items' });
    await user.click(within(items).getByRole('checkbox', { name: /Daily walk/u }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Apply 1 item/u })).toBeEnabled(),
    );
    await user.click(within(items).getByRole('checkbox', { name: /Call home/u }));
    expect(await screen.findByText('Nothing selected.')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Apply 0 items/u })).toBeDisabled();
  });

  it('shows a calm unavailable state', async () => {
    renderWith(
      fakePlanning({ getTemplate: () => Promise.resolve(null) }),
      <TemplateDetailPage />,
      '/plan/templates/missing',
    );
    expect(
      await screen.findByRole('heading', { name: 'This template is unavailable.' }),
    ).toBeVisible();
  });
});

describe('Template editor', () => {
  it('asks for a timed duration of at least 5 minutes', async () => {
    const saveTemplate = vi.fn().mockResolvedValue(receipt());
    renderWith(
      fakePlanning({
        getTemplate: () => Promise.resolve(own),
        previewTemplate: domainPreview(own),
        saveTemplate,
      }),
      <TemplateDetailPage />,
      `/plan/templates/${own.id}?edit=1`,
    );
    const editor = await screen.findByRole('region', { name: 'Edit template' });
    const duration = within(editor)
      .getAllByRole<HTMLInputElement>('spinbutton', { name: /Duration/u })
      .find((input) => input.value === '45');
    if (duration === undefined) throw new Error('Missing the Plan sprint duration');
    expect(duration).toHaveAttribute('min', '5');
    const user = userEvent.setup();
    await user.clear(duration);
    await user.type(duration, '3');
    await user.click(within(editor).getByRole('button', { name: 'Save template' }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent(
      'Plan sprint: duration must be a whole number of minutes from 5 to 1,440.',
    );
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it('validates items, shows domain reasons in words, and saves a version 2 blueprint', async () => {
    const saveTemplate = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'domain_rejected',
          domainError: {
            code: 'invalid_value',
            message: 'The template blueprint is invalid.',
            details: { reason: 'scheduling_not_supported', templateKey: 'later' },
          },
        },
      })
      .mockResolvedValue(receipt());
    renderWith(
      fakePlanning({
        getTemplate: () => Promise.resolve(own),
        previewTemplate: domainPreview(own),
        saveTemplate,
      }),
      <TemplateDetailPage />,
      `/plan/templates/${own.id}?edit=1`,
    );
    const editor = await screen.findByRole('region', { name: 'Edit template' });
    const user = userEvent.setup();
    await user.click(within(editor).getByRole('button', { name: 'Add Action' }));
    await user.click(within(editor).getByRole('button', { name: 'Save template' }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent('Item 4 needs a title.');
    expect(saveTemplate).not.toHaveBeenCalled();

    const titles = within(editor).getAllByRole('textbox', { name: /^Title/u });
    await user.type(titles[titles.length - 1]!, 'Review notes');
    const offsets = within(editor).getAllByRole('spinbutton', { name: /Day offset/u });
    await user.type(offsets[offsets.length - 1]!, '1');
    await user.click(within(editor).getByRole('button', { name: 'Save template' }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent(
      'Tidy notes: This kind of item cannot be placed on a day.',
    );
    await user.click(within(editor).getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(2));
    expect(saveTemplate.mock.calls[1]?.[0]).toEqual({
      templateId: own.id,
      revision: 4,
      title: 'My sprint',
      blueprint: {
        version: 2,
        items: [
          {
            templateKey: 'sprint',
            kind: 'project',
            title: 'Sprint',
            note: 'Ship the first version.',
            relativeDayOffset: 0,
          },
          {
            templateKey: 'plan',
            kind: 'action',
            title: 'Plan sprint',
            parentTemplateKey: 'sprint',
            relativeDayOffset: 0,
            localStartTime: '09:00',
            durationMinutes: 45,
          },
          { templateKey: 'later', kind: 'action', title: 'Tidy notes' },
          { templateKey: 'action-4', kind: 'action', title: 'Review notes', relativeDayOffset: 1 },
        ],
      },
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Edit template' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: 'Apply this template' })).toBeVisible();
  });
});
