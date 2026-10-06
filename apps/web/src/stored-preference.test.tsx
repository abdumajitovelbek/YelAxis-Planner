// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useStoredPreference } from './stored-preference';

const choices = ['system', 'light', 'dark'] as const;
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it('opens with the default when storage access is denied and changes the in-memory choice', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Denied', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Denied', 'SecurityError');
  });
  const { result } = renderHook(() => useStoredPreference('theme', 'system', choices));
  expect(result.current[0]).toBe('system');
  act(() => result.current[1]('light'));
  expect(result.current[0]).toBe('light');
});

it('rejects corrupt saved preferences and retains the choice when persistence runs out of space', () => {
  localStorage.setItem('theme', 'invalid');
  const { result } = renderHook(() => useStoredPreference('theme', 'system', choices));
  expect(result.current[0]).toBe('system');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError');
  });
  act(() => result.current[1]('dark'));
  expect(result.current[0]).toBe('dark');
});

it('reads and persists a valid preference', () => {
  localStorage.setItem('theme', 'light');
  const { result } = renderHook(() => useStoredPreference('theme', 'system', choices));
  expect(result.current[0]).toBe('light');
  act(() => result.current[1]('dark'));
  expect(localStorage.getItem('theme')).toBe('dark');
});
