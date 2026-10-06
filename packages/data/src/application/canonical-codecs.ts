import type {
  AppliedCanonicalChange,
  CanonicalMutation,
  CanonicalRecordState,
} from '@yelaxis/application';
import type { CommandContext, EntityRef, EntityType } from '@yelaxis/domain';

import type { SqliteQueryConnection } from '../sqlite/driver';
import { actionCanonicalCodec } from './action-codec';
import { DataAdapterError } from './errors';
import { contextCanonicalCodec } from './context-codec';
import { horizonCanonicalCodecs } from './horizon-codecs';
import { planningCanonicalCodecs } from './planning-codecs';
import { profilePlanningCodec } from './profile-codec';
import { relationshipCanonicalCodecs } from './relationship-codecs';
import { reviewCanonicalCodecs } from './review-codecs';
import { routineCanonicalCodecs } from './routine-codecs';

export interface CanonicalRecordCodec {
  readonly entityType: EntityType;
  read(connection: SqliteQueryConnection, ref: EntityRef): Promise<CanonicalRecordState | null>;
  apply(
    connection: SqliteQueryConnection,
    mutation: CanonicalMutation,
    context: CommandContext,
  ): Promise<AppliedCanonicalChange>;
}

export class CanonicalCodecRegistry {
  readonly #codecs: ReadonlyMap<EntityType, CanonicalRecordCodec>;

  constructor(codecs: readonly CanonicalRecordCodec[]) {
    const byType = new Map<EntityType, CanonicalRecordCodec>();
    for (const codec of codecs) {
      if (byType.has(codec.entityType)) throw new DataAdapterError('unsupported_entity_type');
      byType.set(codec.entityType, codec);
    }
    this.#codecs = byType;
  }

  resolve(entityType: EntityType): CanonicalRecordCodec {
    const codec = this.#codecs.get(entityType);
    if (codec === undefined) throw new DataAdapterError('unsupported_entity_type');
    return codec;
  }
}

export function createDefaultCanonicalCodecRegistry(): CanonicalCodecRegistry {
  return new CanonicalCodecRegistry([
    actionCanonicalCodec,
    ...planningCanonicalCodecs,
    ...routineCanonicalCodecs,
    ...horizonCanonicalCodecs,
    ...relationshipCanonicalCodecs,
    ...reviewCanonicalCodecs,
    profilePlanningCodec,
    // account sync: Context replicates like every other record (onboarding still writes its rows).
    contextCanonicalCodec,
  ]);
}
