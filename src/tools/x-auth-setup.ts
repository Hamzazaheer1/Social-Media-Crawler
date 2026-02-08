import { chromium } from "playwright";
import fs from "fs";

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });

  console.log("➡️ Login manually, then enter press");

  process.stdin.resume();
  await new Promise<void>((res) => process.stdin.once("data", () => res()));

  await context.storageState({ path: "./storage/x_state.json" });
  await browser.close();

  console.log("✅ storage/x_state.json saved");
})();
