import { describe, expect, it } from "vitest";
import { isLookupSection, LOOKUP_SECTIONS } from "../src/index.js";

describe("@vola/lookups skeleton", () => {
  it("names the vocabulary sections", () => {
    expect(LOOKUP_SECTIONS).toContain("instance_types");
    expect(isLookupSection("job_kinds")).toBe(true);
    expect(isLookupSection("colours")).toBe(false);
  });
});
