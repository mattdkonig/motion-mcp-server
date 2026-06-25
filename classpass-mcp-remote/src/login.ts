#!/usr/bin/env node
import { ClassPassBrowser } from "./browser.js";

const LOGIN_URL = "https://classpass.com/login";
const CREDITS_URL = "https://classpass.com/account/credits";
const STORAGE_STATE_PATH = process.env.CLASSPASS_STORAGE_STATE || "./data/state.json";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function isLoginUrl(url: string): boolean {
  try {
    return /\/login(?:[/?#]|$)/.test(new URL(url).pathname);
  } catch {
    return url.includes("/login");
  }
}

async function main(): Promise<void> {
  const browser = new ClassPassBrowser();
  await browser.initialize({ storageStatePath: STORAGE_STATE_PATH, headful: true });
  const page = await browser.getPage();

  try {
    await browser.navigate(LOGIN_URL);
    console.log("");
    console.log("ClassPass manual login");
    console.log("======================");
    console.log("A Chromium window has opened at https://classpass.com/login.");
    console.log("Log in manually in that window and solve any Cloudflare challenge if shown.");
    console.log(`When login is detected, this script will save the session to ${STORAGE_STATE_PATH}.`);
    console.log("");

    if (process.env.LOGIN_SMOKE_EXIT_AFTER_START === "1") {
      console.log("Smoke check reached the manual-login wait loop; exiting before human login.");
      return;
    }

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(POLL_INTERVAL_MS);

      if (isLoginUrl(page.url())) {
        console.log("Still waiting for manual login...");
        continue;
      }

      await page.goto(CREDITS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      if (!isLoginUrl(page.url())) {
        await browser.saveStorageState(STORAGE_STATE_PATH);
        console.log(`Saved authenticated ClassPass session to ${STORAGE_STATE_PATH}.`);
        return;
      }

      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      console.log("ClassPass still requires login; continue in the browser window.");
    }

    throw new Error("Timed out waiting for manual ClassPass login.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
