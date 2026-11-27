import { stat } from "node:fs/promises";
import { mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import baseConfig from "./vite.config.js";

// The default path hash left one shard with most of the long suites.
// File sizes are available on a cold checkout and agree across every shard.
class SizeBalancedSequencer extends BaseSequencer {
  override async shard(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const sized = await Promise.all(
      files.map(async (file) => ({
        file,
        size: (await stat(file.moduleId)).size,
      })),
    );
    sized.sort(
      (a, b) =>
        b.size - a.size || a.file.moduleId.localeCompare(b.file.moduleId),
    );
    return sized
      .filter((_, i) => i % count === index - 1)
      .map(({ file }) => file);
  }
}

export default mergeConfig(baseConfig, {
  test: { sequence: { sequencer: SizeBalancedSequencer } },
});
