import { chromium, Browser, BrowserContext, Page } from "playwright";

export class ClassPassBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
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
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
