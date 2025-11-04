import { newPage } from './utils/puppeteer.ts';
import { SelectorNotFoundError } from './errors.ts';
import { normalizePhone, humanClick, delay } from './utils/utils.ts';

type WaitUntilOpt = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

async function clickCardAndNavigate(
  page: import('puppeteer').Page,
  cardSelector: string,
  { navigate = true, waitUntil = 'domcontentloaded' as WaitUntilOpt } = {}
) {
  // дождёмся появления карточки
  await page.waitForSelector(cardSelector, { timeout: 3_000 })
    .catch(() => { throw new SelectorNotFoundError('site', cardSelector, 'list'); });

  const card = await page.$(cardSelector);
  if (!card) throw new SelectorNotFoundError('site', cardSelector, 'list');

  // проскроллим к карточке (иногда вне вьюпорта клики игнорируются)
  await card.evaluate(el => { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {} });

  // найдём кликабельную ссылку внутри карточки (первую <a href>)
  var link = await card.$('a[href]');

  if (!link) {
    const isSelfLink = await card.evaluate(el => el.matches?.('a[href]') ?? false);
    if (isSelfLink) {
      link = card as any; // безопасно: card — это и есть <a>
    } else {
      console.log('[NAV] no <a[href]> inside card and card is not <a>');
    }
  }
  const href = await (link
    ? page.evaluate((a: HTMLAnchorElement) => a.href || a.getAttribute('href') || '', link)
    : page.evaluate((el: Element) => (el.querySelector('a[href]') as HTMLAnchorElement | null)?.href || '', card)
  );

  if (navigate) {
    // пробуем кликнуть по ссылке и дождаться навигации
    if (link) {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil, timeout: 3_000 }),
        link.click({ delay: 30 }),
      ]);
    } else {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil, timeout: 3_000 }),
        card.click({ delay: 30 }),
      ]);
    }

    // если навигации не случилось (SPA/ощибка), но href есть — уйдём напрямую
    if (href && page.url().includes('list')) {
      await page.goto(href, { waitUntil }).catch(() => {});
    }
  } else {
    // без ожидания навигации — просто клик
    if (link) await link.click({ delay: 30 }); else await card.click({ delay: 30 });
  }

  if (link && link !== card) await link.dispose();
  await card.dispose();
}

export async function checkTopByPhone(
  site: MonitorSite & {
    adClick?: { navigate?: boolean; waitUntil?: WaitUntilOpt };
    showPhoneSelector?: string;
    showPhoneNavigates?: boolean;
  },
  myPhones: Set<string>
): Promise<{ ok: boolean; foundPhone?: string }> {
  const page = await newPage(site.id);
  try {
    page.setDefaultTimeout(20_000);

    // 1) список
    await page.goto(site.listUrl, { waitUntil: 'networkidle2' }).catch(() => {});
    await page.waitForNetworkIdle?.({ idleTime: 800, timeout: 5_000 }).catch(() => {});

    // 2) клик по ПЕРВОЙ карточке (div) → по её внутренней <a>, если есть

    if (site.adLinkSelector)
    {
      await clickCardAndNavigate(page, site.adLinkSelector, {
        navigate: site.adClick?.navigate ?? true,
        waitUntil: site.adClick?.waitUntil ?? 'domcontentloaded',
      });
    }

    // 3) «Показать телефоны» (если есть)
    if (site.showPhoneSelector) 
    {
      const btn = await page.$(site.showPhoneSelector);
      if (btn) {

      await btn.evaluate(el => {
        el.querySelectorAll('.noClickEvent').forEach(n => n.classList.remove('noClickEvent'));
      });
      await btn.evaluate(el => el.scrollIntoView({block:'center', inline:'center'}));

        const navP = site.showPhoneNavigates
          ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3_000 }).catch(() => null)
          : Promise.resolve(null);

        await btn.hover();
        //await btn.click({ delay: 30 }).catch(() => {});
        //await humanClick(page, btn, { edgeBias: 0.18, pressMs: 80, jitter: 1.5 });

        await humanClick(page, btn, {
          dialogSelectors: site.phoneDialogSelectors,
          afterMouseTimeoutMs: 5000,  // сколько ждать после mouseUp
          resultTimeoutMs: 1500,
          debug: true,
        });

        await navP;
      } else {
        await page.waitForSelector(site.showPhoneSelector, { timeout: 5_000 }).then(async () => {
          const b2 = await page.$(site.showPhoneSelector);
          if (b2) {
            const navP2 = site.showPhoneNavigates
              ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2_000 }).catch(() => null)
              : Promise.resolve(null);
            await b2.click({ delay: 30 }).catch(() => {});
            await navP2;
          }
        }).catch(() => {});
      }
    }

    // 4) телефоны на странице
    let phoneTexts: string[] = [];
    let htmlList: string[] = [];

    if (site.phoneSelector.includes('__INITIAL_STATE__')) {
      // Достаём сырой текст __INITIAL_STATE__ (JSON-строка)
      const stateText = await page.evaluate(() => {
        try {
          const st = (window as any).__INITIAL_STATE__;
          if (st) return JSON.stringify(st);
        } catch {}

        // Фолбэк: ищем инлайн-скрипт и выдёргиваем JSON между '=' и ';'
        const scripts = Array.from(document.querySelectorAll('script:not([src])')) as HTMLScriptElement[];
        for (const s of scripts) {
          const txt = s.textContent || '';
          let m = txt.match(/window\.__INITIAL_STATE__=(.*?);\(function\(\)\{/s);
          if (!m) m = txt.match(/window\.__INITIAL_STATE__=(.*?);/s);
          if (m && m[1]) return m[1].trim();
        }
        return null;
      });

      if (!stateText) {
        console.error(`Site-id: ${site.id} unable to extract __INITIAL_STATE__`);
        throw new SelectorNotFoundError(site.id, site.phoneSelector, 'phone');
      }

      // ✅ Как просил: phoneTexts = [текст __INITIAL_STATE__]
      phoneTexts = [stateText];
      htmlList = [`<script>window.__INITIAL_STATE__=${stateText}</script>`];

    } else {
      await page.waitForSelector(site.phoneSelector, { timeout: 2_000 })
        .catch(() => { 
          console.error(`Site-id: ${site.id} unable to find show phones by selector: ${site.phoneSelector}`);
          throw new SelectorNotFoundError(site.id, site.phoneSelector, 'phone'); 
        });

      phoneTexts = await page.$$eval(
        site.phoneSelector,
        els => els.map(el => (el.textContent || (el as HTMLElement).innerText || '').trim()).filter(Boolean)
      ).catch(() => []);

      htmlList = await page.$$eval(
        site.phoneSelector,
        els => els.map(el => (el as HTMLElement).outerHTML)
      ).catch(() => [] as string[]);

      if (!phoneTexts.length) {
        console.error(`Site-id: ${site.id} unable to find phones`);
        throw new SelectorNotFoundError(site.id, site.phoneSelector, 'phone');
      }
    }

    // Дальше твоя логика сопоставления
    const extracted = phoneTexts.map(normalizePhone).filter(Boolean);
    const myDigits = Array.from(myPhones).map(normalizePhone).filter(Boolean);

    let matched: string | undefined;
    outer: for (const got of extracted) {
      for (const mine of myDigits) {
        if (got && mine && (got.includes(mine) || mine.includes(got))) {
          matched = mine; break outer;
        }
      }
    }

    return matched
      ? { ok: true, foundPhone: matched }
      : { ok: false, foundPhone: extracted[0] };


  } finally {
    await page.close().catch(() => {});
  }
}