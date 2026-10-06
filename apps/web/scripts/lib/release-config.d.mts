export interface ReleaseConfiguration {
  /** Website hosting is independent of whether optional account sync is configured. */
  readonly target: 'local' | 'hosted';
  /** One canonical backend origin, or null when accounts are unavailable. */
  readonly apiOrigin: string | null;
  readonly revision: string | null;
}
export function readReleaseConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  target?: string,
): ReleaseConfiguration;
export function releaseHeaders(
  configuration: ReleaseConfiguration,
): Readonly<Record<string, string>>;
export function cloudflareHeaders(configuration: ReleaseConfiguration): string;
export function previewHeaders(source: string, pathname?: string): Readonly<Record<string, string>>;
