import { BumpSite, LoginConfig } from './types.ts';
import { newPage } from './utils/puppeteer.ts';
import { registry } from './functions/registry.ts';
import { SelectorNotFoundError } from './errors.ts';
import { delay, log } from './utils/utils.ts';
import { sendMessage } from './telegram.ts';
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

async function doLogin(
  page: Awaited<ReturnType<typeof newPage>>,
  login: LoginConfig,
  siteId: string
) {
  await page.goto(login.url, { waitUntil: 'networkidle2' });

  // 1) Открыть форму логина (модалка или переход)
  if (login.openSelector) {
    await clickOrThrow(page, login.openSelector, siteId, 'open', !!login.openClickNavigates);
    // если это модалка — дождёмся формы
    if (!login.openClickNavigates) {
      // House24: модалка #box-signin
      await waitVisible(page, '#box-signin', siteId, 'modal');
    }
  }

  // 2) Поля логина/пароля (Жёстко ждём появления)
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
    // Запасной вариант — Enter
    log('Press enter')
    await Promise.race([
      (async () => {
        await page.keyboard.press('Enter');
      })(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => null),
      waitModalGone(page, '#box-signin').catch(() => null),
    ]);
  }
}

// --- public API ------------------------------------------------------------

export async function runBump(site: BumpSite): Promise<void> {
  const page = await newPage();
  var clicked = 0;
  try {
    await doLogin(page, site.login, site.id);

    for (const myUrl of site.myAdsUrls)
    {
      await delay(2000);
      await page.goto(myUrl, { waitUntil: 'networkidle2' });
      

      const fn = registry[site.function];
      if (!fn) {
        throw new Error(`Function '${site.function}' not found in registry`);
      }
      clicked = clicked + await fn(page, site, myUrl);
    }

    await delay(1200);
  
    if (clicked > 0) 
    {
      await sendMessage(`🔁 ${site.id}: обновлено ${clicked} объявлений.`);
    } else 
    {
      await sendMessage(`⚠️ ${site.id}: ни одной кнопки не удалось нажать.`);
    }

  } 
  finally 
  {
    await page.close().catch(() => {});
  }
}
