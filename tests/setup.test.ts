import { describe, it, expect } from "vitest";

describe("test infrastructure", () => {
  it("vitest runs successfully", () => {
    expect(true).toBe(true);
  });

  it("can import obsidian mock", async () => {
    const obsidian = await import("obsidian");
    expect(obsidian.Plugin).toBeDefined();
    expect(obsidian.ItemView).toBeDefined();
    expect(obsidian.Notice).toBeDefined();
  });
});
