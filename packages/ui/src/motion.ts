import { motionTokens } from './tokens';

export type MotionPreference = 'system' | 'reduced' | 'full';
export type ResolvedMotionMode = 'reduced' | 'full';
export type MotionKind = 'ambient' | 'feedback' | 'transition';
export type AppActivity = 'active' | 'inactive' | 'background';

export interface MotionRequest {
  readonly preference: MotionPreference;
  readonly systemReduceMotion: boolean;
  readonly kind: MotionKind;
  readonly durationMs: number;
  readonly translatePx?: number;
  readonly appActivity?: AppActivity;
  readonly screenFocused?: boolean;
  readonly allowsOpacity?: boolean;
}

export interface MotionPlan {
  readonly mode: ResolvedMotionMode;
  readonly enabled: boolean;
  readonly durationMs: number;
  readonly translatePx: number;
  readonly usesOpacity: boolean;
}

export function resolveMotionMode(
  preference: MotionPreference,
  systemReduceMotion: boolean,
): ResolvedMotionMode {
  if (preference === 'reduced') {
    return 'reduced';
  }
  if (preference === 'full') {
    return 'full';
  }
  return systemReduceMotion ? 'reduced' : 'full';
}

export function resolveMotionPlan(request: MotionRequest): MotionPlan {
  const mode = resolveMotionMode(request.preference, request.systemReduceMotion);
  const durationMs = Math.max(0, request.durationMs);
  const requestedTranslatePx = request.translatePx ?? 0;
  const translatePx = Number.isFinite(requestedTranslatePx) ? requestedTranslatePx : 0;
  const usesOpacity = request.allowsOpacity !== false;
  const ambientCanRun =
    request.kind !== 'ambient' ||
    ((request.appActivity ?? 'active') === 'active' && (request.screenFocused ?? true));

  if (!ambientCanRun || (mode === 'reduced' && request.kind === 'ambient')) {
    return {
      mode,
      enabled: false,
      durationMs: 0,
      translatePx: 0,
      usesOpacity: false,
    };
  }

  if (mode === 'reduced') {
    const reducedDuration = usesOpacity ? Math.min(durationMs, motionTokens.durationMs.reduced) : 0;
    return {
      mode,
      enabled: reducedDuration > 0,
      durationMs: reducedDuration,
      translatePx: motionTokens.distancePx.reduced,
      usesOpacity: reducedDuration > 0,
    };
  }

  return {
    mode,
    enabled: durationMs > 0,
    durationMs,
    translatePx,
    usesOpacity,
  };
}
