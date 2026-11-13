export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  // Rounding up can reach 1024 KB just below 1 MiB; show that as 1.0 MB.
  const kilobytes = Math.ceil(value / 1024);
  if (kilobytes < 1024) return `${kilobytes} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
