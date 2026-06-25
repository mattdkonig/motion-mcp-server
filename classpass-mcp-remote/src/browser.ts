import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, Browser, BrowserContext, Page } from "playwright";

type BrowserInitializeOptions = {
  storageStatePath?: string;
  headful?: boolean;
};

export class ClassPassBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async initialize(options: BrowserInitializeOptions = {}): Promise<void> {
    this.browser = await chromium.launch({
      headless: !options.headful,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });
    const storageState =
      options.storageStatePath && existsSync(options.storageStatePath) ? options.storageStatePath : undefined;
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      storageState,
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    this.page = await this.context.newPage();
  }

  async getPage(): Promise<Page> {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page;
  }
  async navigate(url: string): Promise<void> {
    const page = await this.getPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  async waitForSelector(selector: string, timeout = 10000): Promise<void> {
    const page = await this.getPage();
    await page.waitForSelector(selector, { timeout });
  }
  async click(selector: string): Promise<void> {
    const page = await this.getPage();
    await page.click(selector);
  }
  async fill(selector: string, value: string): Promise<void> {
    const page = await this.getPage();
    await page.fill(selector, value);
  }
  async evaluate<T>(fn: () => T): Promise<T> {
    const page = await this.getPage();
    return page.evaluate(fn as any);
  }
  async evaluateWithArg<T>(fn: (arg: any) => T, arg: any): Promise<T> {
    const page = await this.getPage();
    return page.evaluate(fn as any, arg);
  }
  async saveStorageState(path: string): Promise<void> {
    if (!this.context) throw new Error("Browser not initialized");
    mkdirSync(dirname(path), { recursive: true });
    await this.context.storageState({ path });
  }
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
