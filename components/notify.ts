import { createToastManager } from "@/components/ui/toast";

// The one toast queue (spec 0005 AC-9), mounted by ToastRegion in the root
// layout. A module constant, like the other lazy singletons: it only ever
// runs in the browser, where client components call these helpers.
export const toastManager = createToastManager();

// Low priority: a polite announcement, gone after 4 seconds.
export function notifySuccess(message: string): void {
  toastManager.add({
    title: message,
    type: "success",
    timeout: 4000,
    priority: "low",
  });
}

// High priority: an assertive announcement, with a Close button, 8 seconds.
export function notifyError(message: string): void {
  toastManager.add({
    title: message,
    type: "error",
    timeout: 8000,
    priority: "high",
  });
}
