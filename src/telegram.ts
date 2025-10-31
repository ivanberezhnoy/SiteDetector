import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';


const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;


if (!token || !chatId) {
console.warn('[telegram] TELEGRAM_TOKEN or TELEGRAM_CHAT_ID is not set in .env');
}


let bot: TelegramBot | null = null;
export function getBot() {
if (!bot && token) bot = new TelegramBot(token, { polling: false });
return bot;
}


export async function sendMessage(text: string) {
const b = getBot();
if (!b || !chatId) return;
await b.sendMessage(chatId, text, { disable_web_page_preview: true });
}
