import type { Clock, IdProvider, OwnerId } from '@yelaxis/domain';

import type { AccountApplication } from './account-application';
import type { CanonicalBundlePort, EncodedBundle } from './account-contracts';
import { exportActionsCsv, exportBlocksCsv, exportReviewsMarkdown } from './exports';
import type { ImportBundle, ImportBundleDecoder } from './import-contracts';
import { serializeMethods, type SerialQueue } from './planning-kit';

export interface ExportPreview {
  readonly recordCount: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly sensitiveContextCount: number;
  readonly includesSensitiveConflict: boolean;
  readonly syncWasPending: boolean;
  readonly exportedAt: string;
}
export type ExportResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'snapshot_failed' | 'preview_missing' | 'verification_failed';
    };
export interface ExportApplication {
  preview(): Promise<ExportResult<ExportPreview>>;
  backup(includeSensitiveContext: boolean): Promise<ExportResult<EncodedBundle>>;
  convenience(kind: 'actions' | 'blocks' | 'reviews'): Promise<ExportResult<string>>;
}

const sensitive = (value: Readonly<Record<string, unknown>> | null) =>
  value?.['sensitivity'] === 'sensitive';

/** Omit sensitive Context and dependent Constraints together, keeping the reduced graph valid. */
export function reducedExport(bundle: ImportBundle): ImportBundle {
  const removed = new Set(
    bundle.records
      .filter((record) => record.type === 'context' && sensitive(record.document))
      .map((record) => record.id as string),
  );
  const records = bundle.records.filter((record) => {
    const omit =
      (record.type === 'context' && removed.has(record.id)) ||
      (record.type === 'constraint' && removed.has(String(record.document['contextId'])));
    if (omit) removed.add(record.id);
    return !omit;
  });
  const openConflicts = bundle.supplement.openConflicts.filter(
    (candidate) =>
      !removed.has(candidate.entityId) &&
      !(
        candidate.entityType === 'context' &&
        [candidate.base, candidate.local.document, candidate.remote.document].some(sensitive)
      ) &&
      !(
        candidate.entityType === 'constraint' &&
        [candidate.base, candidate.local.document, candidate.remote.document].some((side) =>
          removed.has(String(side?.['contextId'])),
        )
      ),
  );
  const settings = bundle.supplement.profileSettings;
  const artifacts =
    settings?.onboardingArtifacts === undefined ? undefined : { ...settings.onboardingArtifacts };
  if (artifacts !== undefined)
    for (const field of [
      'awakeContextId',
      'availabilityContextId',
      'boundaryContextId',
      'availabilityConstraintId',
    ] as const) {
      if (removed.has(artifacts[field] ?? '')) delete artifacts[field];
    }
  return {
    ...bundle,
    records,
    containsSensitiveContext: false,
    supplement: {
      ...bundle.supplement,
      profileSettings:
        settings === null
          ? null
          : {
              ...settings,
              onboardingDraft: null,
              ...(artifacts === undefined ? {} : { onboardingArtifacts: artifacts }),
            },
      openConflicts,
      history: (bundle.supplement.history ?? []).filter((row) => !removed.has(row.entityId)),
      tombstones: (bundle.supplement.tombstones ?? []).filter((row) => !removed.has(row.entityId)),
    },
  };
}

/** A deliberate preview freezes one verified snapshot; later edits remain in the active plan. */
export function createExportApplication(
  dependencies: {
    readonly accounts: Pick<AccountApplication, 'exportBundle'>;
    readonly decoder: ImportBundleDecoder;
    readonly bundles: CanonicalBundlePort;
    readonly ownerId: OwnerId;
    readonly clock: Clock;
    readonly ids: IdProvider;
    readonly appVersion: string;
  },
  options: { readonly queue: SerialQueue },
): ExportApplication {
  let captured: { readonly encoded: EncodedBundle; readonly decoded: ImportBundle } | null = null;
  const application: ExportApplication = {
    async preview() {
      captured = null;
      try {
        const result = await dependencies.accounts.exportBundle();
        if (!result.ok) return { ok: false, code: 'snapshot_failed' };
        const decoded = await dependencies.decoder.decode(result.value.text);
        if (!decoded.ok) return { ok: false, code: 'verification_failed' };
        captured = { encoded: result.value, decoded: decoded.value };
        return {
          ok: true,
          value: {
            recordCount: result.value.recordCount,
            counts: result.value.manifest.recordCounts,
            sensitiveContextCount: decoded.value.records.filter(
              (row) => row.type === 'context' && sensitive(row.document),
            ).length,
            includesSensitiveConflict: decoded.value.supplement.openConflicts.some(
              (candidate) =>
                candidate.entityType === 'context' &&
                [candidate.base, candidate.local.document, candidate.remote.document].some(
                  sensitive,
                ),
            ),
            syncWasPending: result.value.manifest.syncWasPending,
            exportedAt: result.value.exportedAt,
          },
        };
      } catch {
        return { ok: false, code: 'snapshot_failed' };
      }
    },
    async backup(includeSensitiveContext) {
      if (captured === null) return { ok: false, code: 'preview_missing' };
      try {
        const bundle = includeSensitiveContext
          ? captured.encoded
          : await dependencies.bundles.encode({
              snapshot: {
                ownerId: dependencies.ownerId,
                records: reducedExport(captured.decoded).records,
              },
              supplement: reducedExport(captured.decoded).supplement,
              bundleId: dependencies.ids.next(),
              exportedAt: dependencies.clock.now(),
              appVersion: dependencies.appVersion,
              sourceMode: captured.encoded.manifest.sourceMode,
              syncWasPending: captured.encoded.manifest.syncWasPending,
            });
        const verified = await dependencies.bundles.verify(bundle.text);
        if (
          !verified.ok ||
          verified.recordCount !== bundle.recordCount ||
          verified.manifest.dataSha256 !== bundle.manifest.dataSha256
        )
          return { ok: false, code: 'verification_failed' };
        return { ok: true, value: bundle };
      } catch {
        return { ok: false, code: 'verification_failed' };
      }
    },
    convenience(kind) {
      if (captured === null) return Promise.resolve({ ok: false, code: 'preview_missing' });
      const records = captured.decoded.records;
      return Promise.resolve({
        ok: true,
        value:
          kind === 'actions'
            ? exportActionsCsv(records)
            : kind === 'blocks'
              ? exportBlocksCsv(records)
              : exportReviewsMarkdown(records),
      });
    },
  };
  return serializeMethods(application, options.queue);
}
