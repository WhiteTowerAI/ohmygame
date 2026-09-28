import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compilePlayableGraph,
  PlayableCompilerError,
} from "../src/daemon/playable-compiler.js";
import type { PlayableGraph } from "../src/shared/playable-nodes.js";
import { createPlayableGraphFixture } from "./playable-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Playable compiler", () => {
  it("compiles Nodes and Shell with Shared Modules and project dependencies", async () => {
    const { workspace, graph } = await createCompilerWorkspace();

    const result = await compilePlayableGraph(workspace, graph);
    const menu = result.nodes.menu!;

    expect(result.version).toBe(1);
    expect(Object.keys(result.nodes)).toEqual(["menu", "lobby", "archive"]);
    expect(menu.html).toContain("data-menu");
    expect(menu.javascript).toContain("from-shared");
    expect(menu.javascript).toContain("from-package");
    expect(menu.javascript).toContain("export");
    expect(menu.css).toContain("display: flex");
    expect(menu.css).toContain("data:image/svg+xml");
    expect(menu.inputs).toEqual(
      expect.arrayContaining([
        "node_modules/tiny-dep/index.js",
        "nodes/menu/index.html",
        "nodes/menu/node.js",
        "nodes/menu/style.css",
        "shared/action-bar.js",
        "shared/action-bar.css",
        "shared/pixel.svg",
      ]),
    );
    expect(result.shell?.javascript).toContain("from-shared");
    expect(result.shell?.inputs).toContain("shared/action-bar.js");
  });

  it("supports production minification and inline source maps", async () => {
    const { workspace, graph } = await createCompilerWorkspace();

    const result = await compilePlayableGraph(workspace, graph, {
      minify: true,
      sourcemap: true,
    });

    expect(result.nodes.menu!.javascript).toContain(
      "sourceMappingURL=data:application/json;base64,",
    );
    expect(result.nodes.menu!.javascript.length).toBeLessThan(2_000);
  });

  it("uses import and require package export conditions according to the import kind", async () => {
    const { workspace, graph } = await createCompilerWorkspace();
    await writeConditionalPackage(
      path.join(workspace, "node_modules", "conditional-dep"),
    );
    await writeFile(
      path.join(workspace, "nodes", "menu", "node.js"),
      [
        'import { marker as importMarker } from "conditional-dep";',
        'const { marker: requireMarker } = require("conditional-dep");',
        "export function mount() { return [importMarker, requireMarker]; }",
        "",
      ].join("\n"),
    );

    const result = await compilePlayableGraph(workspace, graph);

    expect(result.nodes.menu!.javascript).toContain("IMPORT_BRANCH");
    expect(result.nodes.menu!.javascript).toContain("REQUIRE_BRANCH");
  });

  it("rejects source files that are symlinks outside the workspace", async () => {
    const { root, workspace, graph } = await createCompilerWorkspace();
    const outside = path.join(root, "outside.html");
    await writeFile(outside, "<main>outside</main>");
    await rm(path.join(workspace, "nodes", "menu", "index.html"));
    await symlink(outside, path.join(workspace, "nodes", "menu", "index.html"));

    await expect(compilePlayableGraph(workspace, graph)).rejects.toMatchObject({
      code: "path-outside-workspace",
      surfaceId: "menu",
    });
  });

  it("rejects relative imports that escape the workspace", async () => {
    const { root, workspace, graph } = await createCompilerWorkspace();
    await writeFile(
      path.join(root, "outside.js"),
      'export const value = "outside";\n',
    );
    await writeFile(
      path.join(workspace, "nodes", "menu", "node.js"),
      'export { value as mount } from "../../../outside.js";\n',
    );

    await expect(compilePlayableGraph(workspace, graph)).rejects.toMatchObject({
      code: "path-outside-workspace",
      surfaceId: "menu",
    });
    await expect(compilePlayableGraph(workspace, graph)).rejects.toThrow(
      "resolves outside the project workspace",
    );
  });

  it("rejects dependencies resolved from a parent node_modules", async () => {
    const { root, workspace, graph } = await createCompilerWorkspace({
      dependency: false,
    });
    await writePackage(path.join(root, "node_modules", "tiny-dep"));

    await expect(compilePlayableGraph(workspace, graph)).rejects.toThrow(
      "resolves outside the project workspace",
    );
  });

  it("reports missing surface source files with a stable error code", async () => {
    const { workspace, graph } = await createCompilerWorkspace();
    await rm(path.join(workspace, "nodes", "archive", "node.js"));

    await expect(compilePlayableGraph(workspace, graph)).rejects.toEqual(
      expect.objectContaining<Partial<PlayableCompilerError>>({
        code: "missing-source",
        surfaceId: "archive",
      }),
    );
  });

  it("requires every Node and Shell module to export mount", async () => {
    const { workspace, graph } = await createCompilerWorkspace();
    await writeFile(
      path.join(workspace, "nodes", "archive", "node.js"),
      "export const title = 'No mount';\n",
    );

    await expect(compilePlayableGraph(workspace, graph)).rejects.toMatchObject({
      code: "build-failed",
      surfaceId: "archive",
      message: 'Playable surface "archive" JavaScript must export "mount".',
    });
  });
});

async function createCompilerWorkspace(
  options: { dependency?: boolean } = {},
): Promise<{
  root: string;
  workspace: string;
  graph: PlayableGraph;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ohmygame-playable-compiler-"),
  );
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const graph = createPlayableGraphFixture();
  await Promise.all([
    mkdir(path.join(workspace, "nodes", "menu"), { recursive: true }),
    mkdir(path.join(workspace, "nodes", "lobby"), { recursive: true }),
    mkdir(path.join(workspace, "nodes", "archive"), { recursive: true }),
    mkdir(path.join(workspace, "shell"), { recursive: true }),
    mkdir(path.join(workspace, "shared"), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      path.join(workspace, "nodes", "menu", "index.html"),
      '<main data-menu="true"></main>\n',
    ),
    writeFile(
      path.join(workspace, "nodes", "menu", "style.css"),
      '@import "../../shared/action-bar.css";\n.menu { color: white; }\n',
    ),
    writeFile(
      path.join(workspace, "nodes", "menu", "node.js"),
      [
        'import { sharedLabel } from "../../shared/action-bar.js";',
        'import { packageLabel } from "tiny-dep";',
        "export function mount(context) {",
        "  context.root.body.dataset.label = sharedLabel + packageLabel;",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(workspace, "shared", "action-bar.js"),
      'export const sharedLabel = "from-shared";\n',
    ),
    writeFile(
      path.join(workspace, "shared", "action-bar.css"),
      '.action-bar { display: flex; background-image: url("./pixel.svg"); }\n',
    ),
    writeFile(
      path.join(workspace, "shared", "pixel.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
    ),
    writeFile(path.join(workspace, "shell", "index.html"), "<nav></nav>\n"),
    writeFile(
      path.join(workspace, "shell", "style.css"),
      "nav { position: fixed; }\n",
    ),
    writeFile(
      path.join(workspace, "shell", "shell.js"),
      'import { sharedLabel } from "../shared/action-bar.js"; export function mount() { return sharedLabel; }\n',
    ),
  ]);
  for (const nodeId of ["lobby", "archive"]) {
    await Promise.all([
      writeFile(
        path.join(workspace, "nodes", nodeId, "index.html"),
        `<main>${nodeId}</main>\n`,
      ),
      writeFile(
        path.join(workspace, "nodes", nodeId, "style.css"),
        "main { display: block; }\n",
      ),
      writeFile(
        path.join(workspace, "nodes", nodeId, "node.js"),
        "export function mount() {}\n",
      ),
    ]);
  }
  if (options.dependency !== false)
    await writePackage(path.join(workspace, "node_modules", "tiny-dep"));
  return { root, workspace, graph };
}

async function writePackage(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ name: "tiny-dep", version: "1.0.0", type: "module", exports: "./index.js" })}\n`,
    ),
    writeFile(
      path.join(directory, "index.js"),
      'export const packageLabel = "from-package";\n',
    ),
  ]);
}

async function writeConditionalPackage(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({
        name: "conditional-dep",
        version: "1.0.0",
        exports: { import: "./import.js", require: "./require.cjs" },
      })}\n`,
    ),
    writeFile(
      path.join(directory, "import.js"),
      'export const marker = "IMPORT_BRANCH";\n',
    ),
    writeFile(
      path.join(directory, "require.cjs"),
      'exports.marker = "REQUIRE_BRANCH";\n',
    ),
  ]);
}
