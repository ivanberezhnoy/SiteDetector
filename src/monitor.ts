import { MonitorSite } from './types.ts';
import { newPage } from './utils/puppeteer.ts';
import { normalizePhone } from './utils/normalize.ts';
import { SelectorNotFoundError } from './errors.ts';

export async function checkTopByPhone(
  site: MonitorSite,
  myPhones: Set<string>
): Promise<{ ok: boolean; foundPhone?: string }> {
  const page = await newPage();

  try {
    await page.goto(site.listUrl, { waitUntil: 'networkidle2' });

    // 1) Селектор ссылки на первое объявление
    try {
      await page.waitForSelector(site.adLinkSelector, { timeout: 20_000 });
    } catch {
      throw new SelectorNotFoundError(site.id, site.adLinkSelector, 'list');
    }

    const href = await page.$eval(
      site.adLinkSelector,
      (el) => (el as HTMLAnchorElement).getAttribute('href')
    );
    if (!href) {
      throw new SelectorNotFoundError(site.id, site.adLinkSelector, 'list');
    }

    // Переход в объявление
    const navigate = site.adClick?.navigate ?? true;
    if (navigate) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: site.adClick?.waitUntil ?? 'domcontentloaded' }),
        page.click(site.adLinkSelector),
      ]);
    } else {
      await page.click(site.adLinkSelector);
    }

    // 2) Селектор телефона
    try {
      await page.waitForSelector(site.phoneSelector, { timeout: 20_000 });
    } catch {
      throw new SelectorNotFoundError(site.id, site.phoneSelector, 'phone');
    }

    const phoneRaw = await page.$eval(
      site.phoneSelector,
      (el) => el.textContent || (el as HTMLElement).innerText || ''
    );
    const phone = normalizePhone(phoneRaw);

    return { ok: myPhones.has(phone), foundPhone: phone };
  } finally {
    // закрываем только вкладку, окно браузера остаётся
    await page.close().catch(() => {});
  }
}
