import type { CalendarDate, OwnerId, UUID } from '@yelaxis/domain';

export const searchEntityKinds = [
  'action',
  'note',
  'axis',
  'outcome',
  'project',
  'milestone',
  'routine',
  'review',
  'review_decision',
] as const;
export type SearchEntityKind = (typeof searchEntityKinds)[number];
export const searchDateBases = ['updated', 'created', 'due', 'planned'] as const;
export type SearchDateBasis = (typeof searchDateBases)[number];
export const searchStates = [
  'active',
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
  'completed',
  'canceled',
  'idea',
  'blocked',
  'paused',
  'achieved',
  'abandoned',
  'draft',
  'skipped',
  'archived',
] as const;
export type SearchState = (typeof searchStates)[number];

/** A bounded local projection. A cursor belongs to the exact query that produced it. */
export interface SearchRequest {
  readonly text: string;
  readonly kind?: SearchEntityKind;
  readonly state?: SearchState;
  readonly archive: 'exclude' | 'include' | 'only';
  readonly axisId?: UUID;
  readonly projectId?: UUID;
  readonly dateBasis: SearchDateBasis;
  readonly from?: CalendarDate;
  readonly to?: CalendarDate;
  readonly cursor?: string;
}
export interface SearchSummary {
  readonly kind: SearchEntityKind;
  readonly id: UUID;
  readonly title: string;
  readonly excerpt: string;
  readonly state: string;
  readonly archived: boolean;
  readonly updatedAt: string;
}
export interface SearchDetail extends Omit<SearchSummary, 'excerpt'> {
  readonly text: string;
  readonly createdAt: string;
  readonly axisId?: UUID;
  readonly projectId?: UUID;
  readonly review?: {
    readonly type: 'daily' | 'weekly' | 'monthly' | 'yearly';
    readonly key: string;
  };
}
export interface SearchPage {
  readonly items: readonly SearchSummary[];
  readonly nextCursor?: string;
}
export interface SearchFilterChoices {
  readonly axes: readonly { readonly id: UUID; readonly title: string }[];
  readonly projects: readonly { readonly id: UUID; readonly title: string }[];
  readonly truncated: boolean;
}
export interface SearchQueryPort {
  readonly search: (ownerId: OwnerId, request: SearchRequest, limit: number) => Promise<SearchPage>;
  readonly detail: (
    ownerId: OwnerId,
    kind: SearchEntityKind,
    id: UUID,
  ) => Promise<SearchDetail | null>;
  readonly choices: (ownerId: OwnerId, limit: number) => Promise<SearchFilterChoices>;
}
export interface SearchApplication {
  readonly search: (request: unknown) => Promise<SearchPage>;
  readonly detail: (kind: unknown, id: unknown) => Promise<SearchDetail | null>;
  readonly choices: () => Promise<SearchFilterChoices>;
}
