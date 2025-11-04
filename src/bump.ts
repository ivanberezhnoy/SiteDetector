import { BumpSite, LoginConfig } from './types.ts';
import { newPage } from './utils/puppeteer.ts';
import { registry } from './functions/registry.ts';
import { SelectorNotFoundError } from './errors.ts';
import { delay, log } from './utils/utils.ts';
import { sendSiteMessage } from './telegram.ts';
// --- helpers ---------------------------------------------------------------

async function waitVisible(
  page: Awaited<ReturnType<typeof newPage>>,
  selector: string,
  siteId: string,
  stage: 'modal' | 'username' | 'password'
) {
  try {
    await page.waitForSelector(selector, { timeout: 20_000, visible: true });
  } catch {
    throw new SelectorNotFoundError(siteId, selector, stage);
  }
}

async function safeClearAndType(
  page: Awaited<ReturnType<typeof newPage>>,
  selector: string,
  value: string
) {
  // На некоторых сайтах value проставляется маской/скриптом — сначала очистим напрямую
  await page.$eval(
    selector,
    (el, v) => {
      const input = el as HTMLInputElement;
      input.focus();
      input.value = '';
      // триггерим input/change для некоторых тулкитов
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
  // Затем печатаем с небольшим delay (чтобы не проиграть js-валидации)
  await page.type(selector, value, { delay: 20 });
}

async function waitAndType(
  page: Awaited<ReturnType<typeof newPage>>,
  selector: string,
  value: string,
  siteId: string,
  stage: 'username' | 'password'
) {
  await waitVisible(page, selector, siteId, stage);
  await safeClearAndType(page, selector, value);
}

async function clickOrThrow(
  page: Awaited<ReturnType<typeof newPage>>,
  selector: string,
  siteId: string,
  stage: 'open' | 'submit',
  navigates: boolean
) {
  // Если кликаем по элементу — убедимся, что он видим
  try {
    await page.waitForSelector(selector, { timeout: 20_000, visible: true });
  } catch {
    throw new SelectorNotFoundError(siteId, selector, stage);
  }

  if (navigates) {
    // Важно: клик и ожидание ставим в Promise.all, чтобы не пропустить быструю навигацию
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click(selector),
    ]).catch(() => {
      // Если не было навигации — это не всегда ошибка (на сайте может быть модалка)
      // Пусть дальше разберётся вызывающий код (через race с закрытием модалки)
    });
  } else {
    await page.click(selector).catch(() => {
      throw new SelectorNotFoundError(siteId, selector, stage);
    });
  }
}

async function waitModalGone(
  page: Awaited<ReturnType<typeof newPage>>,
  modalSelector: string
) {
  // modal скрылась / удалена из DOM
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return !el || el.offsetParent === null;
    },
    { timeout: 15_000 },
    modalSelector
  );
}

// --- login flow ------------------------------------------------------------

async function elementExists(page: Awaited<ReturnType<typeof newPage>>, selector?: string) {
  if (!selector) return false;
  try {
    return !!(await page.$(selector));
  } catch {
    return false;
  }
}

async function doLogin(
  page: Awaited<ReturnType<typeof newPage>>,
  login: LoginConfig,
  siteId: string
) {
  await delay(1000);
  await page.goto(login.url, { waitUntil: 'networkidle2' });

  // 0) Если нужна кнопка "Войти" — кликнем её, но не будем падать, если её нет (уже залогинен)
  if (login.openSelector) {
    if (await elementExists(page, login.openSelector)) {
      await clickOrThrow(page, login.openSelector, siteId, 'open', !!login.openClickNavigates);
      if (!login.openClickNavigates) {
        await waitVisible(page, '#box-signin', siteId, 'modal').catch(() => {});
      }
    } else {
      log(`[${siteId}] openSelector not found — возможно, уже залогинен`);
    }
  }

  // 1) Если поля логина/пароля отсутствуют — считаем, что уже авторизованы
  const hasUser = await elementExists(page, login.usernameSelector);
  const hasPass = await elementExists(page, login.passwordSelector);
  if (!hasUser || !hasPass) {
    log(`[${siteId}] no username/password fields — assume already logged in`);
    return;
  }

  // 2) Вводим логин/пароль и сабмитим
  await waitAndType(page, login.usernameSelector, login.username, siteId, 'username');
  await waitAndType(page, login.passwordSelector, login.password, siteId, 'password');

  if (login.submitSelector) {
    await Promise.race([
      (async () => {
        await clickOrThrow(page, login.submitSelector!, siteId, 'submit', true);
      })(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => null),
      waitModalGone(page, '#box-signin').catch(() => null),
    ]);
  } else {
    log('Press enter');
    await Promise.race([
      (async () => { await page.keyboard.press('Enter'); })(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => null),
      waitModalGone(page, '#box-signin').catch(() => null),
    ]);
  }
}


// --- public API ------------------------------------------------------------

function isSelectorUrl(u: string): boolean {
  return u.startsWith('selector:');
}

async function clickSelectorAndWait(page: import('puppeteer').Page, selector: string) {
  const css = selector.slice('selector:'.length).trim();
  // ждём элемент и скроллим к нему
  const el = await page.waitForSelector(css, { visible: true, timeout: 3_000 });
  if (!el) throw new Error(`Selector not found: ${css}`);

  await el.evaluate(e => {
    try { e.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch {}
  });

  const hrefBefore = page.url();

  // кликаем и ждём возможную навигацию/загрузку
  const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 3_000 }).catch(() => null);

  await el.click({ delay: 50 });

  const nav = await navPromise;

  // если SPA и полноценной навигации не было — подождём смену URL или хоть какую-то сетевую тишину
  if (!nav) {
    await page.waitForFunction(prev => location.href !== prev, { timeout: 2_000 }, hrefBefore).catch(() => null);
    // небольшой запас
    await delay(1000);
  }
}


export async function runBump(site: BumpSite): Promise<void> {
  const page = await newPage(site.id);
  var clicked = 0;
  try {
    await doLogin(page, site.login, site.id);

    for (const myUrl of site.myAdsUrls) {
      await delay(2000);

      let passUrl = myUrl;

      if (isSelectorUrl(myUrl)) 
      {
        await clickSelectorAndWait(page, myUrl);
        passUrl = ""; // в fn пойдёт пустой url, как ты и хотел
      } else {
        await page.goto(myUrl, { waitUntil: 'networkidle2' });
      }

      const fn = registry[site.function];
      if (!fn) {
        throw new Error(`Function '${site.function}' not found in registry`);
      }

      // передаём пустую строку, если это был переход по селектору
      clicked = clicked + await fn(page, site, passUrl);
    }

    await delay(800);
  
    if (clicked > 0) 
    {
      await sendSiteMessage(site.id, "bump", `🔁 ${site.id}: обновлено ${clicked} объявлений.`);
    } else 
    {
      await sendSiteMessage(site.id, "bump", `⚠️ ${site.id}: ни одной кнопки не удалось нажать.`);
    }

  } 
  finally 
  {
    await page.close().catch(() => {});
  }
}
