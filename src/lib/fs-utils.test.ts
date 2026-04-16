import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyDir, pathExists, removeDir } from "./fs-utils";

describe("fs-utils (integration against real tmp dir)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bulma-fs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe("copyDir", () => {
    it("recursively copies files and subdirectories", async () => {
      const src = path.join(tmpRoot, "src");
      const dest = path.join(tmpRoot, "dest");
      await fs.mkdir(path.join(src, "sub"), { recursive: true });
      await fs.writeFile(path.join(src, "root.txt"), "root-content");
      await fs.writeFile(path.join(src, "sub", "nested.txt"), "nested-content");

      await copyDir(src, dest);

      expect(await fs.readFile(path.join(dest, "root.txt"), "utf8")).toBe("root-content");
      expect(await fs.readFile(path.join(dest, "sub", "nested.txt"), "utf8")).toBe("nested-content");
    });

    it("creates the destination if it does not exist", async () => {
      const src = path.join(tmpRoot, "src");
      await fs.mkdir(src);
      await fs.writeFile(path.join(src, "a"), "a");

      const dest = path.join(tmpRoot, "does", "not", "exist");
      await copyDir(src, dest);
      expect(await fs.readFile(path.join(dest, "a"), "utf8")).toBe("a");
    });
  });

  describe("removeDir", () => {
    it("removes an existing directory tree", async () => {
      const dir = path.join(tmpRoot, "victim");
      await fs.mkdir(path.join(dir, "inner"), { recursive: true });
      await fs.writeFile(path.join(dir, "file.txt"), "x");

      await removeDir(dir);
      expect(await pathExists(dir)).toBe(false);
    });

    it("does not throw when directory is already gone", async () => {
      await expect(removeDir(path.join(tmpRoot, "ghost"))).resolves.toBeUndefined();
    });
  });

  describe("pathExists", () => {
    it("returns true for existing paths", async () => {
      const p = path.join(tmpRoot, "here");
      await fs.writeFile(p, "");
      expect(await pathExists(p)).toBe(true);
    });

    it("returns false for missing paths", async () => {
      expect(await pathExists(path.join(tmpRoot, "nope"))).toBe(false);
    });
  });
});
