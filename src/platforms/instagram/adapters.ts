import type { Profile, Post } from "../../store/types.js";
import { logger } from "../../core/logger.js";
import { chromium, type Page } from "playwright";
import fs from "fs";
import { load } from "cheerio";

const STATE_PATH = "./storage/instagram_state.json";
const HEADLESS = process.env.HEADLESS !== "false";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function useGuestMode(): boolean {
  if (process.env.INSTAGRAM_USE_GUEST === "true" || process.env.INSTAGRAM_USE_GUEST === "1") return true;
  if (!fs.existsSync(STATE_PATH)) return true;
  return false;
}

/* ================= HELPERS ================= */

function extractUsername(target: string): string {
  let clean = target.replace(/^@/, "").trim();
  if (clean.includes("instagram.com")) {
    const m = clean.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
    if (m?.[1]) return m[1];
  }
  return clean;
}

function isInstagramShortCode(id: unknown): boolean {
  if (id == null) return false;
  return /^[a-zA-Z0-9_-]{8,}$/.test(String(id).trim());
}

async function openPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const guest = useGuestMode();
  if (guest) logger.info("[Instagram] using guest mode (no login)");

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  };
  if (!guest) contextOptions.storageState = STATE_PATH;

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function forceProfileTab(page: Page, username: string) {
  await page.goto(`https://www.instagram.com/${username}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await delay(4000);
}

/* ================= PARSING (from HTML / DOM) ================= */

function parseInstagramData(html: string): Record<string, unknown> | null {
  try {
    const m = html.match(/window\._sharedData\s*=\s*({[\s\S]*?});\s*<\/script>/);
    if (m?.[1]) return JSON.parse(m[1]) as Record<string, unknown>;
    const m2 = html.match(/require\("ScheduledServerResponse"\)\.handle\(([\s\S]*?)\);?\s*<\/script>/);
    if (m2?.[1]) return JSON.parse(m2[1]) as Record<string, unknown>;
    const jsonLd = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/);
    if (jsonLd?.[1]) return JSON.parse(jsonLd[1]) as Record<string, unknown>;
  } catch {}
  return null;
}

/** True if string looks like "123K Followers, 456 Following, 789 Posts" (stats line), not real bio */
function isLikelyStatsDescription(s: string): boolean {
  const t = s.trim();
  if (t.length < 5) return false;
  const hasFollowers = /\d+[\s,.]*\d*\s*(k|m|b)?\s*followers?/i.test(t);
  const hasFollowing = /following/i.test(t);
  const hasPosts = /\d+[\s,.]*\d*\s*(k|m|b)?\s*posts?/i.test(t);
  const mostlyNumbersAndStats = (t.match(/\d+|followers?|following|posts?/gi)?.length ?? 0) >= 2 && t.length < 80;
  return (hasFollowers && hasFollowing) || mostlyNumbersAndStats;
}

/** Strip " (@username)" or " (username)" from end of display name (og:title often has this). */
function cleanDisplayName(name: string | null, username: string): string | null {
  if (!name) return null;
  const t = name.replace(/\s*\(@?[\w_.]+\)\s*$/i, "").trim();
  return t.length > 0 ? t : null;
}

/** True if text is just the handle/username, not a real bio. */
function isJustHandle(text: string | null, username: string): boolean {
  if (!text) return true;
  const t = text.trim();
  const handle = username.replace(/^@/, "");
  return t === handle || t === username || t === `@${handle}`;
}

/** Strip username, display name, "Followed by...", and story highlights so only the actual bio text remains. */
function stripBioOnly(bio: string, username: string, displayName: string | null): string {
  const handle = username.replace(/^@/, "");
  let t = bio.trim();
  const toStripStart = [handle, `@${handle}`, displayName].filter(Boolean) as string[];
  for (const s of toStripStart) {
    const re = new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
    t = t.replace(re, "");
  }
  t = t.replace(/\s*Followed by[\s\S]*$/i, "").trim();
  return t;
}

function cleanBio(bio: string | null): string | null {
  if (!bio) return null;
  const cleaned = bio
    .replace(/\d+[\s,.]*\d*\s*(followers?|following|posts?)/gi, "")
    .replace(/followers?|following|posts?/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
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
    const first = profilePage?.[0] as Record<string, unknown> | undefined;
    const graphql = first?.graphql as Record<string, unknown> | undefined;
    const user = graphql?.user as Record<string, unknown> | undefined;
    if (user) {
      displayName = (user.full_name as string) || null;
      const rawBio = (user.biography as string) || null;
      if (rawBio && !isJustHandle(rawBio, username)) bio = rawBio;
      isPrivate = (user.is_private as boolean) || false;
      externalUrl = (user.external_url as string) || null;
    }
  }
  const ogTitle = $('meta[property="og:title"]').attr("content")?.split("•")[0]?.trim() || null;
  if (!displayName) displayName = ogTitle;
  else if (ogTitle) displayName = cleanDisplayName(ogTitle, username) || displayName;
  const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || null;
  if (!bio && ogDesc && !isLikelyStatsDescription(ogDesc) && !isJustHandle(ogDesc, username)) bio = ogDesc;
  if (bio && isJustHandle(bio, username)) bio = null;
  if (!bio && ogDesc && !isLikelyStatsDescription(ogDesc) && !isJustHandle(ogDesc, username)) bio = ogDesc;
  if (!displayName) {
    const h1 = $("h1, h2").first().text().trim();
    if (h1 && !h1.includes("Instagram")) displayName = h1;
  }
  if (!isPrivate) {
    const lower = html.toLowerCase();
    isPrivate = lower.includes("this account is private") || lower.includes("private account");
  }
  const links = [`https://www.instagram.com/${username}/`];
  if (externalUrl) links.push(externalUrl);
  bio = cleanBio(bio);

  const finalDisplayName = cleanDisplayName(displayName || username, username) || displayName || username;
  return {
    handle: username,
    displayName: finalDisplayName,
    bio,
    about: bio,
    links,
    isPrivate,
  };
}

function parsePostsFromHtml(html: string, username: string): Post[] {
  const $ = load(html);
  const posts: Post[] = [];
  const seen = new Set<string>();
  const add = (shortCode: string, url: string, text: string | null, createdAt: string | null = null) => {
    if (!isInstagramShortCode(shortCode) || seen.has(shortCode)) return;
    seen.add(shortCode);
    posts.push({ id: shortCode, url, text, createdAt });
  };
  $('a[href*="/p/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const match = href.match(/\/p\/([a-zA-Z0-9_-]+)/);
    if (!match?.[1]) return;
    const shortCode = match[1];
    const url = href.startsWith("http") ? href : `https://www.instagram.com${href}`;
    const container = $(el).closest("article, div[role='article'], div");
    const caption = container.find("span, div").filter((_, e) => {
      const t = $(e).text().trim();
      return t.length > 5 && t.length < 500;
    }).first().text().trim() || null;
    const timeEl = container.find("time[datetime]").first();
    const createdAt = timeEl.length ? timeEl.attr("datetime") || null : null;
    add(shortCode, url, caption || null, createdAt);
  });
  const regex = /\/p\/([a-zA-Z0-9_-]{8,})/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    if (m[1] && !seen.has(m[1])) add(m[1], `https://www.instagram.com/p/${m[1]}/`, null, null);
  }
  const data = parseInstagramData(html) as Record<string, unknown> | undefined;
  const entryData = data?.entry_data as Record<string, unknown> | undefined;
  const profilePage = entryData?.["ProfilePage"] as unknown[] | undefined;
  const first = profilePage?.[0] as Record<string, unknown> | undefined;
  const graphql = first?.graphql as Record<string, unknown> | undefined;
  const user = graphql?.user as Record<string, unknown> | undefined;
  const media = user?.edge_owner_to_timeline_media as Record<string, unknown> | undefined;
  const edges = media?.edges as Array<Record<string, unknown>> | undefined;
  if (edges) {
    for (const edge of edges) {
      const node = edge?.node as Record<string, unknown> | undefined;
      if (!node) continue;
      const code = node.shortcode as string | undefined;
      const captionEdges = node.edge_media_to_caption as Record<string, unknown> | undefined;
      const captionArr = captionEdges?.edges as Array<Record<string, unknown>> | undefined;
      const caption = (captionArr?.[0]?.node as Record<string, unknown>)?.text as string | undefined;
      const ts = node.taken_at_timestamp as number | undefined;
      const createdAt = ts ? new Date(ts * 1000).toISOString() : null;
      if (code && isInstagramShortCode(code)) add(code, `https://www.instagram.com/p/${code}/`, caption ?? null, createdAt);
    }
  }
  return posts;
}

/* ================= PROFILE ================= */

export async function fetchInstagramProfile(target: string): Promise<Profile> {
  const username = extractUsername(target);
  const { page, close } = await openPage();
  try {
    logger.info({ username }, "[Instagram PROFILE] loading profile");
    await forceProfileTab(page, username);
    await page.waitForSelector('a[href*="/p/"], article, main, header', { timeout: 15000 }).catch(() => {});
    await delay(2000);
    const html = await page.content();
    let profile = parseProfileFromHtml(html, username);

    const fromDom = await page.evaluate(() => {
      let displayName: string | null = null;
      let bio: string | null = null;
      const header = document.querySelector("header");
      if (header) {
        const fullText = (header as HTMLElement).innerText || header.textContent || "";
        const lines = fullText.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        const statsIdx = lines.findIndex((l) => /^\d+[\s,.]*\d*\s*(k|m|b)?\s*posts?/i.test(l) && /followers?/i.test(l));
        const afterStats = statsIdx >= 0 ? lines.slice(statsIdx + 1) : lines;
        const skipFirst = afterStats[0] && /^(follow|message|add|\.\.\.)$/i.test(afterStats[0]) ? 1 : 0;
        const contentLines = afterStats.slice(skipFirst).filter((l) => {
          if (/^\d+[\s,.]*\d*\s*(k|m|b)?\s*(followers?|following|posts?)/i.test(l)) return false;
          if (/^(follow|message|add|\.\.\.|posts?|followers?|following)$/i.test(l)) return false;
          return l.length > 0 && l.length < 600;
        });
        const first = contentLines[0];
        if (first !== undefined && contentLines.length > 0) {
          const looksLikeHandle = /^[@\w_.]+$/.test(first) && (first.includes("_") || first.includes("."));
          if (!looksLikeHandle && first.length >= 2 && first.length <= 80) {
            displayName = first;
            if (contentLines.length > 1) {
              const bioText = contentLines.slice(1).join("\n").trim();
              bio = bioText.length >= 2 ? bioText : null;
            }
          } else {
            bio = contentLines.join("\n").trim() || null;
          }
        }
        if (!bio) {
          const spans = header.querySelectorAll("span");
          for (const s of spans) {
            const t = s.textContent?.trim() || "";
            if (t.length > 15 && t.length < 600) {
              const looksLikeStats = /^\d+[\s,.]*\d*\s*(k|m|b)?\s*(followers?|following|posts?)/i.test(t) ||
                (/\d+[\s,.]*\d*\s*(followers?|following|posts?)/gi.test(t) && t.length < 80);
              if (!looksLikeStats && !/^[@\w_.]+$/.test(t)) {
                if (!displayName && t.indexOf("\n") === -1 && t.length <= 80) displayName = t;
                else if (!bio || t.length > (bio?.length ?? 0)) bio = t;
              }
            }
          }
        }
      }
      const metaDesc = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() || null;
      const metaLooksLikeStats = metaDesc && /^\d+[\s,.]*\d*\s*(k|m|b)?\s*followers?/i.test(metaDesc) && /following/i.test(metaDesc);
      if (!bio && metaDesc && !metaLooksLikeStats) bio = metaDesc;
      const metaTitle = document.querySelector('meta[property="og:title"]');
      if (!displayName && metaTitle) displayName = metaTitle.getAttribute("content")?.split("•")[0]?.trim() || null;
      return { displayName, bio };
    });
    if (fromDom.displayName) {
      const cleaned = cleanDisplayName(fromDom.displayName, username) || fromDom.displayName;
      if (!profile.displayName) profile = { ...profile, displayName: cleaned };
      else profile = { ...profile, displayName: cleanDisplayName(profile.displayName, username) || profile.displayName };
    } else if (profile.displayName) {
      profile = { ...profile, displayName: cleanDisplayName(profile.displayName, username) || profile.displayName };
    }
    if (fromDom.bio && !isJustHandle(fromDom.bio, username)) {
      const onlyBio = stripBioOnly(fromDom.bio, username, fromDom.displayName ?? profile.displayName ?? null);
      const cleaned = cleanBio(onlyBio.length > 0 ? onlyBio : fromDom.bio);
      if (cleaned && !isLikelyStatsDescription(cleaned)) profile = { ...profile, bio: cleaned, about: cleaned };
    }
    if (profile.bio && isJustHandle(profile.bio, username)) profile = { ...profile, bio: null, about: null };
    if (profile.bio && !profile.about) profile = { ...profile, about: profile.bio };
    logger.info({ username, hasName: !!profile.displayName, hasBio: !!profile.bio }, "[Instagram PROFILE] extracted");
    return profile;
  } finally {
    await close();
  }
}

/* ================= PINNED (first post) ================= */

export async function fetchInstagramPinned(target: string): Promise<Post | null> {
  const username = extractUsername(target);
  const { page, close } = await openPage();
  try {
    logger.info({ username }, "[Instagram PINNED] checking first post");
    await forceProfileTab(page, username);
    await page.waitForSelector('a[href*="/p/"]', { timeout: 15000 }).catch(() => {});
    await delay(2000);
    const first = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/p/"]') as HTMLAnchorElement | null;
      if (!link) return null;
      const href = link.href;
      const match = href.match(/\/p\/([a-zA-Z0-9_-]+)/);
      if (!match?.[1]) return null;
      return { id: match[1], url: href };
    });
    if (first) {
      logger.info({ username, found: true }, "[Instagram PINNED] result");
      return { id: first.id, url: first.url, text: null, createdAt: null };
    }
    const html = await page.content();
    const posts = parsePostsFromHtml(html, username);
    const pinned = posts[0] ?? null;
    logger.info({ username, found: !!pinned }, "[Instagram PINNED] result");
    return pinned;
  } finally {
    await close();
  }
}

/* ================= PROFILE + RECENT ================= */

export async function fetchInstagramProfileAndRecent(target: string, limit: number): Promise<{ profile: Profile; recent: Post[] }> {
  const username = extractUsername(target);
  const { page, close } = await openPage();
  try {
    logger.info({ username, limit }, "[Instagram] fetching profile + recent");
    await forceProfileTab(page, username);
    await page.waitForSelector('a[href*="/p/"], article, main', { timeout: 15000 }).catch(() => {});
    await delay(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);
    const html = await page.content();
    const profile = parseProfileFromHtml(html, username);
    const posts = parsePostsFromHtml(html, username);
    const recent = posts.slice(0, limit);
    logger.info({ username, profileAndPosts: recent.length }, "[Instagram] profile+recent");
    return { profile, recent };
  } finally {
    await close();
  }
}

/** Extract actual caption from Instagram og:description (e.g. "83K likes, 316 comments - user on Date: \"caption\"." → "caption"). */
function extractCaptionFromOgDescription(og: string): string {
  const colonIdx = og.lastIndexOf(":");
  if (colonIdx === -1) return og;
  const after = og.slice(colonIdx + 1).trim();
  const quoted = after.match(/^["']([\s\S]*?)["']\.?$/);
  if (quoted?.[1]) return quoted[1].trim();
  if (after.length > 0 && after.length < 5000) return after.replace(/\.$/, "").trim();
  return og;
}

/** Fetch caption for a single post by opening its page (og:description or DOM) — same idea as Twitter fetching tweet text. */
async function fetchCaptionForPost(page: Page, postUrl: string): Promise<string | null> {
  try {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 6000 });
    await delay(800);
    const raw = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim();
      if (og && og.length > 2 && og.length < 5000) return og;
      const article = document.querySelector("article");
      const captionEl = article?.querySelector('[data-ad-preview="message"], span');
      const t = captionEl?.textContent?.trim();
      if (t && t.length > 2 && t.length < 5000) return t;
      return null;
    });
    if (!raw) return null;
    if (/^\d+[kKmM]?\s*likes?,\s*\d+/.test(raw)) return extractCaptionFromOgDescription(raw);
    return raw;
  } catch {
    return null;
  }
}

// Fetch caption for posts that don't have it (open each post page). 0 = fetch ALL; N = first N only. Set INSTAGRAM_FETCH_CAPTIONS=50 to limit.
const MAX_CAPTION_FETCH = Math.max(0, parseInt(process.env.INSTAGRAM_FETCH_CAPTIONS ?? "0", 10));

/* ================= ALL POSTS (FULL HISTORY) ================= */

export async function fetchInstagramAllPosts(target: string): Promise<Post[]> {
  const username = extractUsername(target);
  const { page, close } = await openPage();
  try {
    await forceProfileTab(page, username);
    const seen = new Set<string>();
    const posts: Post[] = [];
    let lastCursorId: string | null = null;
    let stagnantRounds = 0;
    let round = 0;
    logger.info({ username }, "[Instagram ALL] scroll-based full history started");

    while (stagnantRounds < 5) {
      round++;
      const batch = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/p/"]'))
          .map((a) => {
            const href = (a as HTMLAnchorElement).href;
            const m = href.match(/\/p\/([a-zA-Z0-9_-]+)/);
            if (!m?.[1]) return null;
            const id = m[1];
            let text: string | null = null;
            let createdAt: string | null = null;
            const container = a.closest("article, div[role='article'], [style*='flex']");
            if (container) {
              const spans = container.querySelectorAll("span");
              for (const s of spans) {
                const t = s.textContent?.trim() || "";
                if (t.length > 5 && t.length < 2000) {
                  text = t;
                  break;
                }
              }
              const timeEl = container.querySelector("time");
              if (timeEl) {
                const dt = timeEl.getAttribute("datetime");
                if (dt) createdAt = dt;
              }
            }
            return { id, url: href, text, createdAt };
          })
          .filter(Boolean) as { id: string; url: string; text: string | null; createdAt: string | null }[];
      });

      let added = 0;
      for (const p of batch) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          posts.push({ id: p.id, url: p.url, text: p.text ?? null, createdAt: p.createdAt ?? null });
          added++;
        }
      }
      const lastBatch = batch.length > 0 ? batch[batch.length - 1] : null;
      const newCursorId = lastBatch?.id ?? null;
      logger.info({ round, newlyFetched: added, totalFetched: posts.length, cursor: newCursorId }, "[Instagram ALL] progress");

      if (newCursorId && newCursorId !== lastCursorId) {
        lastCursorId = newCursorId;
        stagnantRounds = 0;
      } else {
        stagnantRounds++;
        logger.warn({ stagnantRounds }, "[Instagram ALL] cursor not moving");
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(6000 + stagnantRounds * 2000);

      if (lastCursorId) {
        try {
          await page.waitForFunction(
            (cursor: string) => {
              const links = Array.from(document.querySelectorAll('a[href*="/p/"]')).map((a) => (a as HTMLAnchorElement).href);
              return !links.some((h) => h.includes(cursor));
            },
            lastCursorId,
            { timeout: 20000 }
          );
        } catch {
          /* ignore */
        }
      }
    }

    // Extra scrolls so we don't miss last 1–3 posts (26→24, 159→158 etc.)
    for (let extra = 0; extra < 2; extra++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(4000);
      const extraBatch = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/p/"]'))
          .map((a) => {
            const href = (a as HTMLAnchorElement).href;
            const m = href.match(/\/p\/([a-zA-Z0-9_-]+)/);
            return m?.[1] ? { id: m[1], url: href } : null;
          })
          .filter(Boolean) as { id: string; url: string }[];
      });
      for (const p of extraBatch) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          posts.push({ id: p.id, url: p.url, text: null, createdAt: null });
        }
      }
    }

    const html = await page.content();
    const parsed = parsePostsFromHtml(html, username);
    const byId = new Map<string, Post>();
    for (const p of posts) byId.set(p.id, p);
    for (const p of parsed) {
      if (byId.has(p.id)) {
        const existing = byId.get(p.id)!;
        if (p.text || p.createdAt) byId.set(p.id, { ...existing, text: p.text ?? existing.text ?? null, createdAt: p.createdAt ?? existing.createdAt ?? null });
      } else {
        byId.set(p.id, p);
      }
    }
    let merged = Array.from(byId.values());
    merged.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const withoutCaption = merged.filter((p) => !p.text);
    const toFetch = MAX_CAPTION_FETCH > 0 ? withoutCaption.slice(0, MAX_CAPTION_FETCH) : withoutCaption;
    if (toFetch.length > 0) {
      logger.info({ username, count: toFetch.length }, "[Instagram ALL] fetching captions (like Twitter text) from post pages");
      for (let i = 0; i < toFetch.length; i++) {
        const p = toFetch[i];
        if (!p?.url) continue;
        const caption = await fetchCaptionForPost(page, p.url);
        if (caption) p.text = caption;
        if ((i + 1) % 10 === 0 || i === toFetch.length - 1) {
          logger.info({ username, done: i + 1, total: toFetch.length }, "[Instagram ALL] captions progress");
        }
        if (i < toFetch.length - 1) await delay(600);
      }
    }

    logger.info({ username, total: merged.length }, "[Instagram ALL] reached end of timeline");
    return merged;
  } finally {
    await close();
  }
}

export async function fetchInstagramRecent(target: string, limit: number): Promise<Post[]> {
  const { recent } = await fetchInstagramProfileAndRecent(target, limit);
  return recent;
}
