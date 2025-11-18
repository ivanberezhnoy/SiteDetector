// puppeteer.ts
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { Browser, BrowserContext, Page } from "puppeteer";

interface BrowserRecord {
  browser: Browser | null;
  launchPromise: Promise<Browser> | null;
  userDataDir: string;
}

const pool = new Map<string, BrowserRecord>();
const BASE_PROFILE_DIR = path.resolve("./.chrome-profile");

function isAlive(br: Browser | null | undefined): br is Browser {
  return !!br && !br.process()?.killed;
}

function ensureDir(dir: string) {
  // твоя реализация
}

function cleanupProfileLocks(dir: string) {
  // твоя реализация
}

function setupPageDefaults(page: Page) {
  // твоя реализация
}

function attachPopupGuard(page: Page) {
  // твоя реализация
}

/**
 * Обычный (постоянный) браузер, как и раньше.
 * Профиль не удаляется.
 */
export async function getBrowser(siteID: string): Promise<Browser> {
  let rec = pool.get(siteID);
  if (!rec) {
    rec = {
      browser: null,
      launchPromise: null,
      userDataDir: BASE_PROFILE_DIR + `-${siteID}`,
    };
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
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      //dumpio: true,
    });

    br.on("disconnected", () => {
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
 * Вспомогательная функция: одноразовый браузер с временным userDataDir,
 * который удаляется после закрытия браузера.
 */
async function launchEphemeralBrowser(siteID: string): Promise<Browser> {
  const tmpDir = await fs.mkdtemp(
    path.join(BASE_PROFILE_DIR, `-tmp-${siteID}-`),
  );

  // если нужно – можно тоже чистить локи
  cleanupProfileLocks(tmpDir);

  const br = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    channel: "chrome",
    args: [
      `--user-data-dir=${tmpDir}`,
      "--profile-directory=Default",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    dumpio: true,
  });

  br.on("disconnected", () => {
    // после закрытия браузера – сносим профиль
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  });

  return br;
}

/**
 * Создать НОВОЕ ОКНО (Incognito-контекст в headful Chrome — отдельное окно).
 * Использует ПЕРСИСТЕНТНЫЙ браузер/профиль.
 */
export async function newWindow(siteID: string): Promise<Page> {
  const br = await getBrowser(siteID);
  const ctx: BrowserContext = await br.createIncognitoBrowserContext();
  const page = await ctx.newPage();

  setupPageDefaults(page);
  attachPopupGuard(page);
  return page;
}

export interface NewPageOptions {
  /** Если true — страница будет в отдельном одноразовом браузере с чистым профилем */
  freshProfile?: boolean;
}

/**
 * Создать новую ВКЛАДКУ.
 * По умолчанию — в основном (персистентном) окне данного siteID.
 * Если freshProfile = true — создаётся ОТДЕЛЬНЫЙ браузер/окно с новым userDataDir,
 * который будет удалён после закрытия вкладки.
 */
export async function newPage(
  siteID: string,
  options?: NewPageOptions,
): Promise<Page> {
  const fresh = options?.freshProfile;

  if (!fresh) {
    // старое поведение
    const br = await getBrowser(siteID);
    const page = await br.newPage();
    setupPageDefaults(page);
    attachPopupGuard(page);
    return page;
  }

  // --------- ЭФЕМЕРНЫЙ ПРОФИЛЬ ---------
  const br = await launchEphemeralBrowser(siteID);
  const page = await br.newPage();

  setupPageDefaults(page);
  attachPopupGuard(page);

  // Хак: при закрытии вкладки закрываем и браузер
  const origClose = page.close.bind(page);
  page.close = (async (...args: any[]) => {
    try {
      await origClose(...args);
    } finally {
      try {
        await br.close();
      } catch {
        // браузер уже мог быть закрыт
      }
    }
  }) as any;

  return page;
}

/**
 * Закрыть окно/браузер для конкретного siteID (и все его вкладки/контексты).
 * Это относится только к ПЕРСИСТЕНТНОМУ браузеру из пула.
 * Эфемерные браузеры сами закрываются при закрытии вкладки.
 */
export async function closeSite(siteID: string): Promise<void> {
  const rec = pool.get(siteID);
  if (!rec) return;

  if (isAlive(rec.browser)) {
    try {
      await rec.browser!.close();
    } catch {
      /* ignore */
    }
  }
  rec.browser = null;
  rec.launchPromise = null;
  // user-data-dir намеренно НЕ удаляем, чтобы профиль сохранился.
}