import { createSite } from "./create";

describe("createSite", () => {
  it("throws because the command is not implemented yet", () => {
    expect(() => createSite("my-site")).toThrow(/not implemented/);
  });
});
