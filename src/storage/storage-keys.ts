// ════════════════════════════════════════════════════════════════
// STORAGE KEYS — the pure half of the storage layer.
//
// Deliberately DI-free: no @Injectable, no decorators, no constructor parameter
// properties. Two reasons, and the second is the load-bearing one:
//
//   1. cascade.ts and order-purge.ts are transaction helpers with no injector.
//      Importing a Nest service to reach four lines of string work would drag a
//      Supabase client into every module that touches a delete.
//
//   2. `npm test` runs `node --test` over TypeScript in STRIP-ONLY mode, which
//      cannot compile parameter properties — the exact reason piece-edit-lock.ts
//      and jobs/matching.ts exist as separate modules. cascade.ts and
//      order-purge.ts are pure and therefore testable that way, and they import
//      from here; if these functions lived on the service, importing either of
//      those from a test would fail to parse, in a file the test never named.
//
// StorageFilesService re-exports everything here, so callers that already hold
// the service do not need a second import.
// ════════════════════════════════════════════════════════════════

/**
 * Map a stored file URL to its Supabase Storage object key.
 *
 * URLs are written as "/api/uploads/<companyId>/<filename>" (legacy
 * "/uploads/..."), and the object key mirrors the trailing
 * "<companyId>/<filename>". FilePurgeService and OrderPurge each carried a
 * byte-identical private copy of this; three expressions of one parsing rule is
 * how the three drift apart, and this rule decides which bytes get deleted.
 */
export function storageKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = "/uploads/";
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  const key = url.slice(idx + marker.length).split("?")[0] ?? "";
  return key.length > 0 ? key : null;
}

/**
 * The file-bearing fields on an order_pieces row. Named once so a delete path
 * cannot quietly cover two of the three — which is how thumbnails came to be
 * purged by nothing at all, including by the purge whose entire promise is that
 * nothing of the order remains.
 */
export const PIECE_FILE_FIELDS = [
  "slicer_file_url",
  "stl_file_url",
  "stl_thumbnail_url"
] as const;

/**
 * The file-bearing fields on a print_beds row — the plate's own sliced G-code
 * and source model. Separate objects from any piece's, and before this nothing
 * in the system removed them at all.
 */
export const BED_FILE_FIELDS = ["slicer_file_url", "stl_file_url"] as const;

/**
 * Collect storage keys out of loosely-typed rows, reading only `fields`.
 *
 * Loose on purpose: these rows come from `SELECT op.*` / `RETURNING
 * to_jsonb(...)`, so a field is present exactly when its column has been
 * migrated. An absent field reads as undefined and contributes nothing, which
 * is correct — a column that does not exist cannot be holding a file.
 */
export function keysFromRows(
  rows: ReadonlyArray<Record<string, unknown> | null | undefined>,
  fields: readonly string[]
): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (!row) continue;
    for (const field of fields) {
      const value = row[field];
      const key = typeof value === "string" ? storageKeyFromUrl(value) : null;
      if (key) keys.push(key);
    }
  }
  return [...new Set(keys)];
}
