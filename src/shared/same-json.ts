/** Whether two JSON values hold the same data, whatever order their keys were written in. */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  // Keys holding undefined are dropped when written, as JSON.stringify does.
  const keys = (value: object) => Object.entries(value).filter(([, item]) => item !== undefined).map(([key]) => key);
  const leftKeys = keys(left), rightKeys = keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key)
      && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
