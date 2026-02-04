import type { Profile, Post } from "../../store/types.js";
import { fetchInstagramViaProvider } from "./provider.js";

export async function fetchInstagram(
  target: string,
  limit = 10
): Promise<{ profile: Profile; recent: Post[]; pinned: Post | null }> {

  const username = target.replace("@", "").trim();

  try {
    return await fetchInstagramViaProvider(username, limit);
  } catch {
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
