import type { TemplateBlueprintItemV2, TemplateBlueprintV2, UUID, WallTime } from '@yelaxis/domain';

/**
 * Application-owned starter templates. They are code, never canonical rows, so
 * startup, restart, and repeated initialization cannot duplicate them. Customizing one first
 * duplicates it into a user-owned Template with a new id; catalog upgrades never touch that copy.
 */
export const templateCatalogVersion = 1;

export interface BuiltInTemplate {
  readonly id: UUID;
  readonly title: string;
  readonly description: string;
  readonly blueprint: TemplateBlueprintV2;
}

type Item = TemplateBlueprintItemV2;
const action = (
  templateKey: string,
  title: string,
  schedule: { readonly offset?: number; readonly time?: string; readonly minutes?: number } = {},
  extra: Partial<Item> = {},
): Item => ({
  templateKey,
  kind: 'action',
  title,
  ...(schedule.offset === undefined ? {} : { relativeDayOffset: schedule.offset }),
  ...(schedule.time === undefined ? {} : { localStartTime: schedule.time as WallTime }),
  ...(schedule.minutes === undefined ? {} : { durationMinutes: schedule.minutes }),
  ...extra,
});

export const builtInTemplates: readonly BuiltInTemplate[] = Object.freeze([
  {
    id: '00000000-0000-4000-a000-000000000001' as UUID,
    title: 'Weekly Reset',
    description: 'A short planning pass: look back, clear decisions, and choose a small week.',
    blueprint: {
      version: 2,
      items: [
        action(
          'review',
          'Review last week',
          { offset: 0, time: '09:00', minutes: 10 },
          { energy: 'low' },
        ),
        action('inbox', 'Decide on waiting Inbox items', { offset: 0, time: '09:10', minutes: 10 }),
        action('fixed', 'Check fixed times and available windows', {
          offset: 0,
          time: '09:20',
          minutes: 10,
        }),
        action(
          'choose',
          'Choose up to three commitments for the week',
          { offset: 0, time: '09:30', minutes: 10 },
          { priority: 'high' },
        ),
      ],
    },
  },
  {
    id: '00000000-0000-4000-a000-000000000002' as UUID,
    title: 'Study Week',
    description: 'Steady study sessions across the week with review and a self-test.',
    blueprint: {
      version: 2,
      items: [
        {
          templateKey: 'project',
          kind: 'project',
          title: 'Study week',
          note: 'Cover this week’s material with steady practice and review.',
          relativeDayOffset: 0,
        },
        action(
          'notes',
          'Review lecture notes',
          { offset: 0, time: '18:00', minutes: 60 },
          { parentTemplateKey: 'project', energy: 'focused' },
        ),
        action(
          'practice-1',
          'Practice problem set',
          { offset: 1, time: '18:00', minutes: 60 },
          { parentTemplateKey: 'project', energy: 'focused' },
        ),
        action(
          'summary',
          'Summarize one topic in your own words',
          { offset: 2, time: '18:00', minutes: 45 },
          { parentTemplateKey: 'project' },
        ),
        action(
          'practice-2',
          'Practice problem set',
          { offset: 3, time: '18:00', minutes: 60 },
          { parentTemplateKey: 'project', energy: 'focused' },
        ),
        action(
          'self-test',
          'Self-test and list open questions',
          { offset: 4, time: '17:00', minutes: 45 },
          { parentTemplateKey: 'project' },
        ),
        action(
          'light',
          'Light review',
          { offset: 5 },
          { parentTemplateKey: 'project', energy: 'low' },
        ),
      ],
    },
  },
  {
    id: '00000000-0000-4000-a000-000000000003' as UUID,
    title: 'Product Sprint',
    description: 'One focused week toward a usable increment, ending with a demo and notes.',
    blueprint: {
      version: 2,
      items: [
        {
          templateKey: 'project',
          kind: 'project',
          title: 'Product sprint',
          note: 'Ship one usable increment.',
          relativeDayOffset: 0,
        },
        action(
          'goal',
          'Define the sprint goal and scope',
          { offset: 0, time: '09:00', minutes: 60 },
          { parentTemplateKey: 'project', energy: 'focused', priority: 'high' },
        ),
        action(
          'build',
          'Build the core change',
          { offset: 1 },
          { parentTemplateKey: 'project', energy: 'focused' },
        ),
        action('test', 'Test and refine', { offset: 2 }, { parentTemplateKey: 'project' }),
        action(
          'review',
          'Review and fix open issues',
          { offset: 3 },
          { parentTemplateKey: 'project' },
        ),
        action(
          'demo',
          'Demo and write release notes',
          { offset: 4, time: '15:00', minutes: 60 },
          { parentTemplateKey: 'project' },
        ),
        {
          templateKey: 'retro',
          kind: 'note',
          title: 'Sprint retrospective',
          parentTemplateKey: 'project',
        },
      ],
    },
  },
  {
    id: '00000000-0000-4000-a000-000000000004' as UUID,
    title: 'Research Block',
    description: 'One protected morning to frame a question, read, and synthesize.',
    blueprint: {
      version: 2,
      items: [
        action(
          'frame',
          'Frame the research question',
          { offset: 0, time: '09:00', minutes: 30 },
          { energy: 'focused' },
        ),
        action(
          'read',
          'Read and annotate sources',
          { offset: 0, time: '09:30', minutes: 90 },
          { energy: 'focused' },
        ),
        action('synthesize', 'Synthesize findings', { offset: 0, time: '11:15', minutes: 45 }),
        { templateKey: 'notes', kind: 'note', title: 'Research notes' },
      ],
    },
  },
  {
    id: '00000000-0000-4000-a000-000000000005' as UUID,
    title: 'Balanced Day',
    description: 'Two focus sessions with movement, admin time, and a short plan for tomorrow.',
    blueprint: {
      version: 2,
      items: [
        action(
          'focus-1',
          'Deep work session',
          { offset: 0, time: '09:00', minutes: 90 },
          { energy: 'focused' },
        ),
        action(
          'move',
          'Movement break',
          { offset: 0, time: '10:45', minutes: 20 },
          { energy: 'low' },
        ),
        action(
          'admin',
          'Admin and messages',
          { offset: 0, time: '13:00', minutes: 45 },
          { energy: 'low' },
        ),
        action(
          'focus-2',
          'Second focus session',
          { offset: 0, time: '14:00', minutes: 60 },
          { energy: 'focused' },
        ),
        action('tomorrow', 'Plan tomorrow', { offset: 0, time: '17:00', minutes: 15 }),
      ],
    },
  },
]);

export const findBuiltInTemplate = (id: string): BuiltInTemplate | undefined =>
  builtInTemplates.find((template) => template.id === id);
