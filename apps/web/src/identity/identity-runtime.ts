import { browserClock, browserIdProvider, createAccountApplication } from '@yelaxis/application';
import { createSqliteAccountAdapters, SerializedSqliteDriver } from '@yelaxis/data';

import { deletePlanningDatabase, openPlanningDatabase } from '../persistence';
import { IdentityStores, type IdentityStore, type StoreHost } from './identity-stores';
import {
  accountClientLoader,
  createSupabaseAccountBackend,
  isLocalTestStack,
  readAccountConfiguration,
  type AccountBackend,
  type AccountClientLoader,
} from './supabase-backend';
import { createWebAccountService, type WebAccountService } from './web-account-service';

/** Informational version written into exported bundles. */
export const bundleAppVersion = 'yelaxis-web-0.0.0';

/** Browser persistence for identity stores: one worker, lock, and serialized queue per database. */
export function browserStoreHost(): StoreHost {
  return {
    async open(databaseName) {
      const database = await openPlanningDatabase(databaseName);
      // One queue for the single worker connection: every service's reads and transactions wait
      // their turn instead of overlapping and failing as busy.
      const driver = new SerializedSqliteDriver(database.driver);
      return {
        databaseName,
        driver,
        durability: database.storage.durability,
        close: () => driver.close(),
      };
    },
    remove: (databaseName) => deletePlanningDatabase(databaseName),
    accounts: (driver) =>
      createAccountApplication({
        ...createSqliteAccountAdapters(driver),
        clock: browserClock(),
        ids: browserIdProvider(),
        appVersion: bundleAppVersion,
      }),
  };
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface IdentityRuntime {
  readonly stores: IdentityStores;
  readonly account: WebAccountService;
  /**
   * Loads the one account client for the sync transport (null for a local-only build); supabase-js
   * loads on first use. Its session stays in localStorage under `yelaxis.auth`; nothing may copy a
   * token anywhere else.
   */
  readonly accountClient: AccountClientLoader | null;
  /** Opens the active identity's store once and runs the launch reconciliation. */
  ready(): Promise<IdentityStore>;
  close(): Promise<void>;
}

export interface IdentityRuntimeOptions {
  readonly env?: {
    readonly VITE_YELAXIS_SUPABASE_URL?: string | undefined;
    readonly VITE_YELAXIS_SUPABASE_ANON_KEY?: string | undefined;
  };
  readonly host?: StoreHost;
  readonly storage?: Storage | null;
  /** Tests inject an account backend; the browser builds one from the configuration. */
  readonly backend?: AccountBackend | null;
}

export function createIdentityRuntime(options: IdentityRuntimeOptions = {}): IdentityRuntime {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const configuration = readAccountConfiguration(options.env ?? import.meta.env);
  // Without durable storage a session could not be kept to this site, so accounts stay off.
  const accountClient =
    options.backend === undefined && configuration !== null && storage !== null
      ? accountClientLoader(configuration, storage)
      : null;
  const backend =
    options.backend !== undefined
      ? options.backend
      : accountClient === null
        ? null
        : createSupabaseAccountBackend(accountClient, { storage });
  const stores = new IdentityStores(options.host ?? browserStoreHost(), storage, () =>
    crypto.randomUUID(),
  );
  const account = createWebAccountService({
    backend,
    stores,
    localTestService: configuration !== null && isLocalTestStack(configuration),
  });
  let started: Promise<IdentityStore> | null = null;

  return {
    stores,
    account,
    accountClient,
    ready() {
      started ??= (async () => {
        await stores.open();
        await account.start();
        const current = stores.current();
        if (current === null) throw new Error('The planning store did not open.');
        return current;
      })().catch((error: unknown) => {
        started = null;
        throw error;
      });
      return started.then(() => {
        const current = stores.current();
        if (current === null) throw new Error('The planning store did not open.');
        return current;
      });
    },
    close: () => stores.close(),
  };
}
