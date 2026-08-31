/** The org-side cache behind "Compare with org".
 *
 * Extracted from orgCompare.ts, which had grown to hold four separate
 * concerns. This one is self-contained: it knows nothing about sf, sandboxes or
 * the Tooling API - only that org content is expensive to fetch and cheap to
 * remember. */

/** Cached org-side content, because a compare costs ~15s and about 9s of that
 * is the `sf` process starting up - measured: `sf --version` alone is 6s on a
 * loaded machine, `sf config get target-org` 8.9s, the full retrieve 12.9s. So
 * only about a third of the wait is the org; the rest is overhead that cannot
 * be optimised away while the CLI is the transport.
 *
 * Two things make the cache pay far more than a naive "remember the last
 * answer" would:
 *
 *  1. A retrieve fetches the WHOLE component, not the one file being compared.
 *     An LWC bundle comes back as .html + .js + .js-meta.xml. Harvesting all of
 *     them into the cache makes comparing the second and third file of a bundle
 *     free, which is exactly what someone does when a component looks wrong.
 *  2. The Re-fetch button bypasses it, so "is this still current?" always has a
 *     definite answer rather than a guess about staleness.
 *
 * Held on globalThis so a dev-mode module reload does not throw it away. */
export interface CacheEntry {
  org: string | null;
  type?: string;
  at: number;
}
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 300;
const cacheStore = globalThis as unknown as { __dhruvaOrgCache?: Map<string, CacheEntry> };
const orgCache: Map<string, CacheEntry> = (cacheStore.__dhruvaOrgCache ??= new Map());

/** NUL, not a space or a colon: a Windows path contains colons and may contain
 * spaces, so either could let two different keys collide. Same reasoning as the
 * Org Browser's listing key. */
const KEY_SEP = String.fromCharCode(0);

export function cacheKey(root: string, rel: string) {
  return root + KEY_SEP + rel;
}

export function cacheGet(root: string, rel: string): CacheEntry | null {
  const hit = orgCache.get(cacheKey(root, rel));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    orgCache.delete(cacheKey(root, rel));
    return null;
  }
  return hit;
}

export function cachePut(root: string, rel: string, entry: CacheEntry) {
  if (orgCache.size >= CACHE_MAX) {
    // Oldest-first eviction; the map preserves insertion order.
    const oldest = orgCache.keys().next();
    if (!oldest.done) orgCache.delete(oldest.value);
  }
  orgCache.set(cacheKey(root, rel), entry);
}

/** Drop everything cached for a project - used when the user asks for a fresh
 * answer, so Re-fetch is never satisfied from memory. */
export function invalidateOrgCache(root: string) {
  for (const k of [...orgCache.keys()]) {
    if (k.startsWith(root + KEY_SEP)) orgCache.delete(k);
  }
}

