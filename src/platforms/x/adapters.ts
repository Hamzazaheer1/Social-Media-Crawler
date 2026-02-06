import type { Profile, Post } from "../../store/types.js";
import { logger } from "../../core/logger.js";
import { load } from "cheerio";
import puppeteer from "puppeteer";

const PAGE_LOAD_TIMEOUT_MS = 60000;
const INITIAL_DELAY_MS = 5000;
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));


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


function parseProfileFromHtml(html: string, username: string): Profile {
  const $ = load(html);

  let displayName: string | null = null;
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();

  if (ogTitle) {
    const m = ogTitle.match(/^(.+?)\s*\(@/);
    if (m?.[1]) displayName = m[1].trim();
  }

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

  const lower = html.toLowerCase();
  const isPrivate =
    lower.includes("this account is private") ||
    lower.includes("these posts are protected") ||
    lower.includes("only confirmed followers");

  return {
    handle: username,
    displayName,
    bio,
    about: bio,
    links: [],
    isPrivate,
  };
}

export async function fetchXProfile(target: string): Promise<Profile> {
  const username = extractUsername(target);
  const profileUrl = `https://x.com/${username}`;

  logger.info({ username }, "[X PROFILE] scraping");

  let html = "";

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });

    await delay(INITIAL_DELAY_MS);
    await page.waitForSelector('[data-testid="UserDescription"], article[data-testid="tweet"]', { timeout: 12000 }).catch(() => {});
    await delay(2000);
    html = await page.content();
    await browser.close();
  } catch (e: any) {
    logger.warn({ error: e?.message }, "[X PROFILE] scrape failed");
  }

  const profile = parseProfileFromHtml(html, username);
  
  logger.info(
    { username, displayName: profile.displayName, bioLength: profile.bio?.length ?? 0, isPrivate: profile.isPrivate },
    "[X PROFILE] result"
  );

  return profile;
}


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


function extractTweetsFromHtml(html: string, username: string, seen: Set<string>, limit: number): Post[] {
  const $ = load(html);
  const out: Post[] = [];
  
  $('article[data-testid="tweet"]').each((_, el) => {
    if (out.length >= limit) return false;
    const $el = $(el);
    const text = $el.find('div[data-testid="tweetText"]').text().trim() || "";
    const href = $el.find('a[href*="/status/"]').attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, url: `https://x.com/${username}/status/${id}`, text: text || null, createdAt: null });
    }
  });
  
  if (out.length > 0) return out;

  $('a[href*="/status/"]').each((_, el) => {
    if (out.length >= limit) return false;
    const $el = $(el);
    const href = $el.attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];
    if (id && /^\d+$/.test(id) && !seen.has(id)) {
      seen.add(id);
      const text = $el.closest('article').find('div[data-testid="tweetText"]').text().trim() || null;
      out.push({ id, url: `https://x.com/${username}/status/${id}`, text: text || null, createdAt: null });
    }
  });
  return out;
}

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

function parsePostsFromHtml(html: string, username: string): Post[] {
  const posts: Post[] = [];
  const seen = new Set<string>();
  
  const addPost = (id: string, url: string, text: string | null, createdAt: string | null = null) => {
    if (seen.has(id)) return;
    seen.add(id);
    posts.push({ id, url, text, createdAt });
  };

  const $ = load(html);
  $('article[data-testid="tweet"]').each((_, el) => {
    const $el = $(el);
    const text = $el.find('div[data-testid="tweetText"]').text().trim() || "";
    const href = $el.find('a[href*="/status/"]').attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];
    if (id) {
      const url = href?.startsWith("http") ? href : `https://x.com${href}`;
      addPost(id, url, text || null, null);
    }
  });

  $('a[href*="/status/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const id = href?.match(/\/status\/(\d+)/)?.[1];
    if (id && /^\d+$/.test(id) && !seen.has(id)) {
      const text = $el.closest('article').find('div[data-testid="tweetText"]').text().trim() || null;
      const url = href?.startsWith("http") ? href : `https://x.com${href}`;
      addPost(id, url, text, null);
    }
  });

  const re = /\/status\/(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const id = match[1];
    if (id && !seen.has(id)) {
      addPost(id, `https://x.com/${username}/status/${id}`, null, null);
    }
  }

  return posts;
}


export async function fetchXProfileAndRecent(target: string, limit: number): Promise<{ profile: Profile; recent: Post[] }> {
  const username = extractUsername(target);
  const profileUrl = `https://x.com/${username}`;

  logger.info({ username, limit }, "[X] fetching profile + recent");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
    
    try {
      await page.waitForSelector('article[data-testid="tweet"], [data-testid="UserDescription"]', { timeout: 10000 });
    } catch (_) {
      logger.warn({ username }, "No tweets or bio found on profile page");
    }
    
    await delay(2000);
    
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1500);

    let bioFromBrowser: string | null = null;
    try {
      bioFromBrowser = await page.evaluate(() => {
        const selectors = [
          '[data-testid="UserDescription"]',
          'div[data-testid="UserDescription"] span',
          'div[dir="ltr"] span',
        ];
        
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            const text = (el.textContent || '').trim();
            if (text && text.length > 5 && text.length < 500) {
              return text;
            }
          }
        }
        return null;
      });
    } catch (_) {}

    const html = await page.content();
    
    const profile = parseProfileFromHtml(html, username);
    
    if (bioFromBrowser && bioFromBrowser.length > 5 && !isGarbageBio(bioFromBrowser)) {
      profile.bio = bioFromBrowser;
      profile.about = bioFromBrowser;
      logger.info({ username, bioLength: bioFromBrowser.length }, "[X] Bio extracted from browser DOM");
    }

    const posts = parsePostsFromHtml(html, username);
    const recent = posts.slice(0, limit);

    logger.info({ username, profileAndPosts: recent.length }, "[X] profile+recent (fast single fetch)");
    return { profile, recent };
  } finally {
    await browser?.close();
  }
}


const SCROLL_DELAY_MS = 1000;
const INITIAL_WAIT_MS = 5000;
const MAX_NO_NEW_TWEETS = 5;
const MAX_SCROLL_ATTEMPTS = 500;

export async function fetchXAllPosts(target: string): Promise<Post[]> {
  const username = extractUsername(target);
  const profileUrl = `https://x.com/${username}`;

  logger.info({ username }, "[X] Loading profile page to fetch all tweets");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
    
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
    } catch (_) {
      logger.warn({ username }, "No tweets found on profile page");
    }

    const seenTweetIds = new Set<string>();
    let lastTweetCount = 0;
    let noNewTweetsCount = 0;
    let scrollAttempts = 0;

    logger.info({ username }, "[X] Starting continuous scroll to load all tweets");

    while (scrollAttempts < MAX_SCROLL_ATTEMPTS && noNewTweetsCount < MAX_NO_NEW_TWEETS) {
      scrollAttempts++;
      
      for (let scrollStep = 0; scrollStep < 3; scrollStep++) {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await delay(SCROLL_DELAY_MS);
      }
      
      await delay(3000);
      
      const currentTweetIds = await page.evaluate(() => {
        const ids = new Set<string>();
        document.querySelectorAll('a[href*="/status/"]').forEach((el) => {
          const href = el.getAttribute("href");
          const match = href?.match(/\/status\/(\d+)/);
          if (match && match[1]) ids.add(match[1]);
        });
        const html = document.documentElement.innerHTML;
        const regex = /\/status\/(\d+)/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
          if (m[1]) ids.add(m[1]);
        }
        return Array.from(ids);
      });

      let newTweetsFound = 0;
      for (const id of currentTweetIds) {
        if (!seenTweetIds.has(id)) {
          seenTweetIds.add(id);
          newTweetsFound++;
        }
      }

      if (newTweetsFound > 0) {
        noNewTweetsCount = 0;
        logger.debug({ username, newTweets: newTweetsFound, totalTweets: seenTweetIds.size }, "Found new tweets");
      } else {
        noNewTweetsCount++;
      }

      if (seenTweetIds.size === lastTweetCount) {
        noNewTweetsCount++;
      } else {
        lastTweetCount = seenTweetIds.size;
        noNewTweetsCount = 0;
      }

      if (scrollAttempts % 10 === 0) {
        logger.info({ username, totalTweets: seenTweetIds.size, scrollAttempts, noNewTweetsCount }, "[X] Scrolling progress");
      }
    }

    logger.info({ username, totalTweets: seenTweetIds.size }, "[X] Finished scrolling, extracting tweet details from page");

    await delay(3000);
    let html = await page.content();
    
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);
    html = await page.content();

    const allPosts = parsePostsFromHtml(html, username);
    const allPostsMap = new Map<string, Post>();
    
    for (const post of allPosts) {
      if (seenTweetIds.has(post.id)) {
        allPostsMap.set(post.id, post);
      }
    }

    for (const tweetId of seenTweetIds) {
      if (!allPostsMap.has(tweetId)) {
        allPostsMap.set(tweetId, {
          id: tweetId,
          url: `https://x.com/${username}/status/${tweetId}`,
          text: null,
          createdAt: null,
        });
      }
    }

    const finalPosts = Array.from(allPostsMap.values());
    
    const finalSortedPosts = finalPosts.reverse();

    logger.info(
      {
        username,
        totalPosts: finalSortedPosts.length,
        withCaptions: finalSortedPosts.filter((p) => p.text && String(p.text).trim()).length,
        order: "first → last",
      },
      "[X] All tweets fetch completed"
    );

    return finalSortedPosts;
  } catch (error: unknown) {
    try {
      await browser?.close();
    } catch (_) {}
    const err = error as { message?: string };
    logger.error({ error: err.message, target }, "Failed to fetch X all tweets");
    return [];
  }
}


const MAX_SCROLL_ROUNDS = 60;
const RETRY_EXTRA_WAIT_MS = 8000;

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
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setViewport({ width: 1920, height: 1080 });

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
