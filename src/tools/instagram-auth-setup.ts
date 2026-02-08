import { chromium } from "playwright";
import fs from "fs";

const STATE_DIR = "./storage";
const STATE_PATH = `${STATE_DIR}/instagram_state.json`;

(async () => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });

  console.log("➡️ Instagram pe login karo, phir terminal me ENTER press karo");

  process.stdin.resume();
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: STATE_PATH });
  await browser.close();

  console.log("✅ storage/instagram_state.json saved");
})();
