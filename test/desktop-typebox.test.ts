import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const typeboxDirectory = path.dirname(path.dirname(require.resolve("typebox")));

describe("desktop TypeBox runtime", () => {
  it("shares one TypeBox installation with Pi", () => {
    for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent"]) {
      const piRequire = createRequire(
        path.resolve("node_modules", "@earendil-works", name, "package.json"),
      );
      expect(piRequire.resolve("typebox")).toBe(require.resolve("typebox"));
    }
  });

  it("preserves public entry points and shared format validation after bundling", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-desktop-typebox-"),
    );
    try {
      const packageDirectory = path.join(directory, "node_modules", "typebox");
      await cp(typeboxDirectory, packageDirectory, { recursive: true });
      const hookUrl = pathToFileURL(
        path.resolve("scripts", "prepare-desktop-typebox.mjs"),
      ).href;
      const check = path.join(directory, "check.mjs");
      await writeFile(
        check,
        `
        import assert from "node:assert/strict";
        import { cp } from "node:fs/promises";
        import prepareDesktopTypeBox from ${JSON.stringify(hookUrl)};
        await prepareDesktopTypeBox({ packager: { info: { appDir: ${JSON.stringify(directory)} } } });
        await cp(${JSON.stringify(path.join(directory, ".runtime", "typebox"))}, ${JSON.stringify(path.join(packageDirectory, "build"))}, { recursive: true });

        const { Type } = await import("typebox");
        const { Compile } = await import("typebox/compile");
        const { Value } = await import("typebox/value");
        const { Format } = await import("typebox/format");
        for (const entry of ["error", "guard", "schema", "system", "type"]) await import("typebox/" + entry);
        Format.Set("desktop-id", value => value.startsWith("project-"));
        const schema = Type.Object({
          id: Type.String({ format: "desktop-id" }),
          count: Type.Integer({ minimum: 1 }),
          note: Type.Optional(Type.String()),
        }, { additionalProperties: false });
        const validator = Compile(schema);
        const valid = { id: "project-7", count: 2 };
        assert(validator.Check(valid));
        assert(Value.Check(schema, valid));
        for (const invalid of [
          { id: "wrong", count: 2 },
          { id: "project-7", count: 0 },
          { id: "project-7", count: 2, extra: true },
        ]) {
          assert(!validator.Check(invalid));
          assert(!Value.Check(schema, invalid));
          assert([...Value.Errors(schema, invalid)].length > 0);
        }
      `,
      );
      await promisify(execFile)("node", [check]);
      expect(
        await readFile(path.join(packageDirectory, "package.json"), "utf8"),
      ).toBe(
        await readFile(path.join(typeboxDirectory, "package.json"), "utf8"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
