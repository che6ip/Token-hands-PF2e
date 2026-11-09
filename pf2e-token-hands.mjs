/**
 * PF2e: Руки на токене (pf2e-token-hands) — предметный модуль.
 * Foundry VTT v13–v14, система Pathfinder 2e.
 *
 * v1.3.0: вся механика отрисовки переехала в базовый модуль «Руки на токене»
 *         (token-hands). Здесь остался только разбор того, что актёр держит
 *         в руках, и подключение к базе через Hooks.call("tokenHandsRegister").
 *
 * v1.3.1: подпись автора и ссылка на Telegram в настройках модуля.
 *
 * Логика слотов (как рисует их — решает база):
 *  - один одноручный предмет  → правый слот, в левом — безоружная атака;
 *  - два предмета             → по слоту на каждый (приоритетный — справа);
 *  - двуручное оружие         → иконка справа и та же, затемнённая, слева;
 *  - руки пусты               → hands = null, база не рисует ничего.
 */

const MOD_ID = "pf2e-token-hands";
const BASE_ID = "token-hands";

const AUTHOR_NAME = "Чешир Шредингера";
const AUTHOR_TELEGRAM = "https://t.me/+BKPrpQRMP7cxMWFi";

const FALLBACK_UNARMED_ICON = "systems/pf2e/icons/unarmed-attacks/fist.webp";

/** Запасные иконки: кулак PF2e (база сама добавит кор-иконку последней). */
const ICON_FALLBACKS = [FALLBACK_UNARMED_ICON];

/* -------------------------------------------------------------------------- */
/*  Подключение к базе                                                        */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  if (game.system.id !== "pf2e") {
    console.warn(`[${MOD_ID}] Нужна система Pathfinder 2e — модуль отключается.`);
    return;
  }
  const base = game.modules.get(BASE_ID);
  if (!base?.active) {
    console.warn(`[${MOD_ID}] Не включён базовый модуль «Руки на токене» (${BASE_ID}) — слотов не будет.`);
    if (game.user.isGM) ui.notifications.warn(`${game.i18n.localize("PF2E-TOKEN-HANDS.NeedsBase")} (${BASE_ID})`);
    return;
  }
  registerSettings();

  Hooks.on("renderSettingsConfig", (app, element) => injectSettingsCredits(app, element));

  const provider = {
    id: "pf2e",
    resolveHands,
    iconFallbacks: ICON_FALLBACKS,
  };

  // База грузится раньше (её esmodule инициализируется до нашей попытки), но на
  // случай поздней загрузки пробуем оба канала: хук и прямой вызов API.
  Hooks.call(`${BASE_ID}Register`, provider);
  if (globalThis.tokenHands?.register?.(provider)) {
    console.info(`[${MOD_ID}] подключён к базе «${BASE_ID}»`);
  } else {
    console.warn(`[${MOD_ID}] база не приняла провайдера — проверь, что ${BASE_ID} включён и обновлён.`);
  }
});

Hooks.once("ready", () => {
  window.pf2eHands = { resolveHands, heldItems };
  console.log(`[${MOD_ID}] готов, версия ${game.modules.get(MOD_ID)?.version}`);
});

function registerSettings() {
  game.settings.register(MOD_ID, "showUnarmed", {
    name: "PF2E-TOKEN-HANDS.Settings.ShowUnarmed",
    hint: "PF2E-TOKEN-HANDS.Settings.ShowUnarmedHint",
    scope: "world", config: true, type: Boolean, default: true,
    // Перерисовку делает база: только ей известен список токенов сцены.
    onChange: () => globalThis.tokenHands?.refreshAllTokens?.(),
  });
}

/* -------------------------------------------------------------------------- */
/*  Подпись автора в настройках модуля                                        */
/* -------------------------------------------------------------------------- */

/** Строка «Автор: …» и ссылка на Telegram внизу вкладки модуля в настройках. */
function injectSettingsCredits(app, element) {
  if (!(element instanceof HTMLElement)) return;
  const section = element.querySelector(`section[data-group="categories"][data-tab="${MOD_ID}"]`);
  if (!section || section.querySelector(".token-hands-credits")) return;

  const box = document.createElement("div");
  box.className = "token-hands-credits";
  box.style.cssText = [
    "margin-top:1.5rem",
    "padding-top:.75rem",
    "border-top:1px solid var(--color-border-light-tertiary, rgba(255,255,255,.15))",
    "font-size:var(--font-size-12, 12px)",
    "line-height:1.6",
    "text-align:center",
    "color:var(--color-text-secondary, inherit)",
    "opacity:.85",
  ].join(";");

  const author = document.createElement("div");
  author.textContent = `${game.i18n.localize("PF2E-TOKEN-HANDS.Settings.Credits.Author")}: ${AUTHOR_NAME}`;

  const link = document.createElement("a");
  link.href = AUTHOR_TELEGRAM;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.style.color = "inherit";
  link.style.textDecoration = "underline";
  const icon = document.createElement("i");
  icon.className = "fa-brands fa-telegram";
  icon.setAttribute("aria-hidden", "true");
  link.append(icon, document.createTextNode(` ${game.i18n.localize("PF2E-TOKEN-HANDS.Settings.Credits.Telegram")}`));

  box.append(author, link);
  section.append(box);
}

/* -------------------------------------------------------------------------- */
/*  Разбор рук актёра: любой предмет с carryType "held"                       */
/* -------------------------------------------------------------------------- */

/**
 * Руки актёра для базы. null — актёр не наш (не персонаж/NPC) или руки пусты:
 * база в этом случае попробует другой предметный модуль и ничего не нарисует.
 */
function resolveHands(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return null;

  const showUnarmed = game.settings.get(MOD_ID, "showUnarmed");

  const held = [];
  for (const item of actor.items ?? []) {
    if (!item.system?.equipped) continue; // не физический предмет — пропускаем
    if (item.type === "weapon" && item.category === "unarmed") continue; // кулаки отдельно
    if (!isCarried(item)) continue; // не держится в руке (ножны, пояс, рюкзак)
    const hands = item.type === "weapon" ? handsUsed(item) : (item.usage?.hands ?? 1);
    if (hands < 1) continue;
    held.push({ item, hands, rank: rankOf(item) });
  }

  // Оружие → щиты → прочее; внутри группы — по порядку в листе
  held.sort((a, b) => (a.rank - b.rank) || ((a.item.sort ?? 0) - (b.item.sort ?? 0)));

  // Двуручное занимает обе руки: справа — как есть, слева — затемнённое
  const twoHanded = held.find((h) => h.hands >= 2);
  if (twoHanded) {
    return {
      right: handData(twoHanded.item),
      left: { ...handData(twoHanded.item), dim: true },
    };
  }

  // Руки пусты — сообщаем об этом базе через null
  if (held.length === 0) return null;

  // Один предмет → справа, слева безоружная атака (кулак)
  if (held.length === 1) {
    const right = handData(held[0].item);
    if (!showUnarmed) return { right, left: null };
    const unarmed = findUnarmed(actor);
    const left = unarmed
      ? handData(unarmed)
      : { img: FALLBACK_UNARMED_ICON, name: unarmedLabel(), item: null, dim: false };
    return { right, left };
  }

  // Два и более предмета: два приоритетных по слотам
  return { right: handData(held[0].item), left: handData(held[1].item) };
}

/** Приоритет слота: оружие важнее щита, щит важнее зелья/свитка/прочего. */
function rankOf(item) {
  if (item.type === "weapon") return 0;
  if (item.type === "shield") return 1;
  return 2;
}

function handData(item) {
  return { img: item.img, name: item.name, item, dim: false };
}

/** Сколько рук оружие занимает прямо сейчас. Сначала «держит ли», потом руки. */
function handsUsed(weapon) {
  if (!isCarried(weapon)) return 0; // в ножнах/на поясе — руки не занимает
  if (typeof weapon.handsHeld === "number" && weapon.handsHeld > 0) return weapon.handsHeld;
  const value = weapon.system?.hands?.value;
  if (value === undefined || value === null || value === "") return weapon.usage?.hands ?? 1;
  if (value === "1+") return 1;
  return Math.max(1, Number(value) || 1);
}

/**
 * Предмет именно держится в руке.
 * Единственный надёжный источник — carryType === "held" (PF2e 8.x).
 * При нехватке данных считаем, что НЕ держится (никаких фантомных слотов).
 */
function isCarried(item) {
  const carryType = item.carryType ?? foundry.utils.getProperty?.(item, "system.equipped.carryType");
  if (typeof carryType === "string") return carryType === "held";
  if (typeof item.isHeld === "boolean") return item.isHeld;
  return false;
}

/** Безоружная атака актёра (кулак/когти/клюв — что есть в чарнике). */
function findUnarmed(actor) {
  const unarmed = (actor.itemTypes?.weapon ?? [])
    .filter((w) => w.category === "unarmed")
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return unarmed.find((w) => isCarried(w)) ?? unarmed[0] ?? null;
}

function unarmedLabel() {
  return game.i18n.localize("PF2E-TOKEN-HANDS.Unarmed");
}

/* -------------------------------------------------------------------------- */
/*  Диагностика                                                               */
/* -------------------------------------------------------------------------- */

/** Что система считает держащимся в руках: window.pf2eHands.heldItems(actor) */
function heldItems(actor) {
  return [...(actor?.items ?? [])]
    .filter((i) => i.system?.equipped)
    .map((i) => ({
      name: i.name,
      type: i.type,
      carryType: i.carryType ?? i.system?.equipped?.carryType ?? null,
      isHeld: i.isHeld ?? null,
      countedAsHeld: isCarried(i),
    }));
}
