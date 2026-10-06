// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  LocalTimeResolution,
  OccurrenceEntry,
  PlanProfile,
  PlanningApplication,
  RoutineDetail,
} from '@yelaxis/application';
import type {
  CalendarDate,
  IanaTimeZone,
  Instant,
  RecurrenceRuleV1,
  RoutineSchedulingMode,
  UUID,
  WallTime,
} from '@yelaxis/domain';

import {
  fakePlanning,
  installDialogPolyfill,
  occurrence,
  receipt,
  renderTree,
} from './__fixtures__/c1-planning-fake';
import { OccurrenceControls } from './occurrence-controls';

beforeAll(() => {
  installDialogPolyfill();
});

afterEach(() => cleanup());

const london = 'Europe/London' as IanaTimeZone;
const date = (value: string): CalendarDate => value as CalendarDate;

const profileIn = (zone: string): PlanProfile => ({
  profileId: 'profile-1' as UUID,
  planningTimeZone: zone as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
});

const fixedLondon = (wallTime: string): RoutineSchedulingMode => ({
  kind: 'time_specific',
  wallTime: wallTime as WallTime,
  durationMinutes: 30,
  zonePolicy: { kind: 'fixed_zone', timeZone: london },
  gapPolicy: 'shift_forward',
  overlapPolicy: 'earlier_offset',
});

function detailFor(mode: RoutineSchedulingMode, profile: PlanProfile): RoutineDetail {
  const generation = {
    generation: 1,
    rule: {
      version: 1,
      kind: 'daily',
      intervalDays: 1,
      startsOn: date('2026-09-01'),
    } as RecurrenceRuleV1,
    schedulingMode: mode,
  };
  return {
    routine: {
      id: 'routine-call' as UUID,
      localRevision: 1,
      title: 'Call home',
      state: 'active',
      generations: [generation],
      current: generation,
    },
    profile,
    today: date('2026-09-28'),
    upcoming: [],
    history: [],
  };
}

const callHome = (day: string, startsAt: string, endsAt: string): OccurrenceEntry =>
  occurrence({
    occurrenceId: 'occ-call',
    routineId: 'routine-call',
    title: 'Call home',
    day,
    timing: { kind: 'timed', startsAt: startsAt as Instant, endsAt: endsAt as Instant },
  });

const target = (day: string) => ({
  routineId: 'routine-call',
  generation: 1,
  period: { kind: 'date', date: day },
});

function resolution(overrides: Partial<LocalTimeResolution>): LocalTimeResolution {
  return {
    startsAt: '2026-10-05T08:00:00.000Z' as Instant,
    endsAt: '2026-10-05T08:45:00.000Z' as Instant,
    localStart: '09:00' as WallTime,
    localEnd: '09:45' as WallTime,
    localEndDate: date('2026-10-05'),
    utcOffset: '+01:00',
    timeZone: london,
    overlaps: [],
    ...overrides,
  };
}

function renderControls(
  entry: OccurrenceEntry,
  profile: PlanProfile,
  overrides: Partial<PlanningApplication>,
): void {
  const planning = fakePlanning(overrides);
  render(renderTree(planning, <OccurrenceControls entry={entry} profile={profile} />));
}

async function openEdit(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Edit this occurrence… Call home' }));
  return screen.findByRole('dialog', { name: 'Edit this occurrence' });
}

describe('Edit this occurrence', () => {
  it('reads a fixed-zone time in its own zone and sends only the changed duration', async () => {
    const losAngeles = profileIn('America/Los_Angeles');
    const editOccurrence = vi.fn().mockResolvedValue(receipt());
    const resolveLocalInterval = vi.fn().mockResolvedValue({ ok: true, value: resolution({}) });
    renderControls(
      // 09:00 in London is 01:00 in Los Angeles.
      callHome('2026-10-05', '2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z'),
      losAngeles,
      {
        getRoutine: vi.fn().mockResolvedValue(detailFor(fixedLondon('09:00'), losAngeles)),
        editOccurrence,
        resolveLocalInterval,
      },
    );
    const dialog = await openEdit();
    const start = await within(dialog).findByLabelText('Start time');
    expect(start).toHaveValue('09:00');
    expect(within(dialog).getByLabelText(/^Date/u)).toHaveValue('2026-10-05');
    expect(start).toHaveAccessibleDescription(/Times are in Europe\/London\./u);
    expect(within(dialog).getByText(/Usually 09:00 for 30 minutes/u)).toBeVisible();

    const duration = within(dialog).getByLabelText('Duration (minutes)');
    expect(duration).toHaveValue(30);
    fireEvent.change(duration, { target: { value: '45' } });
    expect(await within(dialog).findByText(/09:00 – 09:45 in Europe\/London/u)).toBeVisible();
    expect(resolveLocalInterval).toHaveBeenLastCalledWith(
      // Unchanged fields are omitted, exactly as Save sends them.
      { occurrence: target('2026-10-05'), date: '2026-10-05', durationMinutes: 45 },
      ['occurrence:occ-call'],
    );
    expect(
      within(dialog).getByText(/In your planning time zone \(America\/Los_Angeles\)/u),
    ).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save this occurrence' }));
    await waitFor(() =>
      expect(editOccurrence).toHaveBeenCalledWith({
        occurrence: target('2026-10-05'),
        date: '2026-10-05',
        durationMinutes: 45,
        overlapAcknowledged: false,
      }),
    );
  });

  it('keeps the occurrence date when the planning zone is on another day', async () => {
    const tokyo = profileIn('Asia/Tokyo');
    const editOccurrence = vi.fn().mockResolvedValue(receipt());
    renderControls(
      // 23:30 in London on Oct 5 is 07:30 on Oct 6 in Tokyo.
      callHome('2026-10-05', '2026-10-05T22:30:00.000Z', '2026-10-05T23:00:00.000Z'),
      tokyo,
      {
        getRoutine: vi.fn().mockResolvedValue(detailFor(fixedLondon('23:30'), tokyo)),
        editOccurrence,
        resolveLocalInterval: vi.fn().mockResolvedValue({
          ok: true,
          value: resolution({
            startsAt: '2026-10-05T22:30:00.000Z' as Instant,
            endsAt: '2026-10-05T23:00:00.000Z' as Instant,
            localStart: '23:30' as WallTime,
            localEnd: '00:00' as WallTime,
            localEndDate: date('2026-10-06'),
          }),
        }),
      },
    );
    const dialog = await openEdit();
    expect(await within(dialog).findByLabelText('Start time')).toHaveValue('23:30');
    expect(within(dialog).getByLabelText(/^Date/u)).toHaveValue('2026-10-05');
    expect(await within(dialog).findByText(/23:30 – 00:00/u)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save this occurrence' }));
    await waitFor(() =>
      expect(editOccurrence).toHaveBeenCalledWith({
        occurrence: target('2026-10-05'),
        date: '2026-10-05',
        overlapAcknowledged: false,
      }),
    );
  });

  it('sends a changed start time without the unchanged duration', async () => {
    const losAngeles = profileIn('America/Los_Angeles');
    const editOccurrence = vi.fn().mockResolvedValue(receipt());
    renderControls(
      callHome('2026-10-05', '2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z'),
      losAngeles,
      {
        getRoutine: vi.fn().mockResolvedValue(detailFor(fixedLondon('09:00'), losAngeles)),
        editOccurrence,
        resolveLocalInterval: vi.fn().mockResolvedValue({
          ok: true,
          value: resolution({ localStart: '10:15' as WallTime, localEnd: '10:45' as WallTime }),
        }),
      },
    );
    const dialog = await openEdit();
    fireEvent.change(await within(dialog).findByLabelText('Start time'), {
      target: { value: '10:15' },
    });
    expect(await within(dialog).findByText(/10:15 – 10:45/u)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save this occurrence' }));
    await waitFor(() =>
      expect(editOccurrence).toHaveBeenCalledWith({
        occurrence: target('2026-10-05'),
        date: '2026-10-05',
        startTime: '10:15',
        overlapAcknowledged: false,
      }),
    );
  });

  it('previews and saves a date-only move with the stored time on a clock-change day', async () => {
    const newYork = profileIn('America/New_York');
    const followProfile: RoutineSchedulingMode = {
      kind: 'time_specific',
      wallTime: '02:30' as WallTime,
      durationMinutes: 30,
      zonePolicy: { kind: 'follow_profile' },
      gapPolicy: 'shift_forward',
      overlapPolicy: 'earlier_offset',
    };
    const editOccurrence = vi.fn().mockResolvedValue(receipt());
    const resolveLocalInterval = vi.fn((input: { readonly date: string }) =>
      Promise.resolve({
        ok: true as const,
        value:
          input.date === '2027-03-14'
            ? resolution({
                startsAt: '2027-03-14T07:30:00.000Z' as Instant,
                endsAt: '2027-03-14T08:00:00.000Z' as Instant,
                localStart: '03:30' as WallTime,
                localEnd: '04:00' as WallTime,
                localEndDate: date('2027-03-14'),
                utcOffset: '-04:00',
                timeZone: 'America/New_York' as IanaTimeZone,
                adjustment: 'dst_gap_shifted',
              })
            : resolution({
                startsAt: '2027-03-15T06:30:00.000Z' as Instant,
                endsAt: '2027-03-15T07:00:00.000Z' as Instant,
                localStart: '02:30' as WallTime,
                localEnd: '03:00' as WallTime,
                localEndDate: date('2027-03-15'),
                utcOffset: '-04:00',
                timeZone: 'America/New_York' as IanaTimeZone,
              }),
      }),
    );
    renderControls(
      callHome('2027-03-14', '2027-03-14T07:30:00.000Z', '2027-03-14T08:00:00.000Z'),
      newYork,
      {
        getRoutine: vi.fn().mockResolvedValue(detailFor(followProfile, newYork)),
        editOccurrence,
        resolveLocalInterval,
      },
    );
    const dialog = await openEdit();
    expect(
      await within(dialog).findByText(
        'The usual time does not exist on this date; it will start at 03:30.',
      ),
    ).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText(/^Date/u), { target: { value: '2027-03-15' } });
    expect(await within(dialog).findByText(/02:30 – 03:00/u)).toBeVisible();
    expect(resolveLocalInterval).toHaveBeenLastCalledWith(
      { occurrence: target('2027-03-14'), date: '2027-03-15' },
      expect.anything(),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save this occurrence' }));
    await waitFor(() =>
      expect(editOccurrence).toHaveBeenCalledWith({
        occurrence: target('2027-03-14'),
        date: '2027-03-15',
        overlapAcknowledged: false,
      }),
    );
  });

  it('says calmly when the Routine could not be loaded', async () => {
    const losAngeles = profileIn('America/Los_Angeles');
    renderControls(
      callHome('2026-10-05', '2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z'),
      losAngeles,
      { getRoutine: vi.fn().mockResolvedValue(null) },
    );
    const dialog = await openEdit();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This occurrence could not be loaded. Close this dialog and try again.',
    );
    expect(within(dialog).queryByLabelText('Start time')).not.toBeInTheDocument();
  });
});

describe('Occurrence feedback', () => {
  it('announces a completed occurrence once and offers Undo', async () => {
    const completeOccurrence = vi.fn().mockResolvedValue(receipt());
    renderControls(
      callHome('2026-10-05', '2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z'),
      profileIn('Europe/London'),
      { completeOccurrence },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Complete Call home' }));
    expect(await screen.findByText('Occurrence completed.')).toBeInTheDocument();
    expect(screen.getAllByText('Occurrence completed.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });
});
