// telegram.ts
import TelegramBot, { SendMessageOptions } from "node-telegram-bot-api";
import "dotenv/config";

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.warn("[telegram] TELEGRAM_TOKEN or TELEGRAM_CHAT_ID is not set in .env");
}

// --- bot singleton ---------------------------------------------------------
let bot: TelegramBot | null = null;
export function getBot() {
  if (!bot && token) bot = new TelegramBot(token, { polling: false });
  return bot;
}

// --- helpers ---------------------------------------------------------------
function normalizeText(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function keyOf(siteId: string, topic?: string | null) {
  return `${(siteId ?? "").trim()}::${(topic ?? "").trim().toLowerCase()}`;
}

// in-memory cache последних сообщений по (siteId, topic)
const lastByKey = new Map<string, string>();

// --- базовая отправка (обратная совместимость) ----------------------------
/**
 * Отправляет сообщение в общий чат. Поведение как раньше.
 */
export async function sendMessage(text: string, options?: SendMessageOptions) {
  const b = getBot();
  if (!b || !chatId) return;
  await b.sendMessage(chatId, text, {
    disable_web_page_preview: true,
    ...options,
  });
}

// --- anti-spam по (siteId, topic) -----------------------------------------
export type SiteMessageOptions = SendMessageOptions & {
  /** Префикс, например эмодзи/теги, добавляется в начало */
  prefix?: string;
  /** Включать ли заголовок "[siteId] topic" перед текстом (по умолчанию true) */
  header?: boolean;
  /** Принудительно отправить, даже если дубликат (по умолчанию false) */
  force?: boolean;
};

/**
 * Отправляет сообщение, но только если оно отличается от последнего
 * для заданных (siteId, topic). Возвращает true, если отправлено.
 */
export async function sendSiteMessage(
  siteId: string,
  topic: string | undefined | null,
  text: string,
  options?: SiteMessageOptions
): Promise<boolean> {
  const b = getBot();
  if (!b || !chatId) return false;

  const { prefix, header = true, force = false, ...tgOpts } = options ?? {};
  const k = keyOf(siteId, topic);
  const normalized = normalizeText(text);

  if (!force && lastByKey.get(k) === normalized) {
    // дубль — не шлём
    return false;
  }

  const headerText = header
    ? [
        siteId ? `[${siteId}]` : "",
        (topic ?? "").trim() ? String(topic).trim() : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  const display = [prefix ?? "", headerText, text].filter(Boolean).join(" ").trim();

  await b.sendMessage(chatId, display, {
    disable_web_page_preview: true,
    ...tgOpts,
  });

  lastByKey.set(k, normalized);
  return true;
}

// --- reset utils -----------------------------------------------------------
/** Сбросить кэш последнего сообщения для пары (siteId, topic) */
export function resetSiteTopic(siteId: string, topic?: string | null) {
  lastByKey.delete(keyOf(siteId, topic));
}

/** Полный сброс анти-спам кэша */
export function resetAllSiteMessages() {
  lastByKey.clear();
}
