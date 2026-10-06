/**
 * Downloads for account files. A file is handed to the browser through a
 * short-lived object URL that names no content; nothing is cached, logged, or put in a page URL.
 */
import { useEffect, useState } from 'react';

/** How long an object URL outlives the click that started its download. */
const revokeAfterMs = 60_000;

/** Start the browser download of a prepared file. */
export function saveFile(file: { readonly fileName: string; readonly blob: Blob }): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

/** An object URL for `blob` while it is shown, revoked when it changes or the view leaves. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
