/**
 * Routes of the Axis area. The static `/axis/alignment` segment outranks `/axis/:axisId`, and every
 * object page validates its id and shows a calm unavailable state for a malformed or missing one.
 */
import type { ReactNode } from 'react';
import { Route } from 'react-router-dom';

import { AlignmentPage } from './alignment-page';
import { AxisDetailPage } from './axis-detail';
import { AxisOverviewPage } from './axis-overview';
import { MilestoneDetailPage } from './milestone-detail';
import { OutcomeDetailPage } from './outcome-detail';
import { ProjectDetailPage } from './project-detail';

/** Route elements to place directly inside the app's `<Routes>`. */
export function alignmentRoutes(): ReactNode {
  return (
    <>
      <Route path="/axis" element={<AxisOverviewPage />} />
      <Route path="/axis/alignment" element={<AlignmentPage />} />
      <Route path="/axis/:axisId" element={<AxisDetailPage />} />
      <Route path="/outcomes/:outcomeId" element={<OutcomeDetailPage />} />
      <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      <Route path="/milestones/:milestoneId" element={<MilestoneDetailPage />} />
    </>
  );
}
