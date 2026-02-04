import axios from "axios";
import type { Profile, Post } from "../../store/types.js";

/** Map Apify/post item to our Post type (supports multiple actor output shapes). */
function mapPost(p: {
  shortCode?: string;
  id?: string;
  caption?: string;
  text?: string;
  timestamp?: string;
  createdAt?: string;
  takenAt?: string;
  [k: string]: unknown;
}): Post {
  const id = String(p.shortCode ?? p.id ?? "").trim();
  return {
    id,
    url: id ? `https://www.instagram.com/p/${id}/` : null,
    text: (p.caption ?? p.text) ?? null,
    createdAt: (p.timestamp ?? p.createdAt ?? p.takenAt) ?? null,
  };
}

/** Max posts when using Apidojo (respects limit; production-ready). */
const APIDOJO_MAX_POSTS = 500;
/** Max posts for legacy Apify post scraper (often capped ~12 in practice). */
const LEGACY_MAX_POSTS = 100;

export async function fetchInstagramViaProvider(
  username: string,
  limit: number
): Promise<{ profile: Profile; recent: Post[]; pinned: Post | null }> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error("APIFY_TOKEN missing");
  }

  const safeLimit = Math.max(1, Math.min(limit, APIDOJO_MAX_POSTS));

  // 1) Profile from Profile Scraper (bio, name, etc.)
  const profileRes = await axios.post(
    "https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items",
    {
      usernames: [username],
      resultsLimit: 5,
    },
    {
      params: { token },
      timeout: 60000,
    }
  );

  const profileData = profileRes.data?.[0];
  if (!profileData) {
    throw new Error("Instagram provider returned no data");
  }

  const profile: Profile = {
    handle: profileData.username,
    displayName: profileData.fullName ?? profileData.username,
    bio: profileData.biography ?? null,
    about: profileData.biography ?? null,
    links: profileData.externalUrl
      ? [profileData.externalUrl]
      : [`https://instagram.com/${profileData.username}`],
    isPrivate: !!profileData.isPrivate,
  };

  // 2) Posts: prefer Apidojo (limit respected; production-ready). Fallback: Apify post scraper → profile latestPosts (~12).
  let recent: Post[] = [];

  const runApidojoPosts = async () =>
    axios.post(
      "https://api.apify.com/v2/acts/apidojo~instagram-scraper-api/run-sync-get-dataset-items",
      { username, maxPost: safeLimit },
      { params: { token }, timeout: 120000 }
    );

  const runLegacyPostScraper = async () =>
    axios.post(
      "https://api.apify.com/v2/acts/apify~instagram-post-scraper/run-sync-get-dataset-items",
      { usernames: [username], maxPosts: Math.min(safeLimit, LEGACY_MAX_POSTS) },
      { params: { token }, timeout: 90000 }
    );

  const useApidojo = process.env.INSTAGRAM_POST_SOURCE !== "legacy";

  try {
    if (useApidojo) {
      const apidojoRes = await runApidojoPosts();
      const raw = Array.isArray(apidojoRes.data) ? apidojoRes.data : [];
      const postLike = raw.filter((p: unknown) => {
        if (!p || typeof p !== "object") return false;
        const o = p as Record<string, unknown>;
        return (o.shortCode != null && String(o.shortCode).trim() !== "") || (o.id != null && String(o.id).trim() !== "");
      });
      recent = postLike.slice(0, safeLimit).map((p: Record<string, unknown>) => mapPost(p));
    }
    if (!useApidojo || recent.length === 0) throw new Error("Use legacy or Apidojo returned no posts");
  } catch {
    try {
      let postRes = await runLegacyPostScraper();
      let items = Array.isArray(postRes.data) ? postRes.data : [];
      if (items.length === 0) {
        postRes = await runLegacyPostScraper();
        items = Array.isArray(postRes.data) ? postRes.data : [];
      }
      recent = items.slice(0, safeLimit).map((p: Record<string, unknown>) => mapPost(p));
    } catch {
      try {
        const retryRes = await runLegacyPostScraper();
        const items = Array.isArray(retryRes.data) ? retryRes.data : [];
        recent = items.slice(0, safeLimit).map((p: Record<string, unknown>) => mapPost(p));
      } catch {
        recent =
          profileData.latestPosts?.slice(0, safeLimit).map((p: Record<string, unknown>) => mapPost(p)) ?? [];
      }
    }
  }

  // Pinned: use Apify pinned if present, else first recent (Instagram often shows pinned first in list)
  let pinned: Post | null = null;
  const pinnedFromProfile = profileData.pinnedPost ?? profileData.pinned ?? profileData.highlightPost;
  if (pinnedFromProfile && typeof pinnedFromProfile === "object") {
    const p = mapPost(pinnedFromProfile as any);
    if (p.id && (p.text || p.url)) pinned = p;
  }
  if (!pinned && recent.length > 0) pinned = recent[0] ?? null;

  return { profile, recent, pinned };
}
