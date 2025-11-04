// src/utils/utils.ts

import type { Page, ElementHandle, Frame } from 'puppeteer';

/**
 * Проста́я функция задержки (асинхронная "пауза").
 * Пример:
 *   await delay(1000); // подождать 1 секунду
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Безопасное ожидание случайной паузы в диапазоне [min, max] миллисекунд.
 * Удобно для имитации "человеческих" действий.
 * Пример:
 *   await randomDelay(500, 1200);
 */
export async function randomDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  await delay(ms);
}

/**
 * Простой логгер с временной меткой — чтобы видеть в консоли, что происходит.
 * Пример:
 *   log('Открываю страницу входа');
 */
export function log(message: string): void {
  const ts = new Date().toISOString().substring(11, 19); // HH:MM:SS
  console.log(`[${ts}] ${message}`);
}


export async function waitMaybeNavigation(pageOrFrame, {
  timeout = 5000,
  waitUntil = 'networkidle0',  // можно 'load' или 'domcontentloaded'
  fallbackDelay = 800,         // пауза если навигации не было
  jitter = 500                 // случайная прибавка к паузе
} = {}) {
  // Подписываемся ДО клика, чтобы не пропустить быструю навигацию
  const navPromise = pageOrFrame
    .waitForNavigation({ timeout, waitUntil })
    .then(() => true)
    .catch(() => false); // timeout → считаем, что навигации не было

  // Ждём либо навигацию, либо просто подождём
  const result = await Promise.race([
    navPromise,
    delay(fallbackDelay + Math.random() * jitter)
  ]);

  // Если навигация действительно была, убедимся что страница стабилизировалась
  if (result === true) {
    // опционально можно чуть подождать сети/рендера
    await delay(200);
    return 'navigated';
  }
  return 'no-nav';
}

export const pathOf = (href: string) => {
  try {
    const u = new URL(href, 'http://dummy'); // base на случай относительных
    let path = `${u.pathname}${u.search}${u.hash}`;

    // удаляем завершающий /, если это не корень
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path;
  } catch {
    return href;
  }
};

export async function safeCount(page: any, selector: string, attempts = 3): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.$$eval(selector, els => els.length);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/Execution context was destroyed|Cannot find context|Target closed/i.test(msg)) {
        // краткая пауза и ещё одна попытка — контекст мог перезагружаться
        await delay(100 + i * 100);
        continue;
      }
      throw e;
    }
  }
  // последняя попытка
  return await page.$$eval(selector, els => els.length).catch(() => 0);
}

// utils/phone.ts
/**
 * Приводит телефон к «цифровому» виду:
 *  - убирает все нецифровые символы
 *  - удаляет ведущие 00 / 380 / 80, если нужно
 *  - возвращает строку из цифр
 */
export function normalizePhone(raw: string | undefined | null): string {
  if (!raw) return "";

  // убираем пробелы, скобки, дефисы, плюсы и всё нецифровое
  let digits = raw.replace(/\D+/g, "");

  // если начинается с 00 (международный формат) → убираем 00
  if (digits.startsWith("00")) digits = digits.slice(2);

  // украинские кейсы: 380ХХ... или 80ХХ...
  if (digits.startsWith("380")) digits = digits.slice(2); // → остаётся 0ХХ...
  else if (digits.startsWith("80")) digits = "0" + digits.slice(2);

  return digits;
}


// humanClick.ts
import type { Page, ElementHandle } from 'puppeteer';

export enum ClickType {
  MouseDownUp = 'mouseDownUp',
  ElementClick = 'elementClick',
  JsClick = 'jsClick',
  KeyboardEnter = 'keyboardEnter',
  EdgeMouseDownUp = 'edgeMouseDownUp',
}

export type HumanClickOpts = {
  // прицельный тип клика; если одновременно заданы dialogSelectors — будет игнорироваться
  // и переберём все типы по очереди, пока не появится модалка
  clickType?: ClickType;

  // клик-параметры
  edgeBias?: number;              // смещение от центра к левому краю (0..0.5), по умолч. 0.18
  pressMs?: number;               // удержание кнопки мыши, мс (по умолч. 80)
  jitter?: number;                // дрожание курсора, px (по умолч. 1.5)
  removeNoClickEvent?: boolean;   // удалить .noClickEvent у потомков (по умолч. true)

  // ожидание результата
  resultTimeoutMs?: number;       // базовый таймаут ожидания после остальных кликов (по умолчанию 1200)
  dialogSelectors?: string[];     // селекторы модалки (любого достаточно)
  waitTextRevealed?: boolean;     // альтернативный критерий — исчез X, появились цифры в самом элементе

  // отладка
  debug?: boolean;
};

export type HumanClickReport = {
  ok: boolean;
  step?: ClickType;
  matched?: string;         // какой селектор модалки сработал
  text?: string;            // текст таргет-элемента после успеха
};

export async function humanClick(
  page: Page,
  el: ElementHandle<Element>,
  opts: HumanClickOpts = {}
): Promise<HumanClickReport> {
  const {
    clickType = ClickType.MouseDownUp,
    edgeBias = 0.18,
    pressMs = 80,
    jitter = 1.5,
    removeNoClickEvent = true,
    afterMouseTimeoutMs = 5000,
    resultTimeoutMs = 5000,
    dialogSelectors = [],
    waitTextRevealed = false,
    debug = false,
  } = opts;

  const t0 = Date.now();
  const log = (...a:any[]) => { if (debug) console.log(`[HC][+${Date.now()-t0}ms]`, ...a); };
  const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

  // --- helpers ---
  const ensureVisible = async () => {
    try { await el.evaluate(n => (n as HTMLElement).scrollIntoView({block:'center', inline:'center'})); } catch {}
    try { await el.focus(); } catch {}
    try { await el.hover(); } catch {}
    const box = await el.boundingBox();
    return box ?? null;
  };

  const clickPoint = (box: {x:number;y:number;width:number;height:number}) => ({
    x: box.x + box.width * (0.5 - edgeBias) + (Math.random()-0.5)*jitter,
    y: box.y + box.height * 0.5 + (Math.random()-0.5)*jitter,
  });

  // ожидание результата (модалка или смена текста)
  async function waitResult(timeoutMs: number): Promise<{ok:boolean; matched?:string; text?:string}> {
    const deadline = Date.now() + timeoutMs;

    const anySelectorExists = async (sels: string[]) => {
      for (const s of sels) {
        const found = await el.evaluate((_, sel) => !!document.querySelector(sel), s).catch(()=>false);
        if (found) return s;
      }
      return '';
    };
    const anyInsideExists = async (rootSel: string, insideSels: string[]) => {
      for (const s of insideSels) {
        const found = await el.evaluate((_, rs, is) => {
          const root = document.querySelector(rs);
          return !!(root && (root as HTMLElement).querySelector(is));
        }, rootSel, s).catch(()=>false);
        if (found) return s;
      }
      return '';
    };

    while (Date.now() < deadline) {
      // модалка
      if (dialogSelectors && dialogSelectors.length) {
        const matched = await anySelectorExists(dialogSelectors);
        if (matched) {
          const text = await el.evaluate(n => (n as HTMLElement).innerText.trim()).catch(()=> '');
          return { ok:true, matched, text };
        }
      }
      // смена текста (телефон раскрыт)
      if (waitTextRevealed) {
        const ok = await el.evaluate(n => {
          const t = (n as HTMLElement).innerText.replace(/\s+/g,' ').trim();
          return !/X/i.test(t) && /[\d()+\-–\s]{7,}/.test(t);
        }).catch(()=>false);
        if (ok) {
          const text = await el.evaluate(n => (n as HTMLElement).innerText.trim()).catch(()=> '');
          return { ok:true, text };
        }
      }
      await sleep(80);
    }
    return { ok:false };
  }

  async function runStep(type: ClickType): Promise<HumanClickReport> {
    // подготовка
    if (removeNoClickEvent) {
      try {
        await el.evaluate(n => {
          n.querySelectorAll('.noClickEvent').forEach(m => m.classList.remove('noClickEvent'));
          (n as HTMLElement).style.pointerEvents = 'auto';
        });
      } catch {}
    }
    const box = await ensureVisible();
    if (!box) { log('no bbox (hidden/detached)'); return { ok:false }; }

    // исполнение
    try {
      if (type === ClickType.MouseDownUp) {
        const { x, y } = clickPoint(box);
        await page.mouse.move(x, y, { steps: 2 });
        await page.mouse.down();
        await sleep(pressMs);
        await page.mouse.up();
        const res = await waitResult(resultTimeoutMs);
        return res.ok ? { ok:true, step:type, ...res } : { ok:false };
      }

      if (type === ClickType.ElementClick) {
        await el.click({ delay: 20 });
        const res = await waitResult(resultTimeoutMs);
        return res.ok ? { ok:true, step:type, ...res } : { ok:false };
      }

      if (type === ClickType.JsClick) {
        await el.evaluate(n => (n as HTMLElement).click());
        const res = await waitResult(resultTimeoutMs);
        return res.ok ? { ok:true, step:type, ...res } : { ok:false };
      }

      if (type === ClickType.KeyboardEnter) {
        await page.keyboard.press('Enter');
        const res = await waitResult(resultTimeoutMs);
        return res.ok ? { ok:true, step:type, ...res } : { ok:false };
      }

      if (type === ClickType.EdgeMouseDownUp) {
        const x = box.x + Math.max(8, Math.min(14, box.width * 0.2));
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y, { steps: 2 });
        await page.mouse.down();
        await sleep(pressMs);
        await page.mouse.up();
        const res = await waitResult(afterMouseTimeoutMs);
        return res.ok ? { ok:true, step:type, ...res } : { ok:false };
      }
    } catch (e:any) {
      log(`${type} failed:`, e?.message ?? String(e));
      return { ok:false };
    }
    return { ok:false };
  }

  // режим: если переданы селекторы модалки/контента — игнорируем clickType и перебираем все типы
  const order: ClickType[] = [
    ClickType.MouseDownUp,
    ClickType.ElementClick,
    ClickType.JsClick,
    ClickType.KeyboardEnter,
    ClickType.EdgeMouseDownUp,
  ];

  if (dialogSelectors.length || waitTextRevealed) {
    for (const t of order) {
      const r = await runStep(t);
      if (r.ok) return r;
    }
    return { ok:false };
  }

  // режим: строго заданный тип клика
  return await runStep(clickType);
}
