import puppeteer, { Browser, Page } from 'puppeteer';

// ⬇️ Глобальная (для модуля) ссылка на один запущенный браузер
let browserSingleton: Browser | null = null;

function isAlive(b: Browser | null) {
  try {
    return !!b && b.isConnected();
  } catch {
    return false;
  }
}

export async function getBrowser(): Promise<Browser> {
  if (isAlive(browserSingleton)) return browserSingleton as Browser;

  browserSingleton = await puppeteer.launch({
    headless: false,           // показываем окно
    defaultViewport: null,     // полноразмерное окно
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ],
  });

  return browserSingleton;
}

export async function newPage(): Promise<Page> {
  const br = await getBrowser();
  const page = await br.newPage();  // если хотите инкогнито → создайте контекст и newPage() в нём
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);
  return page;
}
