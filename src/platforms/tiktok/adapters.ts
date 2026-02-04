import type { Profile, Post } from "../../store/types.js";
import { createHttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";
import { load } from "cheerio";
import puppeteer from "puppeteer";

const http = createHttpClient();
const USE_BROWSER = process.env.USE_BROWSER_SCRAPING === "true" || true; // Default true for TikTok (JS-rendered)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TikTok generic page copy – not real profile data
const TT_GENERIC_PHRASES = [
  "log in to tiktok",
  "watch more videos",
  "discover more",
  "this account is private",
  "tiktok - make your day",
  "make your day",
  "no bio yet",
];

function isGenericTikTokText(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return true;
  const t = text.trim().toLowerCase();
  return TT_GENERIC_PHRASES.some((p) => t === p || t.startsWith(p) || t.includes(p));
}

// Extract username from handle or URL
function extractUsername(target: string): string {
  let clean = target.replace(/^@/, "").trim();

  if (clean.includes("tiktok.com")) {
    const match = clean.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
    if (match && match[1]) return match[1];
  }

  return clean;
}

// TikTok video IDs are long numeric strings (e.g. 18–19 digits). Reject category names like "Animals", "Comedy".
function isTikTokVideoId(id: unknown): boolean {
  if (id == null) return false;
  const s = String(id).trim();
  return /^\d{10,}$/.test(s);
}

// Parse TikTok's __UNIVERSAL_DATA_FOR_REHYDRATION__ script
function parseTikTokHydration(html: string): Record<string, unknown> | null {
  try {
    const match = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match || !match[1]) return null;
    const json = JSON.parse(match[1].trim());
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Find first object that has signature or nickname (deep search)
function findUserInObj(obj: unknown): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.signature === "string" || typeof o.nickname === "string" || typeof o.uniqueId === "string")
    return o;
  for (const v of Object.values(o)) {
    const found = findUserInObj(v);
    if (found) return found;
  }
  return undefined;
}

// Get numeric video ID from a video-like object (TikTok uses id, item_id, video.id, itemInfos.id)
function getVideoIdFromItem(item: Record<string, unknown>): string | undefined {
  const id =
    item?.id ??
    item?.item_id ??
    (item?.video as Record<string, unknown>)?.id ??
    (item?.itemInfos as Record<string, unknown>)?.id;
  if (id != null && isTikTokVideoId(id)) return String(id);
  return undefined;
}

// Extract caption (text) and createdAt from a video item (hydration or itemModule entry)
function getTextAndCreatedAtFromItem(item: Record<string, unknown>): { text: string | null; createdAt: string | null } {
  const itemInfos = item?.itemInfos as Record<string, unknown> | undefined;
  const shareMeta = (item?.shareMeta ?? item?.share_info ?? item?.meta) as Record<string, unknown> | undefined;
  const videoObj = item?.video as Record<string, unknown> | undefined;
  const text =
    (item?.desc as string) ??
    (item?.video_description as string) ??
    (item?.description as string) ??
    (item?.contentDesc as string) ??
    (item?.title as string) ??
    (item?.content as string) ??
    (item?.caption as string) ??
    itemInfos?.text ??
    itemInfos?.desc ??
    itemInfos?.video_description ??
    (itemInfos?.title as string) ??
    (itemInfos?.contentDesc as string) ??
    (shareMeta?.title as string) ??
    (shareMeta?.desc as string) ??
    (shareMeta?.description as string) ??
    (videoObj?.description as string) ??
    (videoObj?.title as string) ??
    null;
  const textStr = typeof text === "string" && text.trim() ? text.trim() : null;

  let createdAt: string | null = null;
  const createTime =
    item?.createTime ??
    item?.create_time ??
    itemInfos?.createTime ??
    itemInfos?.create_time ??
    item?.createTimeISO ??
    itemInfos?.createTimeISO;
  if (typeof createTime === "number" && createTime > 0) {
    try {
      // TikTok uses seconds; if value is very large assume milliseconds
      const ms = createTime > 1e12 ? createTime : createTime * 1000;
      createdAt = new Date(ms).toISOString();
    } catch {
      createdAt = null;
    }
  } else if (typeof createTime === "string" && createTime.length > 0) {
    createdAt = createTime;
  }
  return { text: textStr, createdAt };
}

/** Fetch video caption via HTTP only (no browser). Used to fill missing captions after profile parse. */
async function fetchVideoCaptionHttp(username: string, videoId: string): Promise<string | null> {
  const videoUrl = `https://www.tiktok.com/@${username}/video/${videoId}`;
  try {
    const response = await http.get(videoUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const $ = load(html);
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || null;
    if (ogDesc && !isGenericTikTokText(ogDesc)) return ogDesc;
    const hydration = parseTikTokHydration(html);
    if (hydration) {
      const defaultScope = hydration?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
      const scope = defaultScope ?? hydration;
      const webapp = scope?.["webapp.video-detail"] as Record<string, unknown> | undefined;
      const itemModule = (webapp?.itemModule ?? scope?.itemModule) as Record<string, Record<string, unknown>> | undefined;
      const item = itemModule?.[videoId] ?? findVideoDetailsById(hydration, videoId);
      if (item) {
        const { text } = getTextAndCreatedAtFromItem(item as Record<string, unknown>);
        if (text && !isGenericTikTokText(text)) return text;
      }
    }
    return null;
  } catch (err) {
    logger.debug({ videoId, username, error: (err as { message?: string }).message }, "TikTok video caption HTTP failed");
    return null;
  }
}

/**
 * Fetch a single video page and extract caption from og:description or hydration.
 * Used when profile page doesn't include caption (e.g. private accounts).
 */
async function fetchVideoDescription(username: string, videoId: string): Promise<string | null> {
  const videoUrl = `https://www.tiktok.com/@${username}/video/${videoId}`;
  try {
    let html: string;
    if (USE_BROWSER) {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        );
        await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await delay(3000);
        html = await page.content();
      } finally {
        await browser?.close();
      }
    } else {
      const response = await http.get(videoUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    }
    const $ = load(html);
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || null;
    if (ogDesc && !isGenericTikTokText(ogDesc)) return ogDesc;
    const hydration = parseTikTokHydration(html);
    if (hydration) {
      const defaultScope = hydration?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
      const scope = defaultScope ?? hydration;
      const webapp = scope?.["webapp.video-detail"] as Record<string, unknown> | undefined;
      const itemModule = (webapp?.itemModule ?? scope?.itemModule) as Record<string, Record<string, unknown>> | undefined;
      const item = itemModule?.[videoId] ?? findVideoDetailsById(hydration, videoId);
      if (item) {
        const { text } = getTextAndCreatedAtFromItem(item as Record<string, unknown>);
        if (text && !isGenericTikTokText(text)) return text;
      }
    }
    return null;
  } catch (err) {
    logger.debug({ videoId, username, error: (err as { message?: string }).message }, "TikTok video description fetch failed");
    return null;
  }
}

// Find first array that looks like video list (objects with numeric video id)
function findVideoListInObj(obj: unknown): unknown[] | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (Array.isArray(o) && o.length > 0) {
    const first = o[0] as Record<string, unknown>;
    if (first && getVideoIdFromItem(first)) return o;
  }
  for (const v of Object.values(o)) {
    const found = findVideoListInObj(v);
    if (found) return found;
  }
  return undefined;
}

// Find itemModule: object keyed by video ID, values are full video objects (desc, createTime, etc.)
function findItemModuleInObj(obj: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (o && !Array.isArray(o) && typeof o.itemModule === "object" && o.itemModule !== null) {
    const im = o.itemModule as Record<string, unknown>;
    const firstKey = Object.keys(im)[0];
    if (firstKey && /^\d{10,}$/.test(firstKey)) return im as Record<string, Record<string, unknown>>;
  }
  for (const v of Object.values(o)) {
    const found = findItemModuleInObj(v);
    if (found) return found;
  }
  return undefined;
}

// Deep-search for a video object with this id that has desc or createTime (fallback when itemModule shape differs)
function findVideoDetailsById(obj: unknown, videoId: string): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const id =
    o?.id ?? o?.item_id ?? (o?.itemInfos as Record<string, unknown>)?.id ?? (o?.video as Record<string, unknown>)?.id;
  if (id != null && String(id) === videoId && (o.desc != null || o.video_description != null || o.createTime != null || o.create_time != null || (o.itemInfos as Record<string, unknown>)?.createTime != null))
    return o;
  for (const v of Object.values(o)) {
    const found = findVideoDetailsById(v, videoId);
    if (found) return found;
  }
  return undefined;
}

// Get user + video list + itemModule from hydration (TikTok: details often in itemModule keyed by id)
function getUserFromHydration(hydration: Record<string, unknown>): {
  user?: Record<string, unknown>;
  videos?: unknown[];
  itemModule?: Record<string, Record<string, unknown>>;
} {
  try {
    const defaultScope = hydration?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
    const scope = defaultScope ?? hydration;
    const webapp = scope?.["webapp.user-detail"] as Record<string, unknown> | undefined;
    const userInfo = (webapp?.userInfo ?? scope?.userInfo) as Record<string, unknown> | undefined;
    let user = (userInfo?.user ?? scope?.user) as Record<string, unknown> | undefined;
    let itemList = (userInfo?.itemList ?? scope?.itemList) as unknown[] | undefined;
    let itemModule = (userInfo?.itemModule ?? scope?.itemModule) as Record<string, Record<string, unknown>> | undefined;
    if (!user) user = findUserInObj(hydration);
    if (!itemModule || typeof itemModule !== "object" || Array.isArray(itemModule))
      itemModule = findItemModuleInObj(hydration);
    if (!itemList || !Array.isArray(itemList) || itemList.length === 0) itemList = findVideoListInObj(hydration);
    const result: { user?: Record<string, unknown>; videos?: unknown[]; itemModule?: Record<string, Record<string, unknown>> } = {};
    if (user) result.user = user;
    if (itemList && itemList.length > 0) result.videos = itemList;
    if (itemModule && Object.keys(itemModule).length > 0) result.itemModule = itemModule;
    return result;
  } catch {
    return {};
  }
}

/** Parse profile + recent posts from one profile page HTML (no extra browser/network). */
function parseProfilePageHtml(html: string, username: string): { profile: Profile; posts: Post[] } {
  const $ = load(html);
  const hydration = parseTikTokHydration(html);
  const { user: userData, videos, itemModule } = getUserFromHydration(hydration ?? {});

  // --- Profile ---
  let bio: string | null = (userData?.signature as string) ?? null;
  let displayName: string | null = (userData?.nickname as string) ?? (userData?.uniqueId as string) ?? null;
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDescription = $('meta[property="og:description"]').attr("content");
  if (!displayName && ogTitle) displayName = ogTitle.replace(/^@?\s*/, "").split("|")[0]?.trim() ?? null;
  if (!bio && ogDescription && !isGenericTikTokText(ogDescription)) bio = ogDescription;
  if (!bio) {
    const desc = $('meta[name="description"]').attr("content") || $('h2[data-e2e="user-bio"]').text().trim() || null;
    if (desc && !isGenericTikTokText(desc)) bio = desc;
  }
  if (!displayName) {
    const h1 = $("h1").first().text().trim();
    if (h1 && !isGenericTikTokText(h1)) displayName = h1;
  }
  if (bio && isGenericTikTokText(bio)) bio = null;
  if (displayName && isGenericTikTokText(displayName)) displayName = null;
  if (!displayName) displayName = username;
  const links: string[] = [];
  const profileLink = $('meta[property="og:url"]').attr("content");
  if (profileLink) links.push(profileLink);
  const pageText = html.toLowerCase();
  let isPrivate =
    pageText.includes("this account is private") || $('*:contains("This account is private")').length > 0;
  if (userData && (userData.private === false || userData.isPrivate === false)) isPrivate = false;
  if (userData && (userData.private === true || userData.isPrivate === true)) isPrivate = true;

  const profile: Profile = {
    handle: username,
    displayName: displayName?.replace(`@${username}`, "").trim() || username,
    bio: bio || null,
    about: bio || null,
    links,
    isPrivate,
  };

  // --- Posts ---
  const posts: Post[] = [];
  const seen = new Set<string>();
  const addPost = (id: string, url: string, text: string | null, createdAt: string | null = null) => {
    if (seen.has(id)) return;
    seen.add(id);
    posts.push({ id, url, text, createdAt });
  };

  if (videos && Array.isArray(videos)) {
    for (const v of videos) {
      const id =
        typeof v === "string" && isTikTokVideoId(v) ? v : getVideoIdFromItem(v as Record<string, unknown>);
      const fromModule = id && itemModule?.[id] ? itemModule[id] : null;
      const fromSearch = id && hydration ? findVideoDetailsById(hydration, id) : null;
      const fullItem = (fromModule ?? fromSearch ?? (typeof v === "object" && v ? v : { id })) as Record<string, unknown>;
      const { text: desc, createdAt } = getTextAndCreatedAtFromItem(fullItem);
      if (id) addPost(id, `https://www.tiktok.com/@${username}/video/${id}`, desc, createdAt);
    }
  }
  $('a[href*="/video/"]').each((_, el) => {
    const $el = $(el);
    const videoUrl = $el.attr("href");
    const videoId = videoUrl?.match(/\/video\/(\d+)/)?.[1];
    if (videoId && !seen.has(videoId)) {
      const container = $el.closest("div[data-e2e='user-post-item'], div[data-e2e='user-post-item-desc'], div");
      const rawDesc =
        container.find("[data-e2e='user-post-item-desc']").first().text().trim() ||
        container.find("span").first().text().trim() ||
        $el.closest("div").find("span").first().text().trim() ||
        null;
      const description = rawDesc && !isGenericTikTokText(rawDesc) ? rawDesc : null;
      const url = videoUrl?.startsWith("http") ? videoUrl : `https://www.tiktok.com${videoUrl}`;
      addPost(videoId, url, description, null);
    }
  });
  const re = /\/video\/(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const id = match[1];
    if (id != null && !seen.has(id)) addPost(id, `https://www.tiktok.com/@${username}/video/${id}`, null, null);
  }

  return { profile, posts };
}

/** Fast path: one browser session, one page load – profile + recent in one go (like YouTube). */
export async function fetchTikTokProfileAndRecent(target: string, limit: number): Promise<{ profile: Profile; recent: Post[] }> {
  const username = extractUsername(target);
  const profileUrl = `https://www.tiktok.com/@${username}`;

  let html: string;
  if (USE_BROWSER) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      );
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await delay(2500);
      try {
        await page.waitForSelector('a[href*="/video/"], [data-e2e="user-post-item"], main', { timeout: 6000 });
      } catch (_) {}
      await delay(1000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1500);
      html = await page.content();
    } finally {
      await browser?.close();
    }
  } else {
    const response = await http.get(profileUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  }

  const { profile, posts } = parseProfilePageHtml(html, username);
  const recent = posts.slice(0, limit);

  // Fill missing captions via HTTP (no extra browser) – parallel, 4 at a time
  const needCaption = recent.filter((p) => !p.text || !String(p.text).trim());
  if (needCaption.length > 0) {
    const CONCURRENCY = 4;
    for (let i = 0; i < needCaption.length; i += CONCURRENCY) {
      const chunk = needCaption.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((post) => fetchVideoCaptionHttp(username, post.id))
      );
      chunk.forEach((post, j) => {
        const caption = results[j];
        if (caption) post.text = caption;
      });
      if (i + CONCURRENCY < needCaption.length) await delay(400);
    }
    const filled = needCaption.filter((p) => p.text && String(p.text).trim()).length;
    if (filled > 0) logger.info({ username, filled }, "TikTok captions filled via HTTP");
  }

  logger.info({ username, profileAndPosts: recent.length }, "TikTok profile+recent (fast single fetch)");
  return { profile, recent };
}

export async function fetchTikTokProfile(target: string): Promise<Profile> {
  try {
    const username = extractUsername(target);
    const profileUrl = `https://www.tiktok.com/@${username}`;

    let html: string;

    if (USE_BROWSER) {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        );
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => false });
        });
        await page.setViewport({ width: 1920, height: 1080 });
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000);
        // Wait for video grid or main content to appear
        try {
          await page.waitForSelector('a[href*="/video/"], [data-e2e="user-post-item"], main', { timeout: 12000 });
        } catch (_) {}
        await delay(2000);
        html = await page.content();
        await browser.close();
      } catch (browserError: unknown) {
        try {
          await browser?.close();
        } catch (_) {}
        throw browserError;
      }
    } else {
      const response = await http.get(profileUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
      html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    }

    const $ = load(html);
    const hydration = parseTikTokHydration(html);
    const { user: userData } = getUserFromHydration(hydration ?? {});

    // Bio/signature from hydration (most reliable)
    let bio: string | null = (userData?.signature as string) ?? null;
    let displayName: string | null = (userData?.nickname as string) ?? (userData?.uniqueId as string) ?? null;

    // Fallback: meta tags
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const ogDescription = $('meta[property="og:description"]').attr("content");
    if (!displayName && ogTitle) displayName = ogTitle.replace(/^@?\s*/, "").split("|")[0]?.trim() ?? null;
    if (!bio && ogDescription && !isGenericTikTokText(ogDescription)) bio = ogDescription;

    // Fallback: HTML
    if (!bio) {
      const desc =
        $('meta[name="description"]').attr("content") ||
        $('h2[data-e2e="user-bio"]').text().trim() ||
        null;
      if (desc && !isGenericTikTokText(desc)) bio = desc;
    }
    if (!displayName) {
      const h1 = $("h1").first().text().trim();
      if (h1 && !isGenericTikTokText(h1)) displayName = h1;
    }

    if (bio && isGenericTikTokText(bio)) bio = null;
    if (displayName && isGenericTikTokText(displayName)) displayName = null;
    if (!displayName) displayName = username;

    const links: string[] = [];
    const profileLink = $('meta[property="og:url"]').attr("content");
    if (profileLink) links.push(profileLink);

    const pageText = html.toLowerCase();
    let isPrivate =
      pageText.includes("this account is private") || $('*:contains("This account is private")').length > 0;
    if (userData && (userData.private === false || userData.isPrivate === false)) isPrivate = false;
    if (userData && (userData.private === true || userData.isPrivate === true)) isPrivate = true;

    logger.info(
      { username, hasBio: !!bio, hasDisplayName: !!displayName, hasHydration: !!userData },
      "TikTok profile fetched"
    );

    return {
      handle: username,
      displayName: displayName?.replace(`@${username}`, "").trim() || username,
      bio: bio || null,
      about: bio || null,
      links,
      isPrivate,
    };
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { status?: number; data?: unknown } };
    logger.error({ error: err.message, target }, "Failed to fetch TikTok profile");
    return {
      handle: extractUsername(target),
      displayName: null,
      bio: null,
      about: null,
      links: [],
      isPrivate: false,
    };
  }
}

export async function fetchTikTokPinned(target: string): Promise<Post | null> {
  try {
    const username = extractUsername(target);
    const profileUrl = `https://www.tiktok.com/@${username}`;

    let html: string;

    if (USE_BROWSER) {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        );
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000);
        try {
          await page.waitForSelector('a[href*="/video/"]', { timeout: 10000 });
        } catch (_) {}
        await delay(2000);
        html = await page.content();
        await browser.close();
      } catch (browserError: unknown) {
        try {
          await browser?.close();
        } catch (_) {}
        throw browserError;
      }
    } else {
      const response = await http.get(profileUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    }

    const hydration = parseTikTokHydration(html);
    const { videos, itemModule } = getUserFromHydration(hydration ?? {});

    if (videos && Array.isArray(videos) && videos.length > 0) {
      const first = videos[0];
      const id =
        typeof first === "string" && isTikTokVideoId(first)
          ? first
          : getVideoIdFromItem(first as Record<string, unknown>);
      const fromModule = id && itemModule?.[id] ? itemModule[id] : null;
      const fromSearch = id && hydration ? findVideoDetailsById(hydration, id) : null;
      const fullItem = (fromModule ?? fromSearch ?? (typeof first === "object" && first ? first : { id })) as Record<string, unknown>;
      const { text: desc, createdAt } = getTextAndCreatedAtFromItem(fullItem);
      if (id) {
        const post: Post = {
          id,
          url: `https://www.tiktok.com/@${username}/video/${id}`,
          text: desc,
          createdAt,
        };
        if (post.text == null) {
          const videoDesc = await fetchVideoDescription(username, id);
          if (videoDesc) post.text = videoDesc;
        }
        return post;
      }
    }

    const $ = load(html);
    const firstVideo = $('a[href*="/video/"]').first();
    if (firstVideo.length > 0) {
      const videoUrl = firstVideo.attr("href");
      const videoId = videoUrl?.match(/\/video\/(\d+)/)?.[1];
      if (videoId) {
        const container = firstVideo.closest("div[data-e2e='user-post-item'], div[data-e2e='user-post-item-desc'], div");
        const description =
          container.find("[data-e2e='user-post-item-desc']").first().text().trim() ||
          container.find("span").first().text().trim() ||
          firstVideo.closest("div").find("span").first().text().trim() ||
          null;
        const text = description && !isGenericTikTokText(description) ? description : null;
        const post: Post = {
          id: videoId,
          url: videoUrl?.startsWith("http") ? videoUrl : `https://www.tiktok.com${videoUrl}`,
          text: text || null,
          createdAt: null,
        };
        if (post.text == null) {
          const videoDesc = await fetchVideoDescription(username, videoId);
          if (videoDesc) post.text = videoDesc;
        }
        return post;
      }
    }

    // Full HTML scan for first /video/ID
    const m = html.match(/\/video\/(\d+)/);
    if (m && m[1]) {
      const post: Post = {
        id: m[1],
        url: `https://www.tiktok.com/@${username}/video/${m[1]}`,
        text: null,
        createdAt: null,
      };
      const videoDesc = await fetchVideoDescription(username, m[1]);
      if (videoDesc) post.text = videoDesc;
      return post;
    }

    return null;
  } catch (error: unknown) {
    logger.error({ error: (error as { message?: string }).message, target }, "Failed to fetch TikTok pinned video");
    return null;
  }
}

export async function fetchTikTokRecent(target: string, limit: number): Promise<Post[]> {
  try {
    const username = extractUsername(target);
    const profileUrl = `https://www.tiktok.com/@${username}`;

    let html: string;

    if (USE_BROWSER) {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
      });
      try {
        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        );
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000);
        try {
          await page.waitForSelector('a[href*="/video/"]', { timeout: 12000 });
        } catch (_) {}
        await delay(2000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(2500);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(2000);
        html = await page.content();
        await browser.close();
      } catch (browserError: unknown) {
        try {
          await browser?.close();
        } catch (_) {}
        throw browserError;
      }
    } else {
      const response = await http.get(profileUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    }

    const posts: Post[] = [];
    const seen = new Set<string>();

    const addPost = (id: string, url: string, text: string | null, createdAt: string | null = null) => {
      if (seen.has(id) || posts.length >= limit) return;
      seen.add(id);
      posts.push({ id, url, text, createdAt });
    };

    const hydration = parseTikTokHydration(html);
    const { videos, itemModule } = getUserFromHydration(hydration ?? {});

    if (videos && Array.isArray(videos)) {
      for (const v of videos.slice(0, limit * 2)) {
        const id =
          typeof v === "string" && isTikTokVideoId(v) ? v : getVideoIdFromItem(v as Record<string, unknown>);
        const fromModule = id && itemModule?.[id] ? itemModule[id] : null;
        const fromSearch = id && hydration ? findVideoDetailsById(hydration, id) : null;
        const fullItem = (fromModule ?? fromSearch ?? (typeof v === "object" && v ? v : { id })) as Record<string, unknown>;
        const { text: desc, createdAt } = getTextAndCreatedAtFromItem(fullItem);
        if (id) addPost(id, `https://www.tiktok.com/@${username}/video/${id}`, desc, createdAt);
      }
      if (posts.length > 0) logger.info({ username, postsFromHydration: posts.length }, "TikTok posts from hydration");
    }

    const $ = load(html);
    $('a[href*="/video/"]').each((_, el) => {
      const $el = $(el);
      const videoUrl = $el.attr("href");
      const videoId = videoUrl?.match(/\/video\/(\d+)/)?.[1];
      if (videoId) {
        const container = $el.closest("div[data-e2e='user-post-item'], div[data-e2e='user-post-item-desc'], div");
        const rawDesc =
          container.find("[data-e2e='user-post-item-desc']").first().text().trim() ||
          container.find("span").first().text().trim() ||
          $el.closest("div").find("span").first().text().trim() ||
          null;
        const description = rawDesc && !isGenericTikTokText(rawDesc) ? rawDesc : null;
        const url = videoUrl?.startsWith("http") ? videoUrl : `https://www.tiktok.com${videoUrl}`;
        addPost(videoId, url, description, null);
      }
    });

    if (html) {
      const re = /\/video\/(\d+)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(html)) !== null) {
        const id = match[1];
        if (id != null) addPost(id, `https://www.tiktok.com/@${username}/video/${id}`, null, null);
      }
      if (posts.length > 0 && !hydration) logger.info({ username, postsFromHtmlScan: posts.length }, "TikTok posts from HTML scan");
    }

    // For posts with no text (e.g. private account), fetch each video page for caption
    let filled = 0;
    for (const post of posts) {
      if (post.text != null) continue;
      const desc = await fetchVideoDescription(username, post.id);
      if (desc) {
        post.text = desc;
        filled++;
      }
      await delay(800);
    }
    if (filled > 0) logger.info({ username, filled }, "TikTok filled descriptions from video pages");

    logger.info({ username, postsFound: posts.length, limit }, "TikTok recent videos fetched");
    return posts.slice(0, limit);
  } catch (error: unknown) {
    logger.error(
      { error: (error as { message?: string }).message, target },
      "Failed to fetch TikTok recent videos"
    );
    return [];
  }
}
