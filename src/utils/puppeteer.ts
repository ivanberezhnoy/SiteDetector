// puppeteer.ts
import fs from "node:fs";
import path from "node:path";
import puppeteer, { Browser, BrowserContext, Page } from "puppeteer";

/**
 * Мы поддерживаем несколько независимых браузеров (окон) — по ключу siteID.
 * У каждого свой user-data-dir, чтобы Chrome не ругался на lock и профили не конфликтовали.
 */

type BrowserRecord = {
  browser: Browser | null;
  launchPromise: Promise<Browser> | null;
  userDataDir: string;
};

const pool = new Map<string, BrowserRecord>();
const BASE_PROFILE_DIR = path.resolve("./.chrome-profile");

function isAlive(b: Browser | null) {
  try { return !!b && b.isConnected(); } catch { return false; }
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cleanupProfileLocks(dir: string) {
  const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  for (const f of locks) {
    const fp = path.join(dir, f);
    try { if (fs.existsSync(fp)) fs.rmSync(fp, { force: true }); } catch {}
  }
}

/**
 * Возвращает (или запускает) отдельный Chrome для указанного siteID.
 * Для каждого siteID — свой user-data-dir и свой процесс Chrome → отдельное окно.
 */
export async function getBrowser(siteID: string): Promise<Browser> {
  let rec = pool.get(siteID);
  if (!rec) {
    rec = { browser: null, launchPromise: null, userDataDir: BASE_PROFILE_DIR + `-${siteID}` };
    pool.set(siteID, rec);
  }

  if (isAlive(rec.browser)) return rec.browser!;

  if (rec.launchPromise) return rec.launchPromise;

  rec.launchPromise = (async () => {
    ensureDir(rec!.userDataDir);
    cleanupProfileLocks(rec!.userDataDir);

    const br = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      channel: "chrome",
      args: [
        `--user-data-dir=${rec!.userDataDir}`,
        "--profile-directory=Default",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        // если окружение доверенное — можно оставить:
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      dumpio: true,
    });

    br.on("disconnected", () => {
      // если окно закрылось руками — позволим перезапуститься при следующем вызове
      rec!.browser = null;
      rec!.launchPromise = null;
    });

    rec!.browser = br;
    return br;
  })();

  try {
    rec.browser = await rec.launchPromise;
    return rec.browser!;
  } catch (e) {
    rec.launchPromise = null;
    throw e;
  }
}

/**
 * Создать НОВОЕ ОКНО (Incognito-контекст в headful Chrome — отдельное окно).
 * Если хотите именно вкладку в текущем окне — используйте newTab(siteID).
 */
export async function newWindow(siteID: string): Promise<Page> {
  const br = await getBrowser(siteID);

  // Incognito в headful создаёт отдельное окно
  const ctx: BrowserContext = await br.createIncognitoBrowserContext();
  const page = await ctx.newPage();

  setupPageDefaults(page);
  attachPopupGuard(page);
  return page;
}

/**
 * Создать новую ВКЛАДКУ в основном окне данного siteID.
 */
export async function newPage(siteID: string): Promise<Page> {
  const br = await getBrowser(siteID);
  const page = await br.newPage();
  setupPageDefaults(page);
  attachPopupGuard(page);
  return page;
}

/**
 * Закрыть окно/браузер для конкретного siteID (и все его вкладки/контексты).
 */
export async function closeSite(siteID: string): Promise<void> {
  const rec = pool.get(siteID);
  if (!rec) return;

  if (isAlive(rec.browser)) {
    try { await rec!.browser!.close(); } catch {}
  }
  rec.browser = null;
  rec.launchPromise = null;
  // user-data-dir намеренно НЕ удаляем, чтобы профиль сохранился.
}

/**
 * Вспомогалки
 */
function setupPageDefaults(page: Page) {
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);
}

function attachPopupGuard(page: Page) {
  // Часто сайты открывают target="_blank" — перехватим и переведём в текущую вкладку.
  page.on("popup", async (popup) => {
    const url = popup.url();
    try { await popup.close({ runBeforeUnload: true }); } catch {}
    if (url && url !== "about:blank") {
      try {
        await page.bringToFront();
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch {}
    }
  });
}
