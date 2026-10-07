import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudRoot = path.resolve(
  process.env.OHMYGAME_CLOUD_ROOT ??
    process.env.OHMYGAME_WEB_ROOT ??
    path.join(root, "..", "ohmygame-cloud"),
);
const groups = ["shared", "daemon", "renderer", "desktop"];
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, "").split("=");
    return [key, value.length ? value.join("=") : true];
  }),
);
assert(
  Object.keys(options).every((key) =>
    ["runs", "mutant", "dry-run", "resume"].includes(key),
  ),
  "Unknown option",
);
const repetitions = Number(options.runs ?? 3);
assert(
  Number.isInteger(repetitions) && repetitions >= 1,
  "--runs must be a positive integer",
);

// One feature or safeguard is removed per mutation. Exact matches fail closed after source changes.
const mutants = [
  {
    id: "S1",
    file: "src/shared/playable-navigation.ts",
    feature: "Navigation push history",
    before: "[...state.backStack, state.currentNodeId]",
    after: "[...state.backStack]",
    verify: "shared",
  },
  {
    id: "S2",
    file: "src/shared/playable-state.ts",
    feature: "State snapshot cloning",
    before: "return structuredClone(value);",
    after: "return value;",
  },
  {
    id: "S3",
    file: "src/shared/agent-models.ts",
    feature: "Explicit model priority",
    before:
      "findAgentModel(models, selected) ?? findAgentModel(models, configuredDefault)",
    after:
      "findAgentModel(models, configuredDefault) ?? findAgentModel(models, selected)",
  },
  {
    id: "D1",
    file: "src/daemon/access.ts",
    feature: "Bearer token equality",
    before:
      "return actual.length === expected.length && timingSafeEqual(actual, expected);",
    after: "return true;",
  },
  {
    id: "D2",
    file: "src/daemon/package-manager.ts",
    feature: "Configured package manager",
    before: "if (configured) return configured;",
    after: "",
    verify: "daemon",
  },
  {
    id: "D3",
    file: "src/daemon/prompt-context.ts",
    feature: "Private editor context extraction",
    before: "const index = value.lastIndexOf(OPENING);",
    after: "const index = -1;",
  },
  {
    id: "R1",
    file: "src/renderer/state.ts",
    feature: "Conversation event isolation",
    before:
      "if (conversationScopedEvent && (!conversation || event.conversationId !== conversation.id)) return next;",
    after: "",
    verify: "renderer",
  },
  {
    id: "R2",
    file: "src/renderer/prompt-history.ts",
    feature: "Draft restoration",
    before:
      "prompt: index === history.entries.length ? history.draft : history.entries[index],",
    after:
      'prompt: index === history.entries.length ? "" : history.entries[index],',
  },
  {
    id: "R3",
    file: "src/renderer/state.ts",
    feature: "Duplicate event rejection",
    before: "if (action.event.id <= state.lastEventId) return state;",
    after: "if (action.event.id < state.lastEventId) return state;",
  },
  {
    id: "E1",
    file: "src/desktop/window.ts",
    feature: "Renderer navigation restriction",
    before: "if (withoutHash(url) !== rendererTarget) event.preventDefault();",
    after: "",
    verify: "desktop",
  },
  {
    id: "E2",
    file: "src/desktop/window.ts",
    feature: "Integer viewport dimensions",
    before:
      "Number.isInteger(viewport.width) && Number.isInteger(viewport.height)",
    after:
      "Number.isFinite(viewport.width) && Number.isFinite(viewport.height)",
  },
  {
    id: "E3",
    file: "src/desktop/window.ts",
    feature: "Hidden window muting",
    before: "window.webContents.setAudioMuted(true);",
    after: "void 0;",
  },
];
const mutantIds = options.mutant
  ? String(options.mutant).split(",")
  : mutants.map((mutant) => mutant.id);
assert(
  mutantIds.every((id) => mutants.some((mutant) => mutant.id === id)),
  "Unknown mutant",
);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inventory() {
  const files = (await readdir(path.join(root, "test"), { recursive: true }))
    .filter((file) => /\.test\.(ts|tsx)$/.test(file))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const source = ts.createSourceFile(
        file,
        await readFile(path.join(root, "test", file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const layers = new Set();
      function visit(node) {
        if (
          ts.isImportTypeNode(node) ||
          (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
        )
          return;
        if (ts.isStringLiteral(node)) {
          const layer = /^\.\.\/src\/(shared|daemon|renderer|desktop)\//.exec(
            node.text,
          )?.[1];
          if (layer) layers.add(layer);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      // This suite exercises the renderer's Vite sandbox through its config rather than a src import.
      if (file === "playable-vite.test.ts") layers.add("renderer");
      const group = ["desktop", "daemon", "renderer", "shared"].find((layer) =>
        layers.has(layer),
      );
      assert(
        group,
        `No group for ${file}; classify new infrastructure tests explicitly`,
      );
      return {
        file: `test/${file}`,
        group,
        importedLayers: [...layers].sort(),
      };
    }),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[center]
    : (sorted[center - 1] + sorted[center]) / 2;
}

const tests = await inventory();
const selectedMutants = mutants.filter((mutant) =>
  mutantIds.includes(mutant.id),
);
const inputListing = spawnSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "src",
    "test",
    "scripts",
    "*.config.ts",
    "tsconfig*.json",
    "package.json",
    "*lock*",
    "*.html",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(inputListing.status, 0, "Could not fingerprint experiment inputs");
const inputFiles = [
  ...new Set(
    inputListing.stdout
      .split("\0")
      .filter((file) => file && file !== "scripts/test-ablation.mjs"),
  ),
].sort();
const inputHashes = Object.fromEntries(
  await Promise.all(
    inputFiles.map(async (file) => [
      file,
      hash(await readFile(path.join(root, file))),
    ]),
  ),
);
const originals = new Map(
  await Promise.all(
    [...new Set(mutants.map((mutant) => mutant.file))].map(async (file) => [
      file,
      await readFile(path.join(root, file), "utf8"),
    ]),
  ),
);
for (const mutant of selectedMutants) {
  assert.equal(
    originals.get(mutant.file).split(mutant.before).length - 1,
    1,
    `${mutant.id}: source fragment must match exactly once`,
  );
}
if (options["dry-run"]) {
  console.log(
    JSON.stringify(
      {
        groups: Object.fromEntries(
          groups.map((group) => [
            group,
            tests.filter((test) => test.group === group).length,
          ]),
        ),
        tests,
        mutants: selectedMutants,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const startedAt = new Date().toISOString();
const output = options.resume
  ? path.dirname(path.resolve(root, options.resume))
  : path.join(
      root,
      ".data",
      "test-ablation",
      startedAt.replaceAll(/[:.]/g, "-"),
    );
await mkdir(output, { recursive: true });
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const result = options.resume
  ? JSON.parse(await readFile(path.resolve(root, options.resume), "utf8"))
  : {
      startedAt,
      revision,
      inputHashes,
      mutantDefinitions: selectedMutants,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model,
        workers: 4,
        repetitions,
        cloudRoot,
      },
      tests,
      cleanRuns: [],
      mutations: [],
      verification: [],
    };
if (options.resume) {
  assert.equal(
    result.revision,
    revision,
    "Cannot resume at a different revision",
  );
  assert.equal(
    result.environment.node,
    process.version,
    "Cannot resume under a different Node version",
  );
  assert.equal(
    result.environment.repetitions,
    repetitions,
    "Use the original repetition count when resuming",
  );
  assert.equal(
    result.environment.cloudRoot,
    cloudRoot,
    "Cloud dependency changed",
  );
  assert.deepEqual(result.tests, tests, "Test inventory changed");
  if (result.inputHashes)
    assert.deepEqual(
      result.inputHashes,
      inputHashes,
      "Experiment inputs changed",
    );
  else
    assert.equal(
      spawnSync(
        "git",
        [
          "diff",
          "--quiet",
          "HEAD",
          "--",
          "src",
          "test",
          "vite.config.ts",
          "playable-sandbox.html",
        ],
        { cwd: root },
      ).status,
      0,
      "Legacy results require source and tests to match the recorded revision",
    );
  if (result.mutantDefinitions)
    assert.deepEqual(
      result.mutantDefinitions,
      selectedMutants,
      "Mutation definitions changed",
    );
}
const sandbox = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "ohmygame-ablation-")),
);
const vitest = path.join(sandbox, "node_modules", "vitest", "vitest.mjs");

async function checkpoint() {
  await writeFile(
    path.join(output, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

async function run(label, excluded) {
  const reportPath = path.join(output, `${label}.json`);
  const args = [
    vitest,
    "run",
    "--maxWorkers=4",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
  for (const test of tests.filter((test) => test.group === excluded))
    args.push(`--exclude=${test.file}`);
  const start = performance.now();
  const child = spawnSync(process.execPath, args, {
    cwd: sandbox,
    env: { ...process.env, OHMYGAME_CLOUD_ROOT: cloudRoot },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const wallSeconds = (performance.now() - start) / 1000;
  await writeFile(
    path.join(output, `${label}.log`),
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
  );
  assert(
    !child.error && [0, 1].includes(child.status),
    `${label}: process error: ${child.error ?? child.signal ?? child.status}`,
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const failures = report.testResults.flatMap((suite) =>
    suite.assertionResults
      .filter((test) => test.status === "failed")
      .map((test) => ({
        file: path.relative(sandbox, suite.name).split(path.sep).join("/"),
        name: test.fullName,
        messages: test.failureMessages,
      })),
  );
  assert(
    !report.testResults.some(
      (suite) =>
        suite.status === "failed" &&
        !suite.assertionResults.some((test) => test.status === "failed"),
    ),
    `${label}: collection or suite hook failure`,
  );
  assert(
    report.numPendingTests === 0 && report.numTodoTests === 0,
    `${label}: incomplete run; ensure OHMYGAME_CLOUD_ROOT points to the installed cloud repository`,
  );
  assert.equal(
    child.status,
    failures.length ? 1 : 0,
    `${label}: exit code and assertion outcomes disagree`,
  );
  const summary = {
    label,
    excluded: excluded ?? null,
    wallSeconds,
    files: report.testResults.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    failures,
  };
  console.log(
    `${label}: ${summary.files} files, ${summary.passed}/${summary.tests} passed, ${wallSeconds.toFixed(2)}s`,
  );
  return summary;
}

try {
  // Copy current files, including local edits, without sharing production sources with the experiment.
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, "Could not inventory repository files");
  for (const file of new Set(listed.stdout.split("\0").filter(Boolean))) {
    const destination = path.join(sandbox, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(root, file), destination);
  }
  await symlink(
    path.join(root, "node_modules"),
    path.join(sandbox, "node_modules"),
    "dir",
  );

  const variants = [undefined, ...groups];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    // Rotate order so each variant does not always receive the same cache or thermal conditions.
    const ordered = [
      ...variants.slice(repetition % variants.length),
      ...variants.slice(0, repetition % variants.length),
    ];
    for (const excluded of ordered) {
      const label = `clean-${excluded ?? "full"}-${repetition + 1}`;
      if (result.cleanRuns.some((run) => run.label === label)) continue;
      const summary = await run(label, excluded);
      assert.equal(
        summary.failed,
        0,
        "Clean baseline must pass before mutation analysis",
      );
      assert.equal(
        summary.files,
        tests.filter((test) => test.group !== excluded).length,
        "Incomplete test inventory",
      );
      result.cleanRuns.push(summary);
      await checkpoint();
    }
  }

  for (const mutant of selectedMutants) {
    if (result.mutations.some((completed) => completed.id === mutant.id))
      continue;
    const target = path.join(sandbox, mutant.file);
    const original = originals.get(mutant.file);
    await writeFile(target, original.replace(mutant.before, mutant.after));
    try {
      const full = await run(`mutant-${mutant.id}-full`);
      assert.equal(
        full.tests,
        result.cleanRuns.find((run) => run.excluded === null).tests,
        "Mutation changed test collection",
      );
      const detectedBy = [
        ...new Set(
          full.failures.map((failure) => {
            const group = tests.find(
              (test) => test.file === failure.file,
            )?.group;
            assert(group, `Unexpected failing file: ${failure.file}`);
            return group;
          }),
        ),
      ].sort();
      result.mutations.push({
        ...mutant,
        full,
        detectedBy,
        detectedWithout: Object.fromEntries(
          groups.map((group) => [
            group,
            detectedBy.some((detector) => detector !== group),
          ]),
        ),
      });
      if (mutant.verify) {
        const ablated = await run(
          `mutant-${mutant.id}-without-${mutant.verify}`,
          mutant.verify,
        );
        const expected = full.failures
          .filter(
            (failure) =>
              tests.find((test) => test.file === failure.file)?.group !==
              mutant.verify,
          )
          .map((failure) => `${failure.file}: ${failure.name}`)
          .sort();
        assert.deepEqual(
          ablated.failures
            .map((failure) => `${failure.file}: ${failure.name}`)
            .sort(),
          expected,
          `${mutant.id}: ablation differs from the projected failure matrix`,
        );
        result.verification.push({ mutant: mutant.id, ...ablated });
      }
      await checkpoint();
    } finally {
      await writeFile(target, original);
    }
  }

  const all = result.cleanRuns.filter((run) => run.excluded === null);
  const totalTests = all[0].tests;
  const fullMedian = median(all.map((run) => run.wallSeconds));
  result.summary = variants.map((excluded) => {
    const clean = result.cleanRuns.filter(
      (run) => run.excluded === (excluded ?? null),
    );
    const wallMedian = median(clean.map((run) => run.wallSeconds));
    const detected = result.mutations.filter((mutant) =>
      excluded
        ? mutant.detectedWithout[excluded]
        : mutant.detectedBy.length > 0,
    ).length;
    return {
      variant: excluded ? `without-${excluded}` : "full",
      files: clean[0].files,
      tests: clean[0].tests,
      omittedTests: totalTests - clean[0].tests,
      medianSeconds: wallMedian,
      savingPercent: ((fullMedian - wallMedian) / fullMedian) * 100,
      detected,
      missed: result.mutations.length - detected,
      detectionPercent: (detected / result.mutations.length) * 100,
    };
  });
  result.finishedAt = new Date().toISOString();
  await checkpoint();
  console.table(result.summary);
  console.log(`Results: ${path.join(output, "results.json")}`);
} finally {
  for (const [file, original] of originals)
    assert.equal(
      hash(await readFile(path.join(root, file))),
      hash(original),
      `Workspace source changed: ${file}`,
    );
  await rm(sandbox, { recursive: true, force: true });
}
