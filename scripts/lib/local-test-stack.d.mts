export interface LocalTestStackSelection {
  readonly workdir: string;
  readonly binary: string;
  readonly projectId: string;
  readonly apiPort: number;
  readonly apiProtocol: 'http:' | 'https:';
}
export interface LocalTestStack extends LocalTestStackSelection {
  readonly apiUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly jwtSecret: string;
}
export const localTestStackUnavailable: string;
export function selectLocalTestStack(
  repositoryRoot: string,
  workdirOverride?: string,
): LocalTestStackSelection;
export function readLocalTestStack(
  repositoryRoot: string,
  options?: {
    readonly workdirOverride?: string;
    readonly execute?: (
      command: string,
      args: readonly string[],
      options: { readonly encoding: 'utf8'; readonly timeout: number },
    ) => { readonly status: number | null; readonly stdout: string; readonly error?: unknown };
  },
): LocalTestStack;
