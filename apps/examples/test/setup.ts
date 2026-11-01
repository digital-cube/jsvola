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
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;

// jsdom has no object URLs and no media playback.
let blobCounter = 0;
URL.createObjectURL = vi.fn(() => `blob:vola/${++blobCounter}`);
URL.revokeObjectURL = vi.fn();
Object.defineProperty(HTMLMediaElement.prototype, "load", { value: vi.fn(), configurable: true });
Object.defineProperty(HTMLMediaElement.prototype, "pause", { value: vi.fn(), configurable: true });

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
