// Host-side value shape inference (runs in this realm over vm values;
// Array.isArray and Object.keys both work cross-realm in the same process).
// Powers inspect() (via the __ptcShape bridge), so the model can learn a value's
// structure on demand without dumping the data.
import { SHAPE_MAX_DEPTH, SHAPE_MAX_KEYS, ARRAY_SAMPLE } from "./limits.js";
import { normalizeForSummary } from "./output.js";

export function shapeOf(v: unknown, depth: number, seen: WeakSet<object>): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "undefined") return "undefined";
  if (t === "bigint") return "bigint";
  if (t === "symbol") return "symbol";
  if (t === "function") return "function";
  const obj = v as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  if (Array.isArray(v)) {
    if (v.length === 0) return "Array<unknown>[0]";
    return `Array<${arrayElemShape(v, depth, seen)}>[${v.length}]`;
  }
  if (depth >= SHAPE_MAX_DEPTH) return "{…}";
  const keys = Object.keys(obj);
  const shown = keys.slice(0, SHAPE_MAX_KEYS);
  const parts = shown.map(
    (k) => `${k}: ${shapeOf((obj as Record<string, unknown>)[k], depth + 1, seen)}`,
  );
  const more = keys.length > shown.length ? ", …" : "";
  return `{ ${parts.join(", ")}${more} }`;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Infer an array's element shape by MERGING the first ARRAY_SAMPLE elements,
// not just sampling element 0. For arrays of objects this unions keys across
// the sample and marks a key optional ("?") when it's absent from some
// elements — so e.g. calendar events show BOTH `start.date` (all-day) and
// `start.dateTime` (timed), instead of whichever the first row happened to be.
export function arrayElemShape(
  arr: unknown[],
  depth: number,
  seen: WeakSet<object>,
): string {
  const sample = arr.slice(0, ARRAY_SAMPLE);
  const objs = sample.filter(isPlainObject);
  if (objs.length === sample.length && objs.length > 0) {
    if (depth + 1 >= SHAPE_MAX_DEPTH) return "{…}";
    const keyInfo = new Map<string, { shapes: Set<string>; count: number }>();
    for (const o of objs) {
      for (const k of Object.keys(o)) {
        const e = keyInfo.get(k) ?? { shapes: new Set<string>(), count: 0 };
        e.shapes.add(shapeOf(o[k], depth + 2, seen));
        e.count++;
        keyInfo.set(k, e);
      }
    }
    const keys = [...keyInfo.keys()].slice(0, SHAPE_MAX_KEYS);
    const parts = keys.map((k) => {
      const e = keyInfo.get(k)!;
      const optional = e.count < objs.length ? "?" : "";
      return `${k}${optional}: ${[...e.shapes].join(" | ")}`;
    });
    const more = keyInfo.size > keys.length ? ", …" : "";
    return `{ ${parts.join(", ")}${more} }`;
  }
  // Mixed or scalar elements: union of distinct element shapes.
  const uniq = [...new Set(sample.map((e) => shapeOf(e, depth + 1, seen)))];
  return uniq.join(" | ") || "unknown";
}

export function shapeStr(v: unknown): string {
  return shapeOf(normalizeForSummary(v), 0, new WeakSet());
}
