// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlanningProvider } from '../plan/planning-context';
import {
  alignmentPath,
  axisOverviewPath,
  axisPath,
  isAxisAreaPath,
  milestonePath,
  outcomePath,
  parseAlignmentFocus,
  projectPath,
} from '../plan/routes';
import {
  alignmentPlanning,
  axisDetail,
  bounded,
  fakeAlignment,
  ids,
  stubActions,
  unassignedView,
} from './__fixtures__/alignment-fake';
import { alignmentRoutes } from './alignment-routes';

vi.mock('./alignment-page', () => ({
  AlignmentPage: (): ReactNode => <h1>Alignment page</h1>,
}));
vi.mock('./outcome-detail', () => ({
  OutcomeDetailPage: (): ReactNode => <h1>Outcome detail page</h1>,
}));
vi.mock('./project-detail', () => ({
  ProjectDetailPage: (): ReactNode => <h1>Project detail page</h1>,
}));
vi.mock('./milestone-detail', () => ({
  MilestoneDetailPage: (): ReactNode => <h1>Milestone detail page</h1>,
}));

afterEach(() => cleanup());

function renderAt(path: string) {
  const alignment = fakeAlignment({
    listAxes: () => Promise.resolve(bounded([])),
    listUnassigned: () => Promise.resolve(unassignedView()),
    getAxis: () => Promise.resolve(axisDetail()),
  });
  return render(
    <PlanningProvider planning={alignmentPlanning()} actions={stubActions} alignment={alignment}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{alignmentRoutes()}</Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('Axis area routes', () => {
  it('opens the overview, the alignment page, and every object page', async () => {
    renderAt('/axis');
    expect(await screen.findByRole('heading', { level: 1, name: 'Axes' })).toBeVisible();
    cleanup();
    renderAt('/axis/alignment?focus=axis:x');
    expect(await screen.findByRole('heading', { level: 1, name: 'Alignment page' })).toBeVisible();
    cleanup();
    renderAt(axisPath(ids.health));
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    cleanup();
    renderAt(outcomePath(ids.halfMarathon));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Outcome detail page' }),
    ).toBeVisible();
    cleanup();
    renderAt(projectPath(ids.trainingPlan));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Project detail page' }),
    ).toBeVisible();
    cleanup();
    renderAt(milestonePath(ids.baseMiles));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Milestone detail page' }),
    ).toBeVisible();
  });
});

describe('Axis area paths', () => {
  it('builds readable deep links', () => {
    expect(axisOverviewPath).toBe('/axis');
    expect(axisPath(ids.health)).toBe(`/axis/${ids.health}`);
    expect(outcomePath(ids.halfMarathon)).toBe(`/outcomes/${ids.halfMarathon}`);
    expect(projectPath(ids.trainingPlan)).toBe(`/projects/${ids.trainingPlan}`);
    expect(alignmentPath()).toBe('/axis/alignment');
    expect(alignmentPath({ kind: 'outcome', id: ids.halfMarathon })).toBe(
      `/axis/alignment?focus=outcome:${ids.halfMarathon}`,
    );
    expect(alignmentPath({ kind: 'axis', id: ids.health }, 'map')).toBe(
      `/axis/alignment?focus=axis:${ids.health}&view=map`,
    );
    expect(alignmentPath(null, 'list')).toBe('/axis/alignment?view=list');
  });

  it('reads a focus parameter and rejects anything else', () => {
    expect(parseAlignmentFocus(`milestone:${ids.baseMiles}`)).toEqual({
      kind: 'milestone',
      id: ids.baseMiles,
    });
    expect(parseAlignmentFocus(null)).toBeNull();
    expect(parseAlignmentFocus('planet:1')).toBeNull();
    expect(parseAlignmentFocus('outcome:')).toBeNull();
    expect(parseAlignmentFocus('outcome')).toBeNull();
  });

  it('keeps the Axis navigation item current across the whole area', () => {
    for (const path of [
      '/axis',
      '/axis/alignment',
      `/axis/${ids.health}`,
      `/outcomes/${ids.halfMarathon}`,
      `/projects/${ids.trainingPlan}`,
      `/milestones/${ids.baseMiles}`,
    ])
      expect(isAxisAreaPath(path)).toBe(true);
    for (const path of ['/', '/plan/week/2026-09-28', '/axisx', '/review', '/actions/1'])
      expect(isAxisAreaPath(path)).toBe(false);
  });
});
