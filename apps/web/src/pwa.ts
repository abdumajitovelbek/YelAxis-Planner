import { registerSW } from 'virtual:pwa-register';

export type PwaUpdateController = Readonly<{
  activate(): Promise<void>;
  dismiss(): void;
}>;

export function registerPwaUpdates(onUpdateReady: (controller: PwaUpdateController) => void): void {
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      onUpdateReady({
        activate: async () => {
          await update(true);
        },
        dismiss: () => undefined,
      });
    },
    onRegisteredSW(_url, registration) {
      if (registration === undefined) return;
      window.setInterval(
        () => {
          if (navigator.onLine) void registration.update();
        },
        60 * 60 * 1000,
      );
    },
  });
}
