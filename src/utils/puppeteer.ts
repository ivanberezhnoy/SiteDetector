// puppeteer.ts
import fs from "node:fs";
import path from "node:path";
import puppeteer, { Browser, Page } from "puppeteer";

let browserSingleton: Browser | null = null;
// Если getBrowser() вызывают одновременно — ждём один общий launch
let launchPromise: Promise<Browser> | null = null;

const USER_DATA_DIR = path.resolve("./.chrome-profile");

function isAlive(b: Browser | null) {
  try { return !!b && b.isConnected(); } catch { return false; }
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cleanupProfileLocks(dir: string) {
  // Chrome ставит lock-файлы; удалим их перед запуском
  const locks = [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
  ];
  for (const f of locks) {
    const fp = path.join(dir, f);
    try { if (fs.existsSync(fp)) fs.rmSync(fp, { force: true }); } catch {}
  }
}

export async function getBrowser(): Promise<Browser> {
  if (isAlive(browserSingleton)) return browserSingleton!;

  if (launchPromise) return launchPromise; // уже кто-то запускает — просто ждём

  // одна-единственная попытка запуска
  launchPromise = (async () => {
    ensureDir(USER_DATA_DIR);
    cleanupProfileLocks(USER_DATA_DIR);

    const br = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      // Лучше channel:'chrome', чем жёсткий путь
      channel: "chrome",
      args: [
        `--user-data-dir=${USER_DATA_DIR}`,
        "--profile-directory=Default",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        // ниже — только если среда доверенная
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      // Полезно увидеть stderr Chrome, если снова что-то упадёт
      dumpio: true,
    });

    // Если браузер внезапно упал — обнулим singleton-и, чтобы можно было перезапустить
    br.on("disconnected", () => {
      browserSingleton = null;
      launchPromise = null;
    });

    return br;
  })();

  try {
    browserSingleton = await launchPromise;
    return browserSingleton!;
  } catch (e) {
    // если запуск не удался — очистим промис, чтобы следующая попытка смогла перезапустить
    launchPromise = null;
    throw e;
  }
}

export async function newPage(): Promise<Page> {
  const br = await getBrowser();
  const page = await br.newPage(); // новая вкладка в ОДНОМ окне
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);

  // Перехват popups: сайты любят открывать target="_blank"
  page.on("popup", async (popup) => {
    const url = popup.url();
    try { await popup.close({ runBeforeUnload: true }); } catch {}
    if (url && url !== "about:blank") {
      try { await page.bringToFront(); await page.goto(url, { waitUntil: "domcontentloaded" }); } catch {}
    }
  });

  return page;
}
