import type { Profile, Post } from "../../store/types.js";
import {
  fetchInstagramProfileAndRecent,
  fetchInstagramAllPosts,
  fetchInstagramProfile,
  fetchInstagramPinned,
} from "./adapters.js";

export async function fetchInstagram(
  target: string,
  limit = 10
): Promise<{ profile: Profile; recent: Post[]; pinned: Post | null }> {
  try {
    // For "fetch all", use dedicated function
    if (limit >= 100_000) {
      const profile = await fetchInstagramProfile(target);
      const recent = await fetchInstagramAllPosts(target);
      const pinned: Post | null = recent.length > 0 && recent[0] ? recent[0] : null;
      return { profile, recent, pinned };
    }

    // For limited fetch, use profile+recent
    const profileAndRecent = await fetchInstagramProfileAndRecent(target, limit);
    const pinned: Post | null = profileAndRecent.recent.length > 0 && profileAndRecent.recent[0] ? profileAndRecent.recent[0] : null;
    return {
      profile: profileAndRecent.profile,
      recent: profileAndRecent.recent,
      pinned,
    };
  } catch (error: unknown) {
    const username = target.replace("@", "").trim();
    return {
      profile: {
        handle: username,
        displayName: username,
        bio: null,
        about: null,
        links: [`https://instagram.com/${username}`],
        isPrivate: false,
      },
      recent: [],
      pinned: null,
    };
  }
}
