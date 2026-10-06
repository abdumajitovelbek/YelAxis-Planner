import { message as uiMessage } from '../messages';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/** True when focus is already on a form field (or explicit target) inside the dialog. */
export function focusIsOnField(container: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    container.contains(active) &&
    active.matches('input, select, textarea, [data-autofocus]')
  );
}

/** Where each dialog's own autofocus last put focus. */
const autofocusTargets = new WeakMap<Element, Element>();

/** Focus `target` for `dialog` and remember it, so a deferred retry can tell a person's move apart. */
export function autofocusIn(dialog: Element, target: HTMLElement | null | undefined): void {
  if (target === null || target === undefined) return;
  target.focus();
  if (document.activeElement === target) autofocusTargets.set(dialog, target);
}

/**
 * Whether a deferred autofocus retry may still move focus in `dialog`: only while focus is outside
 * it (on the page body, or lost with an element that unmounted), on the dialog itself, or still
 * where the dialog's own autofocus put it. Once a person moves focus to any control inside the
 * dialog, with the keyboard, a pointer, or assistive technology, retries leave it there.
 */
export function mayMoveAutofocus(dialog: Element): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === dialog || !dialog.contains(active))
    return true;
  return autofocusTargets.get(dialog) === active;
}

/**
 * Accessible modal built on the native dialog element: focus moves inside on open, Escape closes
 * through `onClose`, and focus returns to the element that opened it.
 */
export function Modal({
  children,
  className,
  description,
  eyebrow,
  onClose,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: string;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
      // Prefer an explicit target, then the first field, and only then any button (the header
      // Close button is first in document order, so a single selector list would always pick it).
      const focusTarget = (): void =>
        autofocusIn(
          element,
          element.querySelector<HTMLElement>('[data-autofocus]') ??
            element.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea') ??
            element.querySelector<HTMLElement>('button'),
        );
      // Children are already rendered: focus now so Close is never announced first. Next frame,
      // move focus only if it has not settled on a field yet (content that mounts after loading);
      // never pull it back from any control the person already moved to.
      focusTarget();
      window.requestAnimationFrame(() => {
        if (mayMoveAutofocus(element) && !focusIsOnField(element)) focusTarget();
      });
    } else if (!open && element.open) {
      element.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected)
        opener.current.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`action-dialog plan-dialog${className === undefined ? '' : ` ${className}`}`}
      aria-labelledby={titleId}
      {...(description === undefined ? {} : { 'aria-describedby': descriptionId })}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog-heading">
            <div>
              {eyebrow !== undefined && <p className="eyebrow">{eyebrow}</p>}
              <h2 id={titleId}>{title}</h2>
            </div>
            <button type="button" className="text-button" onClick={onClose}>
              {uiMessage('actions-ui.221')}
            </button>
          </div>
          {description !== undefined && (
            <p id={descriptionId} className="field-help">
              {description}
            </p>
          )}
          {children}
        </>
      )}
    </dialog>
  );
}
