// src/utils/utils.ts

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
