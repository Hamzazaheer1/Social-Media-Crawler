import type { Profile, Post } from "../../store/types.js";
import { fetchXViaProvider } from "./provider.js";
import { fetchXProfile, fetchXPinned, fetchXRecent } from "./adapters.js";

export async function fetchX(
  target: string,
  limit = 10
): Promise<{ profile: Profile; recent: Post[]; pinned?: Post | null }> {

  const username = target.replace(/^@/, "").trim();

  try {
    const out = await fetchXViaProvider(username, limit);

    let profile = out.profile;
    if (!profile.bio?.trim()) {
      const scraped = await fetchXProfile(target);
      profile = { ...profile, bio: scraped.bio ?? profile.bio ?? null, about: scraped.about ?? profile.about ?? null, displayName: scraped.displayName ?? profile.displayName ?? null };
    }

    // Prefer pinned from Apify (first tweet / isPinned); fallback to browser scrape
    const pinned = out.pinned ?? (await fetchXPinned(target)) ?? out.recent[0] ?? null;

    if (out.recent.length >= limit) {
      return { profile, recent: out.recent, pinned };
    }

    // Apify returned fewer than limit – top up with scraper to reach limit
    if (out.recent.length > 0) {
      const extra = await fetchXRecent(target, limit);
      const seen = new Set(out.recent.map((p) => p.id));
      const recent = [...out.recent];
      for (const p of extra) {
        if (recent.length >= limit) break;
        if (!seen.has(p.id)) {
          seen.add(p.id);
          recent.push(p);
        }
      }
      return { profile, recent, pinned: pinned ?? recent[0] ?? null };
    }

    const recent = await fetchXRecent(target, limit);
    return { profile, recent, pinned: pinned ?? recent[0] ?? null };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message ?? e?.message ?? String(e);
    console.warn("❌ X Apify failed:", msg, "→ fallback scraping");

    const profile = await fetchXProfile(target);
    const recent = await fetchXRecent(target, limit);
    const pinned = await fetchXPinned(target);

    return { profile, recent, pinned };
  }
}
