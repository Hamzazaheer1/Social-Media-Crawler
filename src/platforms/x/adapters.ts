import type { Profile, Post } from "../../store/types.js";
import { logger } from "../../core/logger.js";
import { chromium, type Page } from "playwright";
import fs from "fs";

const STATE_PATH = "./storage/x_state.json";
const HEADLESS = false;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ================= HELPERS ================= */

function extractUsername(target: string): string {
  let clean = target.replace(/^@/, "").trim();
  if (clean.includes("x.com") || clean.includes("twitter.com")) {
    const m = clean.match(/(?:x\.com|twitter\.com)\/([\w_]+)/);
    if (m?.[1]) return m[1];
  }
  return clean;
}

async function openLoggedInPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error("❌ storage/x_state.json missing. Run x-auth-setup first.");
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    storageState: STATE_PATH,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function forceTweetsTab(page: Page, username: string) {
  await page.goto(`https://x.com/${username}/tweets`, {
    waitUntil: "domcontentloaded",
  });
  await delay(4000);
}

/* ================= PROFILE ================= */

export async function fetchXProfile(target: string): Promise<Profile> {
  const username = extractUsername(target);
  const { page, close } = await openLoggedInPage();

  try {
    logger.info({ username }, "[X PROFILE] loading profile");
    await forceTweetsTab(page, username);

    await page.waitForSelector('[data-testid="UserName"]', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('[data-testid="UserDescription"]', { timeout: 15000 }).catch(() => {});

    const profile = await page.evaluate(() => {
      const name =
        document.querySelector('[data-testid="UserName"] span')?.textContent?.trim() ||
        document.querySelector("h2[role='heading'] span")?.textContent?.trim() ||
        null;

      const bio =
        document.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() ||
        null;

      return { name, bio };
    });

    logger.info(
      { username, hasName: !!profile.name, hasBio: !!profile.bio },
      "[X PROFILE] extracted"
    );

    return {
      handle: username,
      displayName: profile.name,
      bio: profile.bio,
      about: profile.bio,
      links: [`https://x.com/${username}`],
      isPrivate: false,
    };
  } finally {
    await close();
  }
}

/* ================= PINNED ================= */

export async function fetchXPinned(target: string): Promise<Post | null> {
  const username = extractUsername(target);
  const { page, close } = await openLoggedInPage();

  try {
    logger.info({ username }, "[X PINNED] checking pinned tweet");
    await forceTweetsTab(page, username);

    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => {});
    await delay(2000);

    const pinned = await page.evaluate(() => {
      const t = document.querySelector('article[data-testid="tweet"]');
      if (!t) return null;

      const link = t.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
      const id = link?.href.match(/status\/(\d+)/)?.[1];
      const text = t.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || null;
      const time = t.querySelector("time")?.getAttribute("datetime") || null;

      if (!id) return null;
      return { id, url: link?.href, text, createdAt: time };
    });

    logger.info(
      { username, found: !!pinned },
      "[X PINNED] result"
    );

    return pinned;
  } finally {
    await close();
  }
}

/* ================= ALL POSTS (FULL HISTORY) ================= */

export async function fetchXAllPosts(target: string): Promise<Post[]> {
  const username = extractUsername(target);
  const { page, close } = await openLoggedInPage();

  try {
    await forceTweetsTab(page, username);

    const seen = new Set<string>();
    const posts: Post[] = [];

    let lastCursorId: string | null = null;
    let stagnantRounds = 0;
    let round = 0;

    logger.info({ username }, "[X ALL] cursor-based full history started");

    while (stagnantRounds < 5) {
      round++;

      // 1️⃣ Extract visible tweets
      const batch = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
          .map((t) => {
            const link = t.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;
            const id = link?.href.match(/status\/(\d+)/)?.[1] ?? null;
            const text =
              t.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? null;
            const time =
              t.querySelector("time")?.getAttribute("datetime") ?? null;

            if (!id) return null;
            return { id, url: link?.href ?? "", text, createdAt: time };
          })
          .filter(Boolean);
      });

      // 2️⃣ Deduplicate + add
      let added = 0;
      for (const p of batch as Post[]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          posts.push(p);
          added++;
        }
      }

      const newCursorId =
        batch.length > 0 ? (batch[batch.length - 1] as Post).id : null;

      logger.info(
        {
          round,
          newlyFetched: added,
          totalFetched: posts.length,
          cursor: newCursorId,
        },
        "[X ALL] progress"
      );

      // 3️⃣ Cursor comparison
      if (newCursorId && newCursorId !== lastCursorId) {
        lastCursorId = newCursorId;
        stagnantRounds = 0;
      } else {
        stagnantRounds++;
        logger.warn(
          { stagnantRounds },
          "[X ALL] cursor not moving, waiting longer"
        );
      }

      // 4️⃣ Scroll down
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      // ⏳ Adaptive delay (slow internet safe)
      await delay(6000 + stagnantRounds * 2000);

      // 5️⃣ WAIT until new tweets appear (NULL-SAFE ✅)
      if (lastCursorId) {
        try {
          await page.waitForFunction(
            (cursor: string) => {
              const links = Array.from(
                document.querySelectorAll('a[href*="/status/"]')
              ).map((a) => a.getAttribute("href") || "");
              return !links.some((h) => h.includes(cursor));
            },
            lastCursorId,
            { timeout: 20000 }
          );
        } catch {
          // network slow / X lazy-load — safe to ignore
        }
      }
    }

    // 6️⃣ Sort oldest → newest
    posts.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    logger.info(
      { username, total: posts.length },
      "[X ALL] reached absolute end of timeline"
    );

    return posts;
  } finally {
    await close();
  }
}
