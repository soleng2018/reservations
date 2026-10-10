"use client";

import { toastManager } from "@/components/notify";
import { Toaster } from "@/components/ui/toast";

// The single toast region for admin and learner pages. A client boundary,
// because the manager is not serializable across from the root layout.
export function ToastRegion() {
  return <Toaster toastManager={toastManager} />;
}
