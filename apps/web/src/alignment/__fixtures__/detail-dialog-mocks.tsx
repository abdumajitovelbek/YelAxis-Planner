/**
 * Test-only stand-ins for the shared object forms, lifecycle dialogs, and link dialogs. Page tests
 * mock those modules with these, so they check exactly which props a page passes (focus, edge,
 * relationships, presets, targets) without depending on the dialogs' own behavior, which their
 * modules test. Never imported by runtime code.
 */
import type { ReactNode } from 'react';

type Props = Readonly<Record<string, unknown>>;

const latest = new Map<string, Props>();

/** The props a stand-in was last rendered with. */
export function lastProps(name: string): Props {
  const props = latest.get(name);
  if (props === undefined) throw new Error(`${name} was not rendered`);
  return props;
}

export function wasRendered(name: string): boolean {
  return latest.has(name);
}

export function resetStandIns(): void {
  latest.clear();
}

/** A dialog stand-in: a named dialog with a Close button while `open` is true. */
function dialogStandIn(name: string): (props: Props) => ReactNode {
  return function DialogStandIn(props) {
    latest.set(name, props);
    if (props['open'] !== true) return null;
    const onClose = props['onClose'] as () => void;
    return (
      <div role="dialog" aria-label={name}>
        <button type="button" onClick={onClose}>
          Close {name}
        </button>
      </div>
    );
  };
}

function markerStandIn(name: string, render: (props: Props) => ReactNode) {
  return function MarkerStandIn(props: Props): ReactNode {
    latest.set(name, props);
    return render(props);
  };
}

export const objectFormsStandIns = {
  AxisFormDialog: dialogStandIn('AxisFormDialog'),
  OutcomeFormDialog: dialogStandIn('OutcomeFormDialog'),
  ProjectFormDialog: dialogStandIn('ProjectFormDialog'),
  MilestoneFormDialog: dialogStandIn('MilestoneFormDialog'),
  ProgressEditor: markerStandIn('ProgressEditor', () => (
    <p data-testid="progress-editor">Progress editor</p>
  )),
};

export const lifecycleDialogsStandIns = {
  ArchiveDialog: dialogStandIn('ArchiveDialog'),
  RestoreButton: markerStandIn('RestoreButton', () => <button type="button">Restore</button>),
  ArchivedNotice: markerStandIn('ArchivedNotice', () => (
    <div className="archived-notice">
      <p>Archived. Restore it to make changes.</p>
      <button type="button">Restore</button>
    </div>
  )),
  DangerZone: markerStandIn('DangerZone', () => (
    <section aria-label="Permanent deletion" data-testid="danger-zone" />
  )),
};

export const linkDialogsStandIns = {
  LinkDialog: dialogStandIn('LinkDialog'),
  UnlinkDialog: dialogStandIn('UnlinkDialog'),
  ReparentMilestoneDialog: dialogStandIn('ReparentMilestoneDialog'),
};
