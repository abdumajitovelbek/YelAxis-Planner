import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';
import type { ApplicationDependencies } from './ports';
import type { TodayApplication, TodayQueryPort } from './today-contracts';
import { createTodayEndDay } from './today-end-day';
import { createTodayFocus } from './today-focus';
import { createTodayKit } from './today-kit';
import { createTodayView } from './today-view';
import { todayInputContracts } from './earlier-command-input';
import { guardInputMethods } from './runtime-input';

/**
 * Today and Focus manual Today and Focus facade. Every call is serialized on the queue the
 * composition root shares with the Action, planning, and alignment facades, because the browser
 * owns one SQLite worker connection; each command keeps its own application-owned transaction.
 */
export function createTodayApplication(
  dependencies: ApplicationDependencies,
  queries: TodayQueryPort,
  options: { readonly queue?: SerialQueue } = {},
): TodayApplication {
  const kit = createTodayKit(dependencies, queries);
  const application: TodayApplication = {
    ...createTodayView(kit),
    ...createTodayFocus(kit),
    ...createTodayEndDay(kit),
  };
  return serializeMethods(
    guardInputMethods(application, todayInputContracts),
    options.queue ?? createSerialQueue(),
  );
}
