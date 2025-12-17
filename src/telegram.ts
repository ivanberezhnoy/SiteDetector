// telegram.ts
import TelegramBot, { SendMessageOptions } from "node-telegram-bot-api";
import "dotenv/config";


export enum MessageType {
  Info = "Info",
  Alert = "Alert",
  Error = "Error",
  Unknown = "Unknown",
}

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

// Храним message_id всех Info-сообщений по siteId
const infoMessageIdsBySiteId = new Map<string, number[]>();

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
  /** Если true — сообщение не отправляется (используется для беззвучных уведомлений) */
  silent?: boolean;
};

/**
 * Отправляет сообщение, но только если оно отличается от последнего
 * для заданных (siteId, topic). Возвращает true, если отправлено.
 */
const DUPLICATE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

type LastEntry = { text: string; sentAt: number };

export async function sendSiteMessage(
  siteId: string,
  topic: string | undefined | null,
  text: string,
  options?: SiteMessageOptions,
  messageType: MessageType = MessageType.Unknown
): Promise<boolean> {
  const { prefix, header = true, force = false, silent = false, ...tgOpts } = options ?? {};

  if (silent) return false;

  const b = getBot();
  if (!b || !chatId) return false;

  const k = keyOf(siteId, topic);
  const normalized = normalizeText(text);

  const isAlertOrError =
    messageType === MessageType.Alert || messageType === MessageType.Error;

  // --- если пришёл Alert / Error — удаляем все Info по этому siteId ---
  if (isAlertOrError) {
    const infoIds = infoMessageIdsBySiteId.get(siteId);
    if (infoIds && infoIds.length > 0) {
      // пробуем удалить все, но не падаем, если что-то уже нельзя удалить
      await Promise.all(
        infoIds.map((id) =>
          b.deleteMessage(chatId, id).catch((err) => {
            console.error(
              `Failed to delete Info message for siteId=${siteId}, message_id=${id}`,
              err
            );
          })
        )
      );
      infoMessageIdsBySiteId.delete(siteId);
    }
  }

  // ---- анти-дубликаты с окном в 2 часа ----
  if (!force) {
    const entry = lastByKey.get(k);
    if (entry) {
      const lastText = typeof entry === "string" ? entry : entry.text;
      const lastSentAt =
        typeof entry === "string" ? Date.now() : entry.sentAt; // для старого формата считаем «сейчас»
      const isDuplicate = lastText === normalized;
      const withinCooldown = Date.now() - lastSentAt < DUPLICATE_COOLDOWN_MS;

      if (isDuplicate && (withinCooldown || messageType == MessageType.Info)) {
        // дубликат — не шлём
        return false;
      }
    }
  }

  const headerText = header
    ? [
        siteId ? `[${siteId}]` : "",
        (topic ?? "").trim() ? String(topic).trim() : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  const display = [prefix ?? "", headerText, text]
    .filter(Boolean)
    .join(" ")
    .trim();

  // sendMessage должен вернуть объект с message_id
  const msg = await b.sendMessage(chatId, display, {
    disable_web_page_preview: true,
    ...tgOpts,
  });

  // фиксируем текст и время отправки (старый/новый формат поддержан)
  lastByKey.set(k, { text: normalized, sentAt: Date.now() });

  // если это Info — запоминаем message_id по siteId
  if (
    messageType === MessageType.Info &&
    msg &&
    typeof (msg as any).message_id === "number"
  ) {
    const id = (msg as any).message_id as number;
    const list = infoMessageIdsBySiteId.get(siteId) ?? [];
    list.push(id);
    infoMessageIdsBySiteId.set(siteId, list);
  }

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