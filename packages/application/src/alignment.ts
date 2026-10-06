import type { AlignmentApplication, AlignmentQueryPort } from './alignment-contracts';
import { createAlignmentKit } from './alignment-kit';
import { createAlignmentLifecycleCommands } from './alignment-lifecycle';
import { createAlignmentLinkCommands } from './alignment-links';
import { createAlignmentObjectCommands } from './alignment-objects';
import { createAlignmentProjections } from './alignment-projections';
import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';
import type { ApplicationDependencies } from './ports';
import { alignmentInputContracts } from './earlier-command-input';
import { guardInputMethods } from './runtime-input';

/**
 * alignment manual alignment facade. Every call is serialized on the queue the composition
 * root shares with the Action and planning facades, because the browser owns one SQLite worker
 * connection; each command keeps its own application-owned transaction.
 */
export function createAlignmentApplication(
  dependencies: ApplicationDependencies,
  queries: AlignmentQueryPort,
  options: { readonly queue?: SerialQueue } = {},
): AlignmentApplication {
  const kit = createAlignmentKit(dependencies, queries);
  const application: AlignmentApplication = {
    ...createAlignmentProjections(kit),
    ...createAlignmentObjectCommands(kit),
    ...createAlignmentLinkCommands(kit),
    ...createAlignmentLifecycleCommands(kit),
  };
  return serializeMethods(
    guardInputMethods(application, alignmentInputContracts),
    options.queue ?? createSerialQueue(),
  );
}
