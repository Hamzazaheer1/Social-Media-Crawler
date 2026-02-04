import type { Profile, Post } from "../../store/types.js";
import { createHttpClient } from "../../core/http.js";
import { logger } from "../../core/logger.js";
import { load } from "cheerio";
import puppeteer from "puppeteer";

const http = createHttpClient();

/* ================= ENV FLAGS ================= */

const USE_BROWSER = process.env.USE_BROWSER_SCRAPING === "true";
const X_SCRAPING_ONLY = true; // 🔒 force scraping only (no API)

const PAGE_LOAD_TIMEOUT_MS = 60000;
const INITIAL_DELAY_MS = 5000;
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ================= HELPERS ================= */

function extractUsername(target: string): string {
  let clean = target.replace(/^@/, "").trim();
  clean = clean.split("?")[0]?.split("&")[0] || clean;

  if (clean.includes("x.com") || clean.includes("twitter.com")) {
    const m = clean.match(/(?:x\.com|twitter\.com)\/([\w_]+)/);
    if (m?.[1]) return m[1];
  }
  return clean;
}

function isGarbageBio(text?: string | null) {
  if (!text) return true;
  const t = text.toLowerCase();
  return (
    t.includes("log in") ||
    t.includes("sign up") ||
    t.includes("don’t miss what’s happening") ||
    t.includes("join the conversation")
  );
}

/* ================= PROFILE ================= */

export async function fetchXProfile(target: string): Promise<Profile> {
  const username = extractUsername(target);
  const profileUrl = `https://x.com/${username}`;

  logger.info({ username }, "[X PROFILE] scraping");

  let html = "";

  try {
    if (USE_BROWSER) {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      );

      await page.goto(profileUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });

      await delay(INITIAL_DELAY_MS);
      await page.waitForSelector('[data-testid="UserDescription"]', { timeout: 12000 }).catch(() => {});
      await delay(2000);
      html = await page.content();
      await browser.close();
    } else {
      const r = await http.get(profileUrl);
      html = r.data;
    }
  } catch (e: any) {
    logger.warn({ error: e?.message }, "[X PROFILE] scrape failed");
  }

  const $ = load(html);

  /* ===== DISPLAY NAME ===== */
  let displayName: string | null = null;
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();

  if (ogTitle) {
    const m = ogTitle.match(/^(.+?)\s*\(@/);
    if (m?.[1]) displayName = m[1].trim();
  }

  /* ===== BIO: meta first, then DOM (X often hides real bio in meta for guests) ===== */
  let bio =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    null;

  if (isGarbageBio(bio)) bio = null;

  if (!bio) {
    const domBio = $('[data-testid="UserDescription"]').text().trim();
    if (domBio && !isGarbageBio(domBio)) bio = domBio;
  }

  if (!bio && html.includes("__INITIAL_STATE__")) {
    try {
      const m = html.match(/__INITIAL_STATE__\s*=\s*(\{.+});/s);
      if (m?.[1]) {
        const state = JSON.parse(m[1]);
        const users = state?.entities?.users?.entities ?? state?.users?.entities ?? {};
        const user = Object.values(users).find((u: any) => (u?.screen_name ?? u?.userName ?? "").toLowerCase() === username.toLowerCase()) as any;
        if (user?.description && !isGarbageBio(user.description)) bio = user.description;
      }
    } catch (_) {}
  }

  /* ===== PRIVATE ACCOUNT DETECT ===== */
  const lower = html.toLowerCase();
  const isPrivate =
    lower.includes("this account is private") ||
    lower.includes("these posts are protected") ||
    lower.includes("only confirmed followers");

  logger.info(
    { username, displayName, bioLength: bio?.length ?? 0, isPrivate },
    "[X PROFILE] result"
  );

  return {
    handle: username,
    displayName,
    bio,
    about: bio,
    links: [],
    isPrivate,
  };
}

/* ================= PINNED ================= */

export async function fetchXPinned(target: string): Promise<Post | null> {
  const username = extractUsername(target);
  const url = `https://x.com/${username}`;

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await delay(4000);

    const html = await page.content();
    await browser.close();

    const $ = load(html);
    const t = $('article[data-testid="tweet"]').first();

    const text = t.find('div[data-testid="tweetText"]').text().trim();
    const href = t.find('a[href*="/status/"]').attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];

    if (id && text) {
      return {
        id,
        url: `https://x.com/${username}/status/${id}`,
        text,
        createdAt: null,
      };
    }
  } catch {}

  return null;
}

/* ================= RECENT ================= */

const SCROLL_DELAY_MS = 600;
const INITIAL_WAIT_MS = 6000;
const RETRY_EXTRA_WAIT_MS = 8000;
const MAX_SCROLL_ROUNDS = 60;

function extractTweetsFromHtml(html: string, username: string, seen: Set<string>, limit: number): Post[] {
  const $ = load(html);
  const out: Post[] = [];
  $('article[data-testid="tweet"]').each((_, el) => {
    if (out.length >= limit) return false;
    const text = $(el).find('div[data-testid="tweetText"]').text().trim() || "";
    const href = $(el).find('a[href*="/status/"]').attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, url: `https://x.com/${username}/status/${id}`, text: text || null, createdAt: null });
    }
  });
  if (out.length > 0) return out;

  // Fallback: X sometimes uses different DOM – get tweet IDs from any status links
  $('a[href*="/status/"]').each((_, el) => {
    if (out.length >= limit) return false;
    const href = $(el).attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];
    if (id && /^\d+$/.test(id) && !seen.has(id)) {
      seen.add(id);
      const text = $(el).closest('article').find('div[data-testid="tweetText"]').text().trim() || null;
      out.push({ id, url: `https://x.com/${username}/status/${id}`, text: text || null, createdAt: null });
    }
  });
  return out;
}

/** Fallback: scrape raw HTML for /status/ID so we don't return 0 when DOM differs. */
function extractTweetIdsFromRawHtml(html: string, username: string, seen: Set<string>, limit: number): Post[] {
  const out: Post[] = [];
  const re = /(?:href|url)["\s:=]+[^"'\s]*\/status\/(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, url: `https://x.com/${username}/status/${id}`, text: null, createdAt: null });
    }
  }
  return out;
}

export async function fetchXRecent(
  target: string,
  limit: number
): Promise<Post[]> {
  const username = extractUsername(target);
  const posts: Post[] = [];
  const seen = new Set<string>();

  logger.info({ username, limit }, "[X RECENT] start");

  const runScrape = async (page: import("puppeteer").Page, extraWaitBeforeStart = 0): Promise<void> => {
    await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await delay(INITIAL_WAIT_MS + extraWaitBeforeStart);
    await page.waitForSelector('article[data-testid="tweet"], a[href*="/status/"]', { timeout: 14000 }).catch(() => {});

    for (let round = 0; round < MAX_SCROLL_ROUNDS && posts.length < limit; round++) {
      const html = await page.content();
      posts.push(...extractTweetsFromHtml(html, username, seen, limit));
      if (posts.length >= limit) return;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(SCROLL_DELAY_MS);
    }

    let html = await page.content();
    posts.push(...extractTweetsFromHtml(html, username, seen, limit));
    if (posts.length === 0) {
      posts.push(...extractTweetIdsFromRawHtml(html, username, seen, limit));
      if (posts.length > 0) logger.info({ username, fromRaw: posts.length }, "[X RECENT] fallback raw HTML");
    }
  };

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setViewport({ width: 1280, height: 900 });

    await runScrape(page);

    if (posts.length === 0) {
      logger.info({ username }, "[X RECENT] 0 tweets, retry with longer wait");
      await delay(RETRY_EXTRA_WAIT_MS);
      await runScrape(page, 3000);
    }

    if (posts.length === 0) {
      await page.goto(`https://x.com/${username}`, { waitUntil: "networkidle2", timeout: 25000 }).catch(() => {});
      await delay(4000);
      const html = await page.content();
      posts.push(...extractTweetsFromHtml(html, username, seen, limit));
      if (posts.length === 0) posts.push(...extractTweetIdsFromRawHtml(html, username, seen, limit));
    }

    await browser.close();

    const result = posts.slice(0, limit);
    logger.info({ collected: result.length, limit }, "[X RECENT] done");
    return result;
  } catch (e: any) {
    logger.warn({ error: e?.message }, "[X RECENT] failed");
  }

  return posts.slice(0, limit);
}
