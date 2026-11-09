// ============================================================
// Dead's Man Loot — адаптер Pathfinder 2e
// ============================================================
// Вся механика лута живёт в базовом модуле deads-man-loot.
// Здесь только системно-зависимые значения: что считать трупом, какие
// предметы материальны, где уровень/редкость/количество, как называть
// хуки листов и куда вставлять поле шанса дропа.
// ============================================================

const MODULE_ID = "deads-man-loot-pf2e";
const BASE_ID = "deads-man-loot";

function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

// ============================================================
// СИСТЕМНЫЕ ЗНАЧЕНИЯ PF2e
// ============================================================
const NON_PHYSICAL_TYPES = new Set([
  "spell", "action", "feat", "condition", "effect", "lore",
  "ancestry", "background", "class", "deity", "heritage",
  "campaignFeature", "campaignEffect", "versatileTrait", "melee", "trait",
  "subclass", "species", "race", "facility", "ritual", "group"
]);

// Мёртв ли актёр (с учётом посмертных статусов токена).
function isDeadOrZeroHp(actor, tokenDocument = null) {
  if (!actor) return false;
  if (actor.isDead === true) return true;

  try {
    if (typeof actor.hasCondition === "function" && actor.hasCondition("dead")) return true;
  } catch (err) { /* метод мог быть недоступен */ }

  try {
    if (actor.effects?.some?.(effect => effect.statuses?.has?.("dead"))) return true;
  } catch (err) { /* effects ещё не готовы */ }

  try {
    if (actor.conditions?.some?.(c => c?.id === "dead" || c?.statuses?.has?.("dead"))) return true;
  } catch (err) { /* conditions могли быть удалены из ядра */ }

  // Посмертный статус на токене: «Мёртв»/«Кровоточит» рисуются на жетоне,
  // а HP актёра при этом может оставаться положительным.
  if (tokenDocument) {
    const statuses = tokenDocument.statuses;
    if (statuses?.has?.("dead")) return true;
    try {
      if (typeof statuses?.has === "function" && statuses.has("bloodied")) return true;
    } catch (err) { /* набор статусов мог быть другого типа */ }
  }

  const hpRaw =
    actor.hitPoints?.value ??
    actor.system?.attributes?.hp?.value ??
    actor.system?.details?.health?.value;

  if (hpRaw !== undefined && hpRaw !== null) {
    const hp = Number(hpRaw);
    if (Number.isFinite(hp) && hp <= 0) return true;
  }

  return false;
}

const provider = {
  id: "pf2e",

  // --- предметы ---
  isPhysicalItem(item) {
    if (!item) return false;
    if (typeof item.isOfType === "function") {
      try {
        if (item.isOfType("physical")) return true;
        if (
          item.isOfType("spell") ||
          item.isOfType("action") ||
          item.isOfType("feat") ||
          item.isOfType("condition") ||
          item.isOfType("effect") ||
          item.isOfType("lore")
        ) {
          return false;
        }
      } catch (err) { /* isOfType мог кинуть на нестандартном типе */ }
    }
    return !NON_PHYSICAL_TYPES.has(item.type);
  },

  getQuantity(item) {
    const nested = foundry.utils.getProperty(item, "system.quantity.value");
    if (nested !== undefined && nested !== null && typeof nested !== "object") {
      const n = Number(nested);
      if (Number.isFinite(n)) return n;
    }
    return 1;
  },

  getRarity(item) {
    return (
      item?.rarity ??
      foundry.utils.getProperty(item, "system.traits.rarity.value") ??
      foundry.utils.getProperty(item, "system.traits.rarity") ??
      null
    );
  },

  getLevel(item) {
    const level = item?.level ?? foundry.utils.getProperty(item, "system.level.value");
    if (level === undefined || level === null) return null;
    const n = Number(level);
    return Number.isFinite(n) ? n : null;
  },

  // --- мёртв ли актёр / какие листы обслуживаем ---
  isDead: (actor, tokenDocument = null) => isDeadOrZeroHp(actor, tokenDocument),

  shouldManageActor: actor => ["character", "npc"].includes(actor?.type),

  npcActorTypes: () => ["npc"],

  // --- монеты из мешочка ---
  currencyPath: denomination => `system.currency.${denomination}`,
  coinPouchTypes: () => ["consumable"],
  quantityPaths: () => ["system.quantity.value"],
  usesPath: () => "system.uses",

  // --- шанс дропа в листе предмета: поле под ценой ---
  percentControl: () => "input",
  percentInputAnchors: () => [
    ".weapon-summary", ".armor-summary", ".equipment-summary",
    ".consumable-summary", ".treasure-summary", ".backpack-summary",
    ".book-summary", ".kit-summary", ".shield-summary"
  ],

  // --- имена хуков листов PF2e ---
  itemSheetHooks: () => ["renderItemSheet", "renderItemSheetPF2e", "renderItemSheetV2", "renderItemSheetPF2eV2"],
  actorSheetHooks: () => [
    "renderActorSheet", "renderActorSheetPF2e", "renderActorSheetV2",
    "renderActorSheetPF2eV2", "renderNPCSheet", "renderActorSheetPF2eNPC"
  ],
  actorCloseHooks: () => ["closeActorSheet", "closeActorSheetV2", "closeActorSheetPF2e", "closeActorSheetPF2eV2"]
};

// ============================================================
// ПОДКЛЮЧЕНИЕ К БАЗЕ
// ============================================================
function attachToBase() {
  if (globalThis.deadsManLoot?.register) {
    const ok = globalThis.deadsManLoot.register(provider);
    if (ok) log("Адаптер PF2e подключён к базе");
    return ok;
  }
  // База может ещё не успеть объявить API: пробуем хук-канал.
  Hooks.call(`${BASE_ID}Register`, provider);
  const attached = globalThis.deadsManLoot?.providers?.some?.(a => a?.id === "pf2e");
  if (attached) log("Адаптер PF2e подключён к базе");
  return !!attached;
}

Hooks.once("ready", () => {
  if (game.system?.id !== "pf2e") return;

  const baseActive = game.modules?.get(BASE_ID)?.active === true;
  if (!baseActive) {
    warn("Базовый модуль Dead's Man Loot выключен — адаптеру не к чему подключаться.");
    return;
  }

  if (!attachToBase()) {
    warn("Не удалось подключиться к базовому модулю: проверь, что deads-man-loot включён и загружен раньше этого модуля.");
  }
});

// Диагностика в консоли браузера.
globalThis.deadsManLootPf2e = { provider };
