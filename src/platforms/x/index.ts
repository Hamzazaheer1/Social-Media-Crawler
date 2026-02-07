import type { Profile, Post } from "../../store/types.js";
import { fetchXProfile, fetchXPinned, fetchXAllPosts } from "./adapters.js";


const FETCH_ALL_THRESHOLD = 100_000;

export async function fetchX(
  target: string,
  limit = 10
): Promise<{ profile: Profile; recent: Post[]; pinned?: Post | null }> {

  const username = target.replace(/^@/, "").trim();

  // ✅ FETCH ALL PRESENT TWEETS
  if (limit >= FETCH_ALL_THRESHOLD) {
    const profile = await fetchXProfile(target);
    const allPosts = await fetchXAllPosts(target);
    const pinned = await fetchXPinned(target);

    return {
      profile,
      recent: allPosts,
      pinned: pinned ?? allPosts[0] ?? null,
    };
  }

  // (Optional: recent-only logic agar chaho)
  const profile = await fetchXProfile(target);
  const pinned = await fetchXPinned(target);

  return {
    profile,
    recent: [],
    pinned,
  };
}
