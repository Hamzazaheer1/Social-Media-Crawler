import type { Profile, Post } from "../../store/types.js";
import { createHttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";

function getApiKey(): string {
  const raw = process.env.YOUTUBE_API_KEY || "";
  return raw.replace(/^['"]|['"]$/g, "").trim();
}
const API_KEY = getApiKey();
const http = createHttpClient("https://www.googleapis.com/youtube/v3");

// Extract channel handle/ID from target (@handle, URL, or channel ID)
function extractChannelId(target: string): string {
  let clean = target.replace(/^@/, "").trim();
  if (clean.includes("youtube.com") || clean.includes("youtu.be")) {
    const channelMatch = clean.match(/youtube\.com\/channel\/([a-zA-Z0-9_-]+)/);
    if (channelMatch?.[1]) return channelMatch[1];
    const handleMatch = clean.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);
    if (handleMatch?.[1]) return handleMatch[1];
    const userMatch = clean.match(/youtube\.com\/user\/([a-zA-Z0-9_-]+)/);
    if (userMatch?.[1]) return userMatch[1];
    const cMatch = clean.match(/youtube\.com\/c\/([a-zA-Z0-9_-]+)/);
    if (cMatch?.[1]) return cMatch[1];
  }
  return clean;
}

// Resolve handle/ID to channel ID (UC...) using API
async function resolveChannelId(channelIdOrHandle: string): Promise<string | null> {
  if (!API_KEY) return null;
  const clean = channelIdOrHandle.replace(/^@/, "").trim();

  try {
    if (/^UC[\w-]{22}$/.test(clean)) {
      const r = await http.get("/channels", {
        params: { part: "id", id: clean, key: API_KEY },
      });
      if (r.data?.items?.length > 0) return r.data.items[0].id;
      return null;
    }

    const forHandle = clean.startsWith("@") ? clean : `@${clean}`;
    const r = await http.get("/channels", {
      params: { part: "id,snippet", forHandle, key: API_KEY },
    });
    if (r.data?.items?.length > 0) return r.data.items[0].id;

    const noSpaces = clean.replace(/\s+/g, "");
    if (noSpaces !== clean) {
      const r2 = await http.get("/channels", {
        params: { part: "id,snippet", forHandle: `@${noSpaces}`, key: API_KEY },
      });
      if (r2.data?.items?.length > 0) return r2.data.items[0].id;
    }

    const byUsername = await http.get("/channels", {
      params: { part: "id", forUsername: clean, key: API_KEY },
    });
    if (byUsername.data?.items?.length > 0) return byUsername.data.items[0].id;

    const searchRes = await http.get("/search", {
      params: {
        part: "snippet",
        q: clean,
        type: "channel",
        maxResults: 5,
        key: API_KEY,
      },
    });
    const items = searchRes.data?.items || [];
    for (const item of items) {
      const id = item?.snippet?.channelId;
      if (id) return id;
    }

    return null;
  } catch {
    return null;
  }
}

export async function fetchYouTubeProfile(target: string): Promise<Profile> {
  const channelIdOrHandle = extractChannelId(target);

  if (!API_KEY) {
    logger.warn("YOUTUBE_API_KEY not set; add to .env for profile/recent. Returning handle-only.");
    return {
      handle: channelIdOrHandle,
      displayName: null,
      bio: null,
      about: null,
      links: [],
      isPrivate: false,
    };
  }

  try {
    const channelId = await resolveChannelId(channelIdOrHandle);
    if (!channelId) {
      return {
        handle: channelIdOrHandle,
        displayName: null,
        bio: null,
        about: null,
        links: [],
        isPrivate: false,
      };
    }

    const response = await http.get("/channels", {
      params: {
        part: "snippet,contentDetails,statistics",
        id: channelId,
        key: API_KEY,
      },
    });

    if (response.data?.items?.length > 0) {
      const channel = response.data.items[0];
      const snippet = channel.snippet || {};
      const customUrl = snippet.customUrl || null;
      const channelUrl = customUrl
        ? `https://www.youtube.com/${customUrl}`
        : `https://www.youtube.com/channel/${channelId}`;

      return {
        handle: customUrl || channelId,
        displayName: snippet.title || null,
        bio: snippet.description || null,
        about: snippet.description || null,
        links: [channelUrl],
        isPrivate: false,
      };
    }

    return {
      handle: channelIdOrHandle,
      displayName: null,
      bio: null,
      about: null,
      links: [],
      isPrivate: false,
    };
  } catch (error: unknown) {
    const err = error as { response?: { status?: number; data?: unknown }; message?: string };
    logger.warn(
      {
        error: err.message,
        target,
        status: err.response?.status,
        hasKey: !!API_KEY,
      },
      "YouTube profile fetch failed"
    );
    return {
      handle: channelIdOrHandle,
      displayName: null,
      bio: null,
      about: null,
      links: [],
      isPrivate: false,
    };
  }
}

/** Fetch full video snippet (title + description) from Videos API. */
async function fetchVideoSnippets(videoIds: string[]): Promise<Map<string, { title: string; description: string; publishedAt?: string }>> {
  const map = new Map<string, { title: string; description: string; publishedAt?: string }>();
  if (!API_KEY || videoIds.length === 0) return map;
  const ids = videoIds.slice(0, 50).filter(Boolean);
  if (ids.length === 0) return map;
  try {
    const res = await http.get("/videos", {
      params: { part: "snippet", id: ids.join(","), key: API_KEY },
    });
    const items = res.data?.items || [];
    for (const v of items) {
      const id = v.id;
      const sn = v.snippet || {};
      if (id)
        map.set(id, {
          title: sn.title || "",
          description: sn.description || "",
          publishedAt: sn.publishedAt,
        });
    }
  } catch {
    // ignore; callers fall back to title-only
  }
  return map;
}

function buildVideoText(title: string | null, description: string | null): string | null {
  const t = (title || "").trim();
  const d = (description || "").trim();
  if (t && d) return `${t}\n\n${d}`;
  return t || d || null;
}

export async function fetchYouTubePinned(target: string): Promise<Post | null> {
  if (!API_KEY) return null;

  try {
    const channelIdOrHandle = extractChannelId(target);
    const channelId = await resolveChannelId(channelIdOrHandle);
    if (!channelId) return null;

    const channelRes = await http.get("/channels", {
      params: { part: "contentDetails", id: channelId, key: API_KEY },
    });
    const uploadsId =
      channelRes.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return null;

    const playlistRes = await http.get("/playlistItems", {
      params: {
        part: "snippet",
        playlistId: uploadsId,
        maxResults: 1,
        key: API_KEY,
      },
    });
    const item = playlistRes.data?.items?.[0];
    if (!item) return null;

    const snippet = item.snippet || {};
    const videoId = snippet.resourceId?.videoId;
    if (!videoId) return null;

    const snippets = await fetchVideoSnippets([videoId]);
    const full = snippets.get(videoId);
    const title = full?.title ?? snippet.title ?? null;
    const description = full?.description ?? snippet.description ?? null;
    const text = buildVideoText(title, description);

    return {
      id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      text: text || title || null,
      createdAt: full?.publishedAt ?? snippet.publishedAt ?? null,
    };
  } catch (error: unknown) {
    logger.warn(
      { error: (error as { message?: string }).message, target },
      "YouTube pinned fetch failed"
    );
    return null;
  }
}

export async function fetchYouTubeRecent(target: string, limit: number): Promise<Post[]> {
  if (!API_KEY) return [];

  try {
    const channelIdOrHandle = extractChannelId(target);
    const channelId = await resolveChannelId(channelIdOrHandle);
    if (!channelId) return [];

    const channelRes = await http.get("/channels", {
      params: { part: "contentDetails", id: channelId, key: API_KEY },
    });
    const uploadsId =
      channelRes.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return [];

    const playlistRes = await http.get("/playlistItems", {
      params: {
        part: "snippet",
        playlistId: uploadsId,
        maxResults: Math.min(limit, 50),
        key: API_KEY,
      },
    });
    const items = playlistRes.data?.items || [];
    const videoIds = items
      .map((item: { snippet?: { resourceId?: { videoId?: string } }; id?: string }) => item.snippet?.resourceId?.videoId)
      .filter(Boolean) as string[];

    const snippetsMap = await fetchVideoSnippets(videoIds);

    return items.map((item: { snippet?: { resourceId?: { videoId?: string }; title?: string; description?: string; publishedAt?: string }; id?: string }) => {
      const snippet = item.snippet || {};
      const videoId = snippet.resourceId?.videoId;
      const full = videoId ? snippetsMap.get(videoId) : undefined;
      const title = full?.title ?? snippet.title ?? null;
      const description = full?.description ?? snippet.description ?? null;
      const text = buildVideoText(title, description);

      return {
        id: videoId || item.id || "",
        url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        text: text || title || null,
        createdAt: full?.publishedAt ?? snippet.publishedAt ?? null,
      };
    });
  } catch (error: unknown) {
    logger.warn(
      { error: (error as { message?: string }).message, target },
      "YouTube recent fetch failed"
    );
    return [];
  }
}
