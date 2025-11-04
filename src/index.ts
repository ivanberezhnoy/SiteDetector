import { loadConfig } from './config.ts';
import { phonesSet } from './utils/normalize.ts';
import { checkTopByPhone } from './monitor.ts';
import { runBump } from './bump.ts';
import { loadState, saveState } from './storage.ts';
import { sendSiteMessage } from './telegram.ts';
import { Site } from './types.ts';
import { SelectorNotFoundError } from './errors.ts';

// anti-spam ключи
const KEY_CFG_LOAD = 'config:load';

const state = loadState();

function markOnce(key: string): boolean {
  if (!state.notified[key]) {
    state.notified[key] = true;
    saveState(state);
    return true; // первый раз — можно слать уведомление
  }
  return false; // уже слали, не спамим
}

function clearMark(key: string) {
  if (state.notified[key]) {
    state.notified[key] = false;
    saveState(state);
  }
}

function validateSite(site: Site): string | null {
  if (!site.id) return 'missing "id"';
  if (!site.periodSec || site.periodSec < 15) return 'invalid "periodSec" (<15)';
  if (site.type === 'monitor') {
    if (!site.listUrl) return 'missing "listUrl"';
    if (!site.phoneSelector) return 'missing "phoneSelector"';
  } else {
    const l = site.login;
    if (!l?.url || !l.usernameSelector || !l.passwordSelector) {
      return 'invalid "login" block';
    }
    if (site.myAdsUrls.length === 0) return 'missing "myAdsUrls"';
    if (!site.function) return 'missing "function"';
  }
  return null;
}

function schedule(site: Site, myPhones: Set<string>) {
  const period = Math.max(30, site.periodSec ?? 300) * 1000;
  const KEY_POS = `${site.id}:lostpos`;
  const KEY_SEL = `${site.id}:selector`;
  const KEY_BAD = `${site.id}:badcfg`;

  const tick = async () => {
    try {
      // валидируем конфиг сайта
      const bad = validateSite(site);
      if (bad) {
        if (markOnce(KEY_BAD)) {
          await sendSiteMessage(site.id, "init", `⚠️ Проблемная конфигурация для сайта '${site.id}': ${bad}`);
        }
        return; // не запускаем задачу до фикса
      } else {
        clearMark(KEY_BAD);
      }

      if (site.type === 'monitor') {
        const res = await checkTopByPhone(site, myPhones);

        // восстановление после ошибок селекторов
        if (state.notified[KEY_SEL]) {
          clearMark(KEY_SEL);
          await sendSiteMessage(site.id, "init", `✅ Селекторы снова работают на '${site.id}'.`);
        }

        if (res.ok) 
        {
          await sendSiteMessage(site.id, "Check", `✅ Восстановлена позиция на '${site.id}'. Телефон: ${res.foundPhone ?? 'n/a'}`);

        } else {
          await sendSiteMessage(site.id, "Check", `⚠️ Позиция потеряна на '${site.id}'. Найден телефон: ${res.foundPhone ?? '—'}`);
        }
      } else {
        await runBump(site);
        // тут можно добавить отчёт о bump при необходимости
      }
    } catch (e: any) {
      // Специальный кейс: не нашли селектор — закрываем вкладку и пробуем позже, не спамим
      if (e instanceof SelectorNotFoundError) {
        if (markOnce(KEY_SEL)) {
          await sendSiteMessage(site.id, "init",
            `❌ Не удалось найти селектор на '${e.siteId}' (stage=${e.stage}): \`${e.selector}\`. Повторю позже.`
          );
        }
        return; // мягко выходим: setInterval запустит через period
      }

      // Остальные ошибки — единичное уведомление на запуск тикера
      const KEY_ERR = `${site.id}:error`;
      if (markOnce(KEY_ERR)) {
        await sendSiteMessage(site.id, "init", `❌ Ошибка на '${site.id}': ${e?.message || e}`);
      }
      // можно оставить лог в консоли
      console.error(`[${site.id}]`, e);
    }
  };

  // первый запуск сразу
  tick();
  setInterval(tick, period);
}

async function main() {
  // грузим конфиг (и шлём уведомление при падении)
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e: any) {
    if (markOnce(KEY_CFG_LOAD)) {
      await sendMessage(`❌ Не удалось загрузить файл с сайтами: ${e?.message || e}`);
    }
    throw e;
  }
  const myPhones = phonesSet(cfg.phones);

  console.log(`Loaded ${cfg.sites.length} sites.`);
  for (const s of cfg.sites) 
  {
    if (s.disabled) 
    {
      console.log(`⏸ ${s.id} пропущен (disabled=true)`);
      continue;
    }    
    console.log(`▶ Планировщик для ${s.id} (${s.type})`);
    schedule(s, myPhones);
  }
  console.log('✅ Bot started. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
