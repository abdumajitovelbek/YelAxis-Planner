import { layoutTokens } from './tokens';

export type ControlSemanticRole =
  'adjustable' | 'button' | 'checkbox' | 'link' | 'radio' | 'switch' | 'tab';

export type AccessibilityIssue =
  | 'color_only_state'
  | 'gesture_without_alternative'
  | 'missing_label'
  | 'missing_role'
  | 'touch_target_too_small';

export interface AccessibleControlContract {
  readonly label?: string;
  readonly role?: ControlSemanticRole;
  readonly width: number;
  readonly height: number;
  readonly usesGesture?: boolean;
  readonly hasVisibleGestureAlternative?: boolean;
  readonly conveysStateWithColor?: boolean;
  readonly hasTextOrIconStateCue?: boolean;
}

export interface HitSlop {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

function isCompliantDimension(value: number): boolean {
  return Number.isFinite(value) && value >= layoutTokens.minimumTouchTarget;
}

export function meetsMinimumTouchTarget(width: number, height: number): boolean {
  return isCompliantDimension(width) && isCompliantDimension(height);
}

export function requiredHitSlop(width: number, height: number): HitSlop {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    throw new RangeError('Control dimensions must be finite, non-negative values.');
  }

  const horizontal = Math.max(0, (layoutTokens.minimumTouchTarget - width) / 2);
  const vertical = Math.max(0, (layoutTokens.minimumTouchTarget - height) / 2);

  return {
    top: vertical,
    right: horizontal,
    bottom: vertical,
    left: horizontal,
  };
}

export function auditAccessibleControl(
  contract: AccessibleControlContract,
): readonly AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];

  if (contract.label?.trim() === '' || contract.label === undefined) {
    issues.push('missing_label');
  }
  if (contract.role === undefined) {
    issues.push('missing_role');
  }
  if (!meetsMinimumTouchTarget(contract.width, contract.height)) {
    issues.push('touch_target_too_small');
  }
  if (contract.usesGesture === true && contract.hasVisibleGestureAlternative !== true) {
    issues.push('gesture_without_alternative');
  }
  if (contract.conveysStateWithColor === true && contract.hasTextOrIconStateCue !== true) {
    issues.push('color_only_state');
  }

  return issues;
}
