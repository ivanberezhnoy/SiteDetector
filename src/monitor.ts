import { newPage } from './utils/puppeteer.ts';
import { SelectorNotFoundError } from './errors.ts';
import { normalizePhone } from './utils/utils.ts';

type WaitUntilOpt = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

async function clickCardAndNavigate(
  page: import('puppeteer').Page,
  cardSelector: string,
  { navigate = true, waitUntil = 'domcontentloaded' as WaitUntilOpt } = {}
) {
  // дождёмся появления карточки
  await page.waitForSelector(cardSelector, { timeout: 15_000 })
    .catch(() => { throw new SelectorNotFoundError('site', cardSelector, 'list'); });

  const card = await page.$(cardSelector);
  if (!card) throw new SelectorNotFoundError('site', cardSelector, 'list');

  // проскроллим к карточке (иногда вне вьюпорта клики игнорируются)
  await card.evaluate(el => { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {} });

  // найдём кликабельную ссылку внутри карточки (первую <a href>)
  const link = await card.$('a[href]');
  const href = await (link
    ? page.evaluate((a: HTMLAnchorElement) => a.href || a.getAttribute('href') || '', link)
    : page.evaluate((el: Element) => (el.querySelector('a[href]') as HTMLAnchorElement | null)?.href || '', card)
  );

  if (navigate) {
    // пробуем кликнуть по ссылке и дождаться навигации
    if (link) {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil, timeout: 15_000 }),
        link.click({ delay: 30 }),
      ]);
    } else {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil, timeout: 15_000 }),
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

  await link?.dispose();
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
  const page = await newPage();
  try {
    page.setDefaultTimeout(20_000);

    // 1) список
    await page.goto(site.listUrl, { waitUntil: 'networkidle2' }).catch(() => {});
    await page.waitForNetworkIdle?.({ idleTime: 800, timeout: 5_000 }).catch(() => {});

    // 2) клик по ПЕРВОЙ карточке (div) → по её внутренней <a>, если есть
    await clickCardAndNavigate(page, site.adLinkSelector, {
      navigate: site.adClick?.navigate ?? true,
      waitUntil: site.adClick?.waitUntil ?? 'domcontentloaded',
    });

    // 3) «Показать телефоны» (если есть)
    if (site.showPhoneSelector) {
      const btn = await page.$(site.showPhoneSelector);
      if (btn) {
        const navP = site.showPhoneNavigates
          ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => null)
          : Promise.resolve(null);
        await btn.click({ delay: 30 }).catch(() => {});
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
    await page.waitForSelector(site.phoneSelector, { timeout: 2_000 })
      .catch(() => 
      { 
      	//console.error(`Site-id: ${site.id} unable to find show phones`);
      	//throw new SelectorNotFoundError(site.id, site.phoneSelector, 'phone'); 
      });

    const phoneTexts: string[] = await page.$$eval(
      site.phoneSelector,
      els => els.map(el => (el.textContent || (el as HTMLElement).innerText || '').trim()).filter(Boolean)
    ).catch(() => []);

    if (!phoneTexts.length) 
    {
      console.error(`Site-id: ${site.id} unable to find phones`);
      throw new SelectorNotFoundError(site.id, site.phoneSelector, 'phone');
    }

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