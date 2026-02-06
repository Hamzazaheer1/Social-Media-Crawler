import type { Profile, Post } from "../../store/types.js";
import { createHttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";
import { load } from "cheerio";
import puppeteer from "puppeteer";
import { fetchInstagramViaProvider } from "./provider.js";

const http = createHttpClient();
const USE_BROWSER_DEFAULT = process.env.USE_BROWSER_SCRAPING === "true";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUsername(target: string): string {
  let clean = target.replace(/^@/, "").trim();

  if (clean.includes("instagram.com")) {
    const match = clean.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
    if (match && match[1]) return match[1];
  }

  return clean;
}

function isInstagramShortCode(id: unknown): boolean {
  if (id == null) return false;
  const s = String(id).trim();
  return /^[a-zA-Z0-9_-]{8,}$/.test(s);
}

function parseInstagramData(html: string): Record<string, unknown> | null {
  try {
    const matchShared = html.match(/window\._sharedData\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (matchShared?.[1]) {
      try {
        return JSON.parse(matchShared[1]);
      } catch {}
    }

    const match1 = html.match(/window\.__additionalDataLoaded\([^,]+,\s*({[\s\S]*?})\);?\s*<\/script>/);
    if (match1?.[1]) {
      try {
        return JSON.parse(match1[1]);
      } catch {}
    }

    const matchReq = html.match(/require\("ScheduledServerResponse"\)\.handle\(([\s\S]*?)\);?\s*<\/script>/);
    if (matchReq?.[1]) {
      try {
        return JSON.parse(matchReq[1]);
      } catch {}
    }

    const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/);
    if (jsonLdMatch?.[1]) {
      try {
        return JSON.parse(jsonLdMatch[1]);
      } catch {}
    }
  } catch {}
  return null;
}

function cleanBio(bio: string | null): string | null {
  if (!bio) return null;
  // Remove followers/following info and common patterns
  let cleaned = bio
    .replace(/\d+[\s,.]*\d*\s*(followers?|following|posts?)/gi, '')
    .replace(/followers?|following|posts?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Also check if bio contains only numbers and stats
  if (/^\d+[\s,.]*\d*\s*$/.test(cleaned)) return null;
  return cleaned.length > 0 ? cleaned : null;
}

function parseProfileFromHtml(html: string, username: string): Profile {
  const $ = load(html);
  const data = parseInstagramData(html);

  let displayName: string | null = null;
  let bio: string | null = null;
  let isPrivate = false;
  let externalUrl: string | null = null;

  if (data) {
    const entryData = (data as Record<string, unknown>).entry_data as Record<string, unknown> | undefined;
    const profilePage = entryData?.["ProfilePage"] as unknown[] | undefined;
    if (profilePage?.length) {
      const first = profilePage[0] as Record<string, unknown>;
      const graphql = first?.graphql as Record<string, unknown> | undefined;
      const user = graphql?.user as Record<string, unknown> | undefined;
      if (user) {
        displayName = (user.full_name as string) || null;
        bio = (user.biography as string) || null;
        isPrivate = (user.is_private as boolean) || false;
        externalUrl = (user.external_url as string) || null;
      }
    }
  }

  if (!displayName) {
    const ogTitle = $('meta[property="og:title"]').attr("content");
    if (ogTitle) {
      displayName = ogTitle.split("•")[0]?.trim() || ogTitle.trim();
    }
  }

  if (!bio) {
    const ogDescription = $('meta[property="og:description"]').attr("content");
    if (ogDescription) {
      bio = ogDescription;
    }
  }

  if (!displayName) {
    const h1 = $("h1, h2").first().text().trim();
    if (h1 && !h1.includes("Instagram")) displayName = h1;
  }

  if (!isPrivate) {
    const pageText = html.toLowerCase();
    isPrivate = pageText.includes("this account is private") || 
                pageText.includes("private account") ||
                $('*:contains("This account is private")').length > 0;
  }

  const links: string[] = [];
  const profileLink = `https://www.instagram.com/${username}/`;
  links.push(profileLink);
  if (externalUrl) links.push(externalUrl);

  // Clean bio to remove followers/following info
  bio = cleanBio(bio);

  return {
    handle: username,
    displayName: displayName || username,
    bio: bio || null,
    about: bio || null,
    links,
    isPrivate,
  };
}

function parsePostsFromHtml(html: string, username: string): Post[] {
  const $ = load(html);
  const posts: Post[] = [];
  const seen = new Set<string>();

  const addPost = (shortCode: string, url: string, text: string | null, createdAt: string | null = null) => {
    if (seen.has(shortCode) || !isInstagramShortCode(shortCode)) return;
    seen.add(shortCode);
    posts.push({
      id: shortCode,
      url,
      text,
      createdAt,
    });
  };

  $('a[href*="/p/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (!href) return;

    const match = href.match(/\/p\/([a-zA-Z0-9_-]+)/);
    if (!match || !match[1]) return;

    const shortCode = match[1];
    const url = href.startsWith("http") ? href : `https://www.instagram.com${href}`;

    const container = $el.closest("article, div[role='article'], div");
    const caption = container.find("span, div").filter((_, elem) => {
      const text = $(elem).text().trim();
      return text.length > 5 && text.length < 500;
    }).first().text().trim() || null;

    addPost(shortCode, url, caption || null, null);
  });

  const regex = /\/p\/([a-zA-Z0-9_-]{8,})/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const shortCode = match[1];
    if (shortCode && !seen.has(shortCode)) {
      addPost(shortCode, `https://www.instagram.com/p/${shortCode}/`, null, null);
    }
  }

  const data = parseInstagramData(html);
  if (data) {
    const entryData = (data as Record<string, unknown>).entry_data as Record<string, unknown> | undefined;
    const profilePage = entryData?.["ProfilePage"] as unknown[] | undefined;
    if (profilePage?.length) {
      const first = profilePage[0] as Record<string, unknown>;
      const graphql = first?.graphql as Record<string, unknown> | undefined;
      const user = graphql?.user as Record<string, unknown> | undefined;
      const media = user?.edge_owner_to_timeline_media as Record<string, unknown> | undefined;
      const edges = (media?.edges as Array<Record<string, unknown>> | undefined) || [];
      for (const edge of edges) {
        const node = edge?.node as Record<string, unknown> | undefined;
        if (!node) continue;
        const code = node.shortcode as string | undefined;
        const captionEdges = node.edge_media_to_caption as Record<string, unknown> | undefined;
        const captionArr = captionEdges?.edges as Array<Record<string, unknown>> | undefined;
        const captionNode = captionArr?.[0]?.node as Record<string, unknown> | undefined;
        const caption = captionNode?.text as string | undefined;
        const timestamp = node.taken_at_timestamp as number | undefined;
        const createdAt = timestamp ? new Date(timestamp * 1000).toISOString() : null;
        if (code && isInstagramShortCode(code)) {
          addPost(code, `https://www.instagram.com/p/${code}/`, caption ?? null, createdAt);
        }
      }
    }
  }

  return posts;
}

const INSTAGRAM_HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
};

async function fetchProfileHtmlViaHttp(profileUrl: string): Promise<string | null> {
  try {
    const response = await http.get(profileUrl, {
      headers: INSTAGRAM_HTTP_HEADERS,
      timeout: 15000,
      maxRedirects: 3,
    });
    if (!response?.data || (response.status !== 200)) return null;
    const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    if (html.length < 5000 || html.includes("login_and_signup") || html.includes('"require_login":true')) return null;
    return html;
  } catch {
    return null;
  }
}

export async function fetchInstagramProfileAndRecent(target: string, limit: number): Promise<{ profile: Profile; recent: Post[] }> {
  const username = extractUsername(target);
  const profileUrl = `https://www.instagram.com/${username}/`;

  let html: string | null = null;
  let source: "http" | "browser" = "http";

  if (!USE_BROWSER_DEFAULT) {
    html = await fetchProfileHtmlViaHttp(profileUrl);
    if (html) {
      const profile = parseProfileFromHtml(html, username);
      const posts = parsePostsFromHtml(html, username);
      const recent = posts.slice(0, limit);
      logger.info({ username, profileAndPosts: recent.length, source: "http" }, "Instagram profile+recent (HTTP, no browser)");
      return { profile, recent };
    }
  }

  {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent(INSTAGRAM_HTTP_HEADERS["User-Agent"]);
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
      });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        (window as any).chrome = { runtime: {} };
      });
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await delay(2500);
      try {
        await page.waitForSelector('a[href*="/p/"], article', { timeout: 8000 });
      } catch (_) {}
      await delay(1000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1200);
      html = await page.content();
      source = "browser";
    } finally {
      await browser?.close();
    }
  }

  const profile = parseProfileFromHtml(html!, username);
  const posts = parsePostsFromHtml(html!, username);
  const recent = posts.slice(0, limit);
  logger.info({ username, profileAndPosts: recent.length, source }, "Instagram profile+recent");
  return { profile, recent };
}

export async function fetchInstagramAllPosts(target: string): Promise<Post[]> {
  const username = extractUsername(target);
  const profileUrl = `https://www.instagram.com/${username}/`;

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
    
    logger.info({ username }, "[Instagram] Loading profile page to fetch all posts");
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
    
    try {
      await page.waitForSelector('a[href*="/p/"], article, main', { timeout: 10000 });
    } catch (_) {
      logger.warn({ username }, "No posts found on profile page");
    }

    const seenPostIds = new Set<string>();
    let lastPostCount = 0;
    let noNewPostsCount = 0;
    const MAX_NO_NEW_POSTS = 5; // Stop after 5 consecutive scrolls with no new posts (increased)
    let scrollAttempts = 0;
    const MAX_SCROLL_ATTEMPTS = 500; // Safety limit (increased)

    logger.info({ username }, "[Instagram] Starting continuous scroll to load all posts");

    // Continuously scroll and collect post IDs
    while (scrollAttempts < MAX_SCROLL_ATTEMPTS && noNewPostsCount < MAX_NO_NEW_POSTS) {
      scrollAttempts++;
      
      // Scroll down multiple times to trigger lazy loading
      for (let scrollStep = 0; scrollStep < 3; scrollStep++) {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(1000); // Wait between scrolls
      }
      
      // Wait for content to load
      await delay(3000); // Increased wait time
      
      // Get current post IDs from page
      const currentPostIds = await page.evaluate(() => {
        const ids = new Set<string>();
        // Extract from links
        document.querySelectorAll('a[href*="/p/"]').forEach((el) => {
          const href = el.getAttribute("href");
          const match = href?.match(/\/p\/([a-zA-Z0-9_-]+)/);
          if (match && match[1]) ids.add(match[1]);
        });
        // Extract from HTML content
        const html = document.documentElement.innerHTML;
        const regex = /\/p\/([a-zA-Z0-9_-]{8,})/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          if (m[1]) ids.add(m[1]);
        }
        return Array.from(ids);
      });

      // Add new post IDs
      let newPostsFound = 0;
      for (const id of currentPostIds) {
        if (!seenPostIds.has(id)) {
          seenPostIds.add(id);
          newPostsFound++;
        }
      }

      if (newPostsFound > 0) {
        noNewPostsCount = 0;
        logger.info({ username, newPosts: newPostsFound, totalPosts: seenPostIds.size, scrollAttempts }, "[Instagram] Found new posts");
      } else {
        noNewPostsCount++;
        logger.debug({ username, scrollAttempts, noNewPostsCount, totalPosts: seenPostIds.size, currentPostCount: currentPostIds.length }, "[Instagram] No new posts found");
      }

      // Check if we've reached the end (no new posts for a while)
      if (seenPostIds.size === lastPostCount) {
        noNewPostsCount++;
        logger.debug({ username, scrollAttempts, noNewPostsCount, totalPosts: seenPostIds.size }, "[Instagram] Post count unchanged");
      } else {
        lastPostCount = seenPostIds.size;
        noNewPostsCount = 0;
      }

      // Log progress every scroll for debugging
      logger.debug({ username, scrollAttempts, totalPosts: seenPostIds.size, noNewPostsCount, newPostsFound }, "[Instagram] Scroll attempt");
      
      // Log progress every 10 scrolls
      if (scrollAttempts % 10 === 0) {
        logger.info({ username, totalPosts: seenPostIds.size, scrollAttempts, noNewPostsCount }, "[Instagram] Scrolling progress");
      }
    }

    logger.info({ username, totalPosts: seenPostIds.size }, "[Instagram] Finished scrolling, extracting post details from page");

    // Get final HTML with all loaded posts - try multiple times to get all hydration data
    await delay(3000);
    let html = await page.content();
    
    // Try scrolling one more time and getting HTML again to ensure we have latest hydration
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);
    html = await page.content();

    // Parse all posts from HTML
    const posts = parsePostsFromHtml(html, username);
    const allPostsMap = new Map<string, Post>();
    
    // Add posts from parsing (these should have captions from hydration)
    for (const post of posts) {
      if (seenPostIds.has(post.id)) {
        allPostsMap.set(post.id, post);
      }
    }

    // Ensure all seen post IDs are in the result
    for (const postId of seenPostIds) {
      if (!allPostsMap.has(postId)) {
        allPostsMap.set(postId, {
          id: postId,
          url: `https://www.instagram.com/p/${postId}/`,
          text: null,
          createdAt: null,
        });
      }
    }

    const allPosts = Array.from(allPostsMap.values());
    
    await browser.close();

    allPosts.sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    logger.info(
      {
        username,
        totalPosts: allPosts.length,
        withCaptions: allPosts.filter((p) => p.text && String(p.text).trim()).length,
        order: "first → last",
      },
      "[Instagram] All posts fetch completed"
    );

    return allPosts;
  } catch (error: unknown) {
    try {
      await browser?.close();
    } catch (_) {}
    const err = error as { message?: string };
    logger.error({ error: err.message, target }, "Failed to fetch Instagram all posts");
    return [];
  }
}

export async function fetchInstagramProfile(target: string): Promise<Profile> {
  try {
    const username = extractUsername(target);
    
    // Try Apify first for bio (similar to posts)
    if (process.env.APIFY_TOKEN) {
      try {
        const apifyResult = await fetchInstagramViaProvider(username, 1);
        logger.info({ username, source: "apify" }, "Instagram profile (Apify)");
        return apifyResult.profile;
      } catch (error) {
        logger.debug({ username, error: (error as { message?: string }).message }, "Apify failed, falling back to browser");
      }
    }

    const profileUrl = `https://www.instagram.com/${username}/`;

    let html: string;

    if (!USE_BROWSER_DEFAULT) {
      const h = await fetchProfileHtmlViaHttp(profileUrl);
      if (h) return parseProfileFromHtml(h, username);
    }
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent(INSTAGRAM_HTTP_HEADERS["User-Agent"]);
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
      });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        (window as any).chrome = { runtime: {} };
      });
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await delay(3000);
      try {
        await page.waitForSelector('a[href*="/p/"], article', { timeout: 8000 });
      } catch (_) {}
      await delay(1000);
      html = await page.content();
    } finally {
      await browser?.close();
    }
    return parseProfileFromHtml(html, username);
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { status?: number; data?: unknown } };
    logger.error({ error: err.message, target }, "Failed to fetch Instagram profile");
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

export async function fetchInstagramPinned(target: string): Promise<Post | null> {
  try {
    const username = extractUsername(target);
    const profileAndRecent = await fetchInstagramProfileAndRecent(target, 1);
    return profileAndRecent.recent[0] || null;
  } catch (error: unknown) {
    logger.error({ error: (error as { message?: string }).message, target }, "Failed to fetch Instagram pinned post");
    return null;
  }
}

export async function fetchInstagramRecent(target: string, limit: number): Promise<Post[]> {
  try {
    const profileAndRecent = await fetchInstagramProfileAndRecent(target, limit);
    return profileAndRecent.recent;
  } catch (error: unknown) {
    logger.error(
      { error: (error as { message?: string }).message, target },
      "Failed to fetch Instagram recent posts"
    );
    return [];
  }
}
