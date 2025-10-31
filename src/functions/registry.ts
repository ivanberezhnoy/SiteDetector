import type { Page } from 'puppeteer';
import type { BumpSite } from '../types.ts';
import { SelectorNotFoundError } from '../errors.ts';
import { delay, pathOf, safeCount } from '../utils/utils.ts';

export type BumpFn = (page: Page, site: BumpSite, url: string) => Promise<number>;
export type BumpFunction = (site: BumpSite, page: any, selector: string, index: number) => Promise<number>;

// ---- helpers ----
/**
 * Ждём навигацию, если она будет (иначе просто короткая пауза).
 * Потом дополнительно ждём стабилизацию DOM:
 *  - пока селекторы снова не появятся (count > 0), ИЛИ
 *  - пока count не станет отличаться от prevCount,
 * что наступит раньше. Возвращаем актуальный count.
 */
async function waitAfterClickAndCount(
  page: any,
  selector: string,
  prevCount: number,
  expectedUrl: string,
  {
    navTimeout = 1200,
    minPause = 120,
    settleTimeout = 1500,
    pollInterval = 60,
  } = {}
): Promise<{ count: number; restored: boolean }> {
  // 1) ждём либо смену URL (без домена), либо короткую паузу
  const beforePath = pathOf(page.url());
  await Promise.race([
    page
      .waitForFunction(
        prev => `${location.pathname}${location.search}${location.hash}` !== prev,
        { timeout: navTimeout },
        beforePath
      )
      .catch(() => null),
    delay(minPause),
  ]);

  // 2) если "сбило" на другой путь — быстро вернёмся на нужный
  const currentPath = pathOf(page.url());
  const expectedPath = pathOf(expectedUrl);
  let restored = false;
  if (expectedPath !== "" && currentPath !== expectedPath) 
  {
    await page
      .goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout })
      .catch(() => {});
    restored = true;
  }

  // 3) ждём ИЗМЕНЕНИЕ числа кнопок (или просадку в 0)
  await page
    .waitForFunction(
      (sel, prev) => {
        const n = document.querySelectorAll(sel).length;
        return n === 0 || n !== prev;
      },
      { timeout: settleTimeout, polling: pollInterval },
      selector,
      prevCount
    )
    .catch(() => null);

  // 4) окончательный подсчёт
  const cnt = await safeCount(page, selector);
  return { count: cnt, restored };
}

async function clickNth(site: BumpSite, page: any, selector: string, index: number) 
{
	try {
	  if (site.bumpFunction)
      {
	      const fn = registry[site.bumpFunction];
	      if (!fn) 
	      {
	        throw new Error(`bumpFunction '${site.function}' not found in registry`);
	      }

	      return await fn(site, page, selector, index);
  	  }
  	  else
  	  {
	  return await page.$$eval(
	    selector,
	    (els, i) => {
	      const el = els[i as number] as HTMLElement | undefined;
	      if (!el) return false;
	      el.scrollIntoView({ block: 'center' });
	      (el as HTMLElement).click();
	      return true;
	    },
	    index
	  );
	  }
	} catch (e: any) {
	  const msg = String(e?.message || e);
	  if (/Execution context was destroyed|Cannot find context|Target closed/i.test(msg)) {
	    // навигация началась — считаем, что клик мы отдали
	    return true;
	  }
	  throw e;
	}
}

// ---- main ----
export const registry: Record<string, BumpFn> = {
  bumpProcess: async (page, site, url) => {
    const selector =
      site.bumpSelector ??
      'a[onclick*="UpdateModifiedDate"], button.bump, a.bump';

	const currentPath = pathOf(page.url());
	const expectedPath = pathOf(url);
	if (expectedPath !== "" && currentPath !== expectedPath) {
	  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
	}

    let prevCount = await safeCount(page, selector);
    if (!prevCount) {
      throw new SelectorNotFoundError(site.id, selector, 'bump');
    }

    let clicked = 0;
    let idx = 0;

    // fail-safe от странных DOM-циклов
    const maxIterations = prevCount + 2;;
    let iter = 0;

    while (prevCount > 0 && iter < maxIterations) {
      iter++;

	  const cur = pathOf(page.url());
	  const exp = pathOf(url);
		if (exp !== "" && cur !== exp) {
		  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
		  const curCount = await safeCount(page, selector);
		  if (curCount === 0) break;

		  // если текущий индекс уже вне диапазона новой страницы — всё, больше жать нечего
		  if (idx >= curCount) {
		    prevCount = curCount;
		    break;
		  }

		  prevCount = curCount;
		}

      if (idx >= prevCount) break; // дошли до конца текущего списка

      try {
        const ok = await clickNth(site, page, selector, idx);
        if (!ok) {
          // элемент по индексу не нашли — сдвигаемся дальше
          idx++;
          continue;
        }
        clicked++;

        // ждём навигацию (если была) + стабилизацию/возврат кнопок
		const { count: newCount, restored } = await waitAfterClickAndCount(
		  page,
		  selector,
		  prevCount,
		  url,
		  { navTimeout: 1200, minPause: 600, settleTimeout: 2000, pollInterval: 200 }
		);

		if (newCount <= 0) {
		  prevCount = 0;
		  break;
		}

		const decreased = newCount < prevCount;

		if (decreased) 
		{
		  idx = 0;
		} else {
		  idx++;
		}

		// зажимаем индекс в пределах нового количества
		if (idx >= newCount) break;

		prevCount = newCount;

      } catch (err) {
        console.error(`[${site.id}] bump click error (idx=${idx}):`, err);
        await delay(500);
        idx++;
      }
    }

    return clicked;
  },

bumpFunction: async (site, page, selector, index) => {
  // 1) клик по ссылке и получение id селекта
  const labelId = await page.$$eval(
    selector,
    (els, i) => {
      const a = els[i] as HTMLAnchorElement | undefined;
      if (!a) return null;

      // вытащим id из data-toggle или класса
      const dt = a.getAttribute('data-toggle') || '';
      let m = dt.match(/#label_(\d+)/);
      let id = m?.[1];
      if (!id) {
        m = (a.className || '').match(/current_label_(\d+)/);
        if (m) id = m[1];
      }
      if (!id) return null;

      // кликнуть надёжно, даже если display:none (некоторые либы слушают именно события)
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      return `label_${id}`;
    },
    index
  );

  if (!labelId) {
    console.warn('bumpFunction: label id not found for index', index);
    return false;
  }

  const sel = `#${labelId.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')}`;

  // 2) ждём появления/инициализации селекта
  await page.waitForSelector(sel, { visible: true, timeout: 2000 }).catch(() => {});

  // 3) выбрать по видимому тексту (регистронезависимо) и сгенерировать change
  const pickByText = async (text: string) => {
    return page.$eval(
      sel,
      (select, txt) => {
        const s = select as HTMLSelectElement;
        const t = String(txt).trim().toLowerCase();
        let found = false;
        for (const o of Array.from(s.options)) {
          const label = (o.textContent || '').trim().toLowerCase();
          if (label === t) {
            s.value = o.value ?? '';
            s.dispatchEvent(new Event('change', { bubbles: true }));
            found = true;
            break;
          }
        }
        return found;
      },
      text
    ).catch(() => false);
  };

  // 4) сначала "нет", затем "Свободно"
  await pickByText('нет');
  await delay(80);
  await pickByText('Свободно');

  if (site.bumpSleepSec)
  {
  	await delay(site.bumpSleepSec * 1000);
  }

  return true;
}


};
