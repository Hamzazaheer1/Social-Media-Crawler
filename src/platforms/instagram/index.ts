import type { Profile, Post } from "../../store/types.js";
import {
  fetchInstagramProfile,
  fetchInstagramPinned,
  fetchInstagramProfileAndRecent,
  fetchInstagramAllPosts,
} from "./adapters.js";

const FETCH_ALL_THRESHOLD = 100_000;

export async function fetchInstagram(
  target: string,
  limit = 10
): Promise<{ profile: Profile; recent: Post[]; pinned: Post | null }> {
  const username = target.replace(/^@/, "").trim();

  if (limit >= FETCH_ALL_THRESHOLD) {
    const [profile, allPosts, pinnedResult] = await Promise.all([
      fetchInstagramProfile(target),
      fetchInstagramAllPosts(target),
      fetchInstagramPinned(target),
    ]);
    return {
      profile,
      recent: allPosts,
      pinned: pinnedResult ?? allPosts[0] ?? null,
    };
  }

  const { profile, recent } = await fetchInstagramProfileAndRecent(target, limit);
  const pinned = await fetchInstagramPinned(target);
  return {
    profile,
    recent,
    pinned: pinned ?? recent[0] ?? null,
  };
}
