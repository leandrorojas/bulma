import { VERSION } from "./version";

describe("VERSION", () => {
  it("is a semver-formatted string", () => {
    expect(typeof VERSION).toBe("string");
    // semver core (major.minor.patch), optional prerelease suffix
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
