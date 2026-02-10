import { chromium } from "playwright";
import fs from "fs";

const STORAGE_DIR = "./storage";
const STATE_PATH = "./storage/x_state.json";

(async () => {

  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  console.log("➡️ Setting up X/Twitter session (shared for all users)");
  console.log(`   Session will be saved to: ${STATE_PATH}`);
  console.log("   This session will be used by all users of the scraper\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });

  console.log("➡️ Login manually, then press Enter");

  process.stdin.resume();
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: STATE_PATH });
  await browser.close();

  console.log(`\n✅ Session saved to: ${STATE_PATH}`);
  console.log("   This session will now be used by all users\n");
  

  try {
    const stateContent = fs.readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(stateContent) as {
      cookies?: Array<{
        name: string;
        expires?: number;
      }>;
    };

    if (state.cookies && Array.isArray(state.cookies)) {
      const importantCookies = ["auth_token", "ct0", "twid", "kdt"];
      let earliestExpiry: number | null = null;

      for (const cookie of state.cookies) {
        if (importantCookies.includes(cookie.name) && cookie.expires) {
          const expiryMs = cookie.expires * 1000;
          if (earliestExpiry === null || expiryMs < earliestExpiry) {
            earliestExpiry = expiryMs;
          }
        }
      }

      if (earliestExpiry) {
        const expiresAt = new Date(earliestExpiry);
        const expiresInMs = earliestExpiry - Date.now();
        const expiresInHours = Math.floor(expiresInMs / (1000 * 60 * 60));
        const expiresInDays = Math.floor(expiresInMs / (1000 * 60 * 60 * 24));
        
        console.log("📅 Session expiry info:");
        console.log(`   Expires at: ${expiresAt.toLocaleString()}`);
        console.log(`   Expires in: ~${expiresInDays} days (${expiresInHours} hours)`);
        console.log("\n   ⚠️  Note: If session expires, admin needs to run this setup again");
      } else {
        console.log("📅 Session expiry: No expiry found (session cookies)");
        console.log("   ⚠️  Note: Session may expire when browser closes");
        console.log("   💡 Tip: Keep browser open or re-run setup if session stops working");
      }
    }
  } catch (error) {
    console.log("⚠️  Could not check session expiry info");
  }
})();
