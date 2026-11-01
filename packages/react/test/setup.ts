import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom lacks these; Radix only needs them to exist.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;

// jsdom has no object URLs: count them instead.
let blobCounter = 0;
URL.createObjectURL = vi.fn(() => `blob:vola/${++blobCounter}`);
URL.revokeObjectURL = vi.fn();

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(URL.createObjectURL).mockClear();
  vi.mocked(URL.revokeObjectURL).mockClear();
});
