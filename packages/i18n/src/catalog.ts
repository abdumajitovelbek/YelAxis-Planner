/**
 * English is the source catalog. Components consume message IDs rather than
 * embedding user-facing copy, so adding a locale does not change UI code.
 */
export const englishCatalog = {
  'app.name': 'YelAxis Planner',
  'app.tagline': 'Plan every horizon.',
  'navigation.today.label': 'Today',
  'navigation.today.hint': 'Open today\u2019s plan',
  'navigation.plan.label': 'Plan',
  'navigation.plan.hint': 'Open planning',
  'navigation.axis.label': 'Axis',
  'navigation.axis.hint': 'Open your planning axis',
  'navigation.review.label': 'Review',
  'navigation.review.hint': 'Open review',
  'navigation.inbox.label': 'Inbox',
  'navigation.search.label': 'Search',
  'navigation.notifications.label': 'Notifications',
  'navigation.settings.label': 'Appearance',
  'navigation.settings.hint': 'Change theme and motion preferences',
  'capture.open.label': 'Capture',
  'capture.open.hint': 'Add something to plan later',
  'action.back': 'Back',
  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.done': 'Done',
  'action.retry': 'Try again',
  'action.goToday': 'Go to Today',
  'action.keepEditing': 'Continue editing',
  'action.discard': 'Discard changes',
  'action.save': 'Save',
  'state.loading': 'Loading',
  'state.loading.title': 'Opening your plan',
  'state.loading.message': 'Your local plan is being prepared.',
  'state.empty.label': 'Empty',
  'state.attention.label': 'Needs attention',
  'state.error.title': 'Something went wrong',
  'state.error.message': 'Your changes are safe. Try again when you are ready.',
  'state.notFound.title': 'This page is not available',
  'state.notFound.message': 'The link may be incomplete, or the item may no longer be here.',
  'empty.today.title': 'Your day is clear.',
  'empty.today.message': 'Choose one focus item or leave space intentionally.',
  'empty.plan.title': 'Nothing is planned yet.',
  'empty.plan.message': 'Start small and shape the plan as you go.',
  'empty.axis.title': 'Your axis is ready.',
  'empty.axis.message': 'Your planning rhythm will appear here.',
  'empty.review.title': 'Nothing to review yet.',
  'empty.review.message': 'Completed work and reflections will appear here.',
  'today.description': 'One realistic day, with room to adjust.',
  'plan.description': 'See time at the level that helps you decide.',
  'axis.description': 'See why current work matters without forcing a hierarchy.',
  'review.description': 'Decide what continues, changes, or stops.',
  'capture.description': 'Open a quick-entry surface without losing your place.',
  'capture.shell.title': 'Capture surface',
  'capture.shell.message': 'Close to return to the same place in your plan.',
  'inbox.description': 'A safe landing place for items that still need a decision.',
  'inbox.empty.title': 'Nothing waiting for a decision.',
  'inbox.empty.message': 'Captured items that need a decision appear here.',
  'search.description': 'Find items in the local plan without changing them.',
  'search.empty.title': 'Nothing to search yet.',
  'search.empty.message': 'Search stays local to the plan on this device.',
  'notifications.description': 'Review planning reminders in one place.',
  'notifications.empty.title': 'No planning reminders',
  'notifications.empty.message': 'No reminders need your attention.',
  'settings.title': 'Settings',
  'settings.description': 'Adjust this session without changing the plan.',
  'settings.appearance.action': 'Open appearance settings',
  'settings.appearance.hint': 'Choose theme and motion preferences',
  'appearance.title': 'Appearance',
  'appearance.description': 'Choose how YelAxis Planner looks and moves in this session.',
  'appearance.theme.heading': 'Theme',
  'appearance.motion.heading': 'Motion',
  'appearance.option.hint': 'Apply {option} for this session.',
  'appearance.selected.hint': '{option} is selected.',
  'dirty.title': 'Save your changes?',
  'dirty.message': 'Choose what to do before leaving this screen.',
  'object.invalid.title': 'This link is not valid',
  'object.invalid.message': 'Open an item from YelAxis Planner and try again.',
  'object.unavailable.title': 'This item is not available',
  'object.unavailable.message':
    'It may be archived, removed, or stored in a plan that is not open on this device.',
  'symbol.capture': '+',
  'preference.theme.system': 'Use device appearance',
  'preference.theme.light': 'Light',
  'preference.theme.dark': 'Dark',
  'preference.motion.system': 'Use device motion setting',
  'preference.motion.reduced': 'Reduced',
  'preference.motion.full': 'Full',
  'accessibility.selected': '{label}, selected',
  'accessibility.progress': '{completed} of {total} complete',
} as const;

export type MessageId = keyof typeof englishCatalog;
export type MessageCatalog = Readonly<Record<MessageId, string>>;
export type PartialMessageCatalog = Readonly<Partial<Record<MessageId, string>>>;

export const messageIds: readonly MessageId[] = Object.freeze(
  Object.keys(englishCatalog) as MessageId[],
);

/** Compile-time completeness boundary for shipping locale catalogs. */
export function defineMessageCatalog(catalog: MessageCatalog): MessageCatalog {
  return catalog;
}

/** Compile-time boundary for intentionally incomplete development catalogs. */
export function defineMessageOverrides(catalog: PartialMessageCatalog): PartialMessageCatalog {
  return catalog;
}

/** Runtime completeness check for catalogs loaded from outside TypeScript. */
export function getMissingMessageIds(catalog: PartialMessageCatalog): readonly MessageId[] {
  return messageIds.filter((id) => {
    const message = catalog[id];
    return message === undefined || message.trim().length === 0;
  });
}
