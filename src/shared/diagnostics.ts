/** The name a diagnostics ZIP is saved under, such as `ohmygame-diagnostics-20261021-080000.zip`. */
export function diagnosticsFileName(now: Date): string {
  const stamp = now
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `ohmygame-diagnostics-${stamp}.zip`;
}
