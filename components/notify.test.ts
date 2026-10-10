import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyError, notifySuccess, toastManager } from "./notify";

// The toast queue is Base UI's; what these helpers own is the message, the
// type, the timeout, and the announcement priority they hand it (AC-9).
describe("notify", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // covers: AC-9, success toast gone after 4s, polite announcement
  it("queues a success as a low priority toast that lasts 4 seconds", () => {
    const add = vi.spyOn(toastManager, "add");
    notifySuccess("Created Basic.");
    expect(add).toHaveBeenCalledWith({
      title: "Created Basic.",
      type: "success",
      timeout: 4000,
      priority: "low",
    });
  });

  // covers: AC-9, error toast gone after 8s, assertive announcement
  it("queues an error as a high priority toast that lasts 8 seconds", () => {
    const add = vi.spyOn(toastManager, "add");
    notifyError("Something went wrong. Try again.");
    expect(add).toHaveBeenCalledWith({
      title: "Something went wrong. Try again.",
      type: "error",
      timeout: 8000,
      priority: "high",
    });
  });
});
