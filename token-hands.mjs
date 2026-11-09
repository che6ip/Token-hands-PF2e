/**
 * Руки на токене (token-hands) — базовый модуль.
 * Foundry VTT v13–v14.
 *
 * v1.3.0: выделен в самостоятельную базу. Вся механика (слоты, рамка, иконки,
 *         клик по слоту, настройки размера/видимости, драйверы перерисовки)
 *         живёт здесь. Предметные модули (pf2e-token-hands, dnd5e-token-hands)
 *         только отвечают на вопрос «что держит этот актёр» и регистрируются
 *         через Hooks.call("tokenHandsRegister", провайдер).
 *
 * v1.4.0: добавлен личный переключатель токена во вкладке «Внешний вид»
 *         (над блоком динамического кольца) в окнах настройки токена и
 *         прототипа токена. Значение хранится в flags.token-hands.enabled;
 *         если флаг не задан, действует значение из прототипа токена актёра,
 *         затем — общая настройка модуля.
 *
 * v1.5.0: в окно Core → Prototype Token Overrides добавлена строка «Руки на
 *         токене» (пусто/Да/Нет) для «Всех типов» и каждого типа актёра.
 *         Значения хранятся в настройке мира token-hands.prototypeOverrides и
 *         применяются к токенам, у которых нет явного флага.
 *
 * v1.6.0: слоты рук поднимаются над нижним HP-баром токена (bar1), если он
 *         виден. Высота берётся из реальной позиции bar1, поэтому учитываются
 *         uiScale и токены высотой 2+ клетки.
 *
 * v1.7.0: в настройках модуля добавлена подпись автора.
 *
 * v1.7.1: защита от дублей спрайтов при одновременных перерисовках.
 *
 * v1.7.2: смещение снова применяется только когда HP-бар реально виден;
 *         без бара руки остаются в нижних углах.
 *
 * v1.8.0: добавлен визуальный редактор расположения слотов: перетаскивание
 *         левой/правой руки по превью токена, смена фоновой картинки, сброс
 *         и возврат к авто-расположению.
 *
 * v1.9.0: настройка «Сдвигать руки выше HP-бара» (включена по умолчанию),
 *         сетка в редакторе (включена) и синхронизация слотов (выключена).
 *
 * v1.9.1: в редакторе расположения показывается HP-бар как ориентир.
 *
 * v1.10.0: чекбоксы «Сетка» и «Синхронизация» убраны из общих настроек и
 *          остались только в редакторе; добавлена опция «Настроить для
 *          игроков», которая раздаёт раскладку всем пользователям.
 *
 * v1.10.1: убраны внешние контакты из настроек модулей и манифестов.
 *
 * Контракт провайдера:
 *   {
 *     id: "pf2e",                       // уникальный ключ, для логов и диагностики
 *     resolveHands(actor) => hands,     // руки актёра или null
 *     iconFallbacks?: string[],         // запасные пути иконок (по приоритету)
 *     hands?: { left: slot|null, right: slot|null } | null   // явные слоты вместо resolveHands
 *   }
 *   slot = { img, name, item?, dim?, fallbacks? }
 *     img  — путь к иконке; item — документ предмета, чей лист откроется по клику;
 *     dim  — затемнённая/полупрозрачная иконка (вторая рука двуручного оружия);
 *     fallbacks — дополнительные пути иконок именно для этого слота.
 *   resolveHands возвращает null, когда провайдер не берёт этого актёра на себя:
 *   тогда пробуется следующий провайдер (например PF2e-модуль в мире D&D 5e).
 *
 * Плоская модель отрисовки: спрайты слотов добавляются прямо в токен, без
 * промежуточных контейнеров — так они не зависят от того, как система
 * пересобирает детей токена.
 */

const MOD_ID = "token-hands";

/** Общая иконка-заглушка, если провайдер и фолбэки не дали картинки. */
const CORE_FALLBACK_ICON = "icons/svg/item-bag.svg";

/** Флаг личного переключателя токена: document.flags["token-hands"].enabled */
const FLAG_SCOPE = MOD_ID;
const FLAG_KEY = "enabled";
const FLAG_INPUT_NAME = `flags.${FLAG_SCOPE}.${FLAG_KEY}`;

/** Настройка глобальных переопределений прототипов: { base: bool, <actorType>: bool } */
const PROTOTYPE_OVERRIDES_SETTING = "prototypeOverrides";

/** Личное расположение слотов: { left: {x,y}, right: {x,y}, image: string } */
const SLOT_LAYOUT_SETTING = "slotLayout";

/** Общее расположение слотов для всех игроков (когда включена настройка ниже). */
const WORLD_SLOT_LAYOUT_SETTING = "slotLayoutWorld";

/** Применять расположение из редактора ко всем игрокам. */
const APPLY_TO_PLAYERS_SETTING = "applyToPlayers";

/** Картинка токена по умолчанию для редактора расположения. */
const DEFAULT_PREVIEW_IMAGE = "icons/svg/mystery-man.svg";

/** Подпись автора в настройках модуля. */
const AUTHOR_NAME = "Чешир Шредингера";

/* -------------------------------------------------------------------------- */
/*  Публичный API для предметных модулей и диагностики                        */
/* -------------------------------------------------------------------------- */

/** Провайдеры в порядке подключения: первый подходящий выигрывает. */
const _providers = [];

/** Публичный API: window.tokenHands (доступен уже на init). */
const API = {
  version: "1.10.1",

  /** Подключить провайдер рук (см. контракт в шапке файла). */
  register,
  unregister,

  /** Провайдеры, которые сейчас подключены. */
  providers: () => _providers.map((p) => p.id),

  /** Принудительно перерисовать все токены сцены. */
  refreshAllTokens,

  /** Перерисовать один токен. */
  renderTokenHands,

  /** Что провайдеры дали этому токену прямо сейчас. */
  handsFor: (token) => resolveTokenHands(token),

  /** Полное состояние слотов токена — для диагностики в консоли. */
  report(token) {
    return {
      token: token?.name,
      providers: this.providers(),
      size: tokenSize(token),
      tokenEnabled: isTokenHandsEnabled(token),
      barInset: barInset(token, tokenSize(token).h),
      visibleSetting: handsVisible(token),
      hands: resolveTokenHands(token),
      sprites: (token?.handsSprites ?? []).map((s) => ({
        name: s.name,
        parented: s.parent === token,
        destroyed: s.destroyed,
        visible: s.visible,
        renderable: s.renderable,
        eventMode: s.eventMode,
        x: s.x, y: s.y, w: s.width, h: s.height,
        texW: s.texture?.width ?? null,
      })),
      tokenVisible: token?.visible,
      tokenRenderable: token?.renderable,
    };
  },

  /** Быстрая диагностика: window.tokenHands.reportControlled() */
  reportControlled() {
    return (canvas?.tokens?.controlled ?? []).map((t) => this.report(t));
  },
};

/* -------------------------------------------------------------------------- */
/*  Инициализация                                                             */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  window.tokenHands = API; // предметные модули видят API уже на своём init
  registerSettings();
  registerHooks();
  // Способ для предметного модуля отдать провайдера: хук или window.tokenHands.register().
  Hooks.on(`${MOD_ID}Register`, (provider) => register(provider));
});

Hooks.once("ready", () => {
  // Предметные модули подключаются на своём init/ready; к ready их уже видно.
  adoptLegacyProviders();
  updateLayoutMenuRestriction();
  if (_providers.length === 0) {
    console.warn(`[${MOD_ID}] не подключился ни один предметный модуль — слотов не будет.`);
    if (game.user.isGM) ui.notifications.info(game.i18n.localize("TOKEN-HANDS.NoProvider"));
  } else if (isDebug()) {
    console.info(`[${MOD_ID}] провайдеры: ${_providers.map((p) => p.id).join(", ")}`);
  }
  console.log(`[${MOD_ID}] готов, версия ${game.modules.get(MOD_ID)?.version}, провайдеров: ${_providers.length}`);
});

function registerSettings() {
  game.settings.register(MOD_ID, "enabled", {
    name: "TOKEN-HANDS.Settings.Enabled",
    hint: "TOKEN-HANDS.Settings.EnabledHint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => refreshAllTokens(),
  });
  game.settings.register(MOD_ID, "sizePercent", {
    name: "TOKEN-HANDS.Settings.SizePercent",
    hint: "TOKEN-HANDS.Settings.SizePercentHint",
    scope: "client", config: true, type: Number, default: 30,
    range: { min: 15, max: 60, step: 1 },
    onChange: () => refreshAllTokens(),
  });
  game.settings.register(MOD_ID, "avoidBar", {
    name: "TOKEN-HANDS.Settings.AvoidBar",
    hint: "TOKEN-HANDS.Settings.AvoidBarHint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => refreshAllTokens(),
  });
  game.settings.register(MOD_ID, "layoutGrid", {
    name: "TOKEN-HANDS.Settings.LayoutGrid",
    hint: "TOKEN-HANDS.Settings.LayoutGridHint",
    scope: "client", config: false, type: Boolean, default: true,
  });
  game.settings.register(MOD_ID, "layoutSync", {
    name: "TOKEN-HANDS.Settings.LayoutSync",
    hint: "TOKEN-HANDS.Settings.LayoutSyncHint",
    scope: "client", config: false, type: Boolean, default: false,
  });
  game.settings.register(MOD_ID, "onlyInCombat", {
    name: "TOKEN-HANDS.Settings.OnlyInCombat",
    hint: "TOKEN-HANDS.Settings.OnlyInCombatHint",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => refreshAllTokens(),
  });
  game.settings.register(MOD_ID, "clickOpensSheet", {
    name: "TOKEN-HANDS.Settings.ClickOpensSheet",
    hint: "TOKEN-HANDS.Settings.ClickOpensSheetHint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => refreshAllTokens(),
  });
  game.settings.register(MOD_ID, "debug", {
    name: "TOKEN-HANDS.Settings.Debug",
    hint: "TOKEN-HANDS.Settings.DebugHint",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: () => refreshAllTokens(),
  });
  // Глобальные переопределения для прототипов токенов. UI — в окне
  // «Prototype Token Overrides» (Core → Prototype Token Overrides).
  game.settings.register(MOD_ID, PROTOTYPE_OVERRIDES_SETTING, {
    scope: "world", config: false, type: Object, default: {},
    onChange: () => refreshAllTokens(),
  });
  // Личное расположение слотов (редактируется визуально).
  game.settings.register(MOD_ID, SLOT_LAYOUT_SETTING, {
    scope: "client", config: false, type: Object, default: {},
    onChange: () => refreshAllTokens(),
  });
  // Общее расположение, которое мастер может раздать всем игрокам.
  game.settings.register(MOD_ID, WORLD_SLOT_LAYOUT_SETTING, {
    scope: "world", config: false, type: Object, default: {},
    onChange: () => refreshAllTokens(),
  });
  game.settings.register(MOD_ID, APPLY_TO_PLAYERS_SETTING, {
    name: "TOKEN-HANDS.Settings.ApplyToPlayers",
    hint: "TOKEN-HANDS.Settings.ApplyToPlayersHint",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: (value) => {
      updateLayoutMenuRestriction();
      if (value && game.user.isGM) {
        const world = readWorldSlotLayout();
        if (Object.keys(world).length === 0) {
          const client = readClientSlotLayout();
          if (Object.keys(client).length > 0) {
            game.settings.set(MOD_ID, WORLD_SLOT_LAYOUT_SETTING, client).catch((err) => {
              console.error(`[${MOD_ID}] не удалось перенести раскладку в общую настройку:`, err);
            });
          }
        }
      }
      refreshAllTokens();
    },
  });
  game.settings.registerMenu(MOD_ID, "layoutMenu", {
    name: "TOKEN-HANDS.Settings.LayoutMenu",
    label: "TOKEN-HANDS.Settings.LayoutMenuLabel",
    hint: "TOKEN-HANDS.Settings.LayoutMenuHint",
    icon: "fa-solid fa-arrows-up-down-left-right",
    type: HandsLayoutConfig,
    restricted: false,
  });
}

const isDebug = () => !!game.settings.get(MOD_ID, "debug");

/* -------------------------------------------------------------------------- */
/*  Реестр предметных модулей                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Подключение предметного модуля. Два способа на выбор:
 *   Hooks.call("tokenHandsRegister", { id: "pf2e", resolveHands, iconFallbacks })
 *   window.tokenHands?.register({ ... })   — если модуль грузится позже ready
 */
function register(provider) {
  if (!provider || typeof provider !== "object") {
    console.warn(`[${MOD_ID}] register: нужен объект провайдера`);
    return false;
  }
  const id = String(provider.id ?? "").trim();
  if (!id) {
    console.warn(`[${MOD_ID}] register: у провайдера нет id`);
    return false;
  }
  if (typeof provider.resolveHands !== "function" && !provider.hands) {
    console.warn(`[${MOD_ID}] register «${id}»: нет ни resolveHands(), ни hands`);
    return false;
  }
  const existing = _providers.findIndex((p) => p.id === id);
  if (existing !== -1) _providers.splice(existing, 1); // перезагрузка модуля → не дублируем
  _providers.push(provider);
  console.info(`[${MOD_ID}] подключён предметный модуль «${id}»`);
  refreshAllTokens();
  return true;
}

function unregister(id) {
  const i = _providers.findIndex((p) => p.id === id);
  if (i === -1) return false;
  _providers.splice(i, 1);
  console.info(`[${MOD_ID}] отключён предметный модуль «${id}»`);
  refreshAllTokens();
  return true;
}

/** Собрать руки токена через провайдеров. null — слотов нет. */
function resolveTokenHands(token) {
  if (!token?.actor) return null;
  adoptLegacyProviders(); // предметный модуль мог подключиться позже ready
  for (const provider of _providers) {
    let hands = null;
    try {
      hands = provider.hands ?? provider.resolveHands?.(token.actor) ?? null;
    } catch (err) {
      console.warn(`[${MOD_ID}] провайдер «${provider.id}» ошибся: ${err.message}`);
      continue;
    }
    if (!hands) continue; // провайдер не берёт этого актёра → пробуем следующего
    const left = normalizeSlot(hands.left, provider);
    const right = normalizeSlot(hands.right, provider);
    if (left || right) return { left, right, providerId: provider.id };
  }
  return null;
}

/** Привести слот от провайдера к внутреннему виду; null — слота нет. */
function normalizeSlot(slot, provider) {
  if (!slot || typeof slot !== "object") return null;
  const img = typeof slot.img === "string" ? slot.img : "";
  const item = slot.item ?? null;
  if (!img && !item) return null; // пустой слот без картинки и предмета не рисуем
  return {
    img: img || CORE_FALLBACK_ICON,
    name: slot.name ?? item?.name ?? "",
    item,
    dim: !!slot.dim,
    fallbacks: [...(slot.fallbacks ?? []), ...(provider?.iconFallbacks ?? [])].filter(Boolean),
  };
}

/* -------------------------------------------------------------------------- */
/*  Драйверы обновления                                                       */
/* -------------------------------------------------------------------------- */

function registerHooks() {
  Hooks.on("refreshToken", (token) => {
    const { w, h } = tokenSize(token);
    if (needsRender(token, w, h)) renderTokenHands(token);
  });

  Hooks.on("canvasReady", () => refreshAllTokens());

  Hooks.on("createToken", (doc) => {
    if (doc.object) renderTokenHands(doc.object);
  });

  Hooks.on("updateToken", (doc, changes) => {
    if ("actorId" in changes || "actorLink" in changes || "flags" in changes
      || "width" in changes || "height" in changes || "texture" in changes) {
      if (doc.object) renderTokenHands(doc.object);
    }
  });

  // Личный переключатель прототипа токена: обновляем все токены этого актёра.
  Hooks.on("updateActor", (actor, changes) => {
    if ("prototypeToken" in changes) refreshAllTokens();
  });

  // Поле «Руки на токене» в окнах настройки токена и прототипа токена.
  Hooks.on("renderTokenConfig", (app, element) => injectTokenConfigField(app, element));
  Hooks.on("renderPrototypeTokenConfig", (app, element) => injectTokenConfigField(app, element));

  // Глобальные On/Off-переопределения в окне Prototype Token Overrides.
  Hooks.on("renderPrototypeOverridesConfig", (app, element) => injectPrototypeOverridesField(app, element));

  // Подпись автора внизу вкладки модуля в настройках мира.
  Hooks.on("renderSettingsConfig", (app, element) => injectSettingsCredits(app, element));

  const onItemChange = (item) => scheduleRefresh(item?.actor ?? item?.parent);
  Hooks.on("createItem", onItemChange);
  Hooks.on("updateItem", onItemChange);
  Hooks.on("deleteItem", onItemChange);

  // Слоты только для участников боя: следим за составом инициативы
  let lastCombatSignature = null;
  const onCombatChange = () => {
    if (!game.settings.get(MOD_ID, "onlyInCombat")) return;
    const sig = combatSignature();
    if (sig === lastCombatSignature) return; // смена хода — не повод перерисовывать
    lastCombatSignature = sig;
    refreshAllTokens();
  };
  Hooks.on("createCombat", onCombatChange);
  Hooks.on("updateCombat", onCombatChange);
  Hooks.on("deleteCombat", onCombatChange);
  Hooks.on("createCombatant", onCombatChange);
  Hooks.on("updateCombatant", onCombatChange);
  Hooks.on("deleteCombatant", onCombatChange);
}

/** Флаг личного переключателя токена; undefined — флаг не задан. */
function readTokenHandsFlag(document) {
  const value = document?.flags?.[FLAG_SCOPE]?.[FLAG_KEY];
  return typeof value === "boolean" ? value : undefined;
}

/** Значения глобальных переопределений из настроек мира. */
function readPrototypeOverrides() {
  const value = game.settings.get(MOD_ID, PROTOTYPE_OVERRIDES_SETTING);
  return (value && typeof value === "object") ? value : {};
}

/** Глобальное переопределение для типа актёра; undefined — не задано. */
function prototypeOverrideFor(actor) {
  const overrides = readPrototypeOverrides();
  const typed = actor?.type ? overrides[actor.type] : undefined;
  if (typeof typed === "boolean") return typed;
  return typeof overrides.base === "boolean" ? overrides.base : undefined;
}

/**
 * Включены ли руки у токена с учётом личного переключателя.
 * Приоритет: флаг самого токена → флаг прототипа его актёра →
 * глобальное переопределение для типа актёра → «Все типы» → включено.
 */
function isTokenHandsEnabled(token) {
  const own = readTokenHandsFlag(token?.document);
  if (own !== undefined) return own;
  const prototype = readTokenHandsFlag(token?.actor?.prototypeToken);
  if (prototype !== undefined) return prototype;
  const override = prototypeOverrideFor(token?.actor);
  if (override !== undefined) return override;
  return true;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Приводит значение настройки к объекту раскладки. */
function asLayoutObject(value) {
  return (value && typeof value === "object") ? value : {};
}

/** Личная раскладка пользователя. */
function readClientSlotLayout() {
  return asLayoutObject(game.settings.get(MOD_ID, SLOT_LAYOUT_SETTING));
}

/** Общая раскладка, заданная мастером для всех игроков. */
function readWorldSlotLayout() {
  return asLayoutObject(game.settings.get(MOD_ID, WORLD_SLOT_LAYOUT_SETTING));
}

/** Эффективная раскладка: общая (если включена) или личная. */
function readSlotLayout() {
  return game.settings.get(MOD_ID, APPLY_TO_PLAYERS_SETTING)
    ? readWorldSlotLayout()
    : readClientSlotLayout();
}

/** Раскладка для открытия в редакторе: пустая общая → начинаем с личной. */
function readEditableSlotLayout() {
  if (game.settings.get(MOD_ID, APPLY_TO_PLAYERS_SETTING)) {
    const world = readWorldSlotLayout();
    if (Object.keys(world).length > 0) return world;
  }
  return readClientSlotLayout();
}

/** В какую настройку сохранять из редактора. */
function layoutTargetSetting() {
  return game.settings.get(MOD_ID, APPLY_TO_PLAYERS_SETTING)
    ? WORLD_SLOT_LAYOUT_SETTING
    : SLOT_LAYOUT_SETTING;
}

/** При общей раскладке редактор доступен только мастеру. */
function updateLayoutMenuRestriction() {
  const menu = game.settings.menus?.get(`${MOD_ID}.layoutMenu`);
  if (!menu) return;
  menu.restricted = game.settings.get(MOD_ID, APPLY_TO_PLAYERS_SETTING) === true;
}

/** Позиции по умолчанию (нормализованные, без учёта HP-бара). */
function defaultSlotPositions() {
  const pct = clamp((game.settings.get(MOD_ID, "sizePercent") ?? 30) / 100, 0.15, 0.6);
  const pad = 0.02;
  return {
    left: { x: pad, y: 1 - pct - pad },
    right: { x: 1 - pct - pad, y: 1 - pct - pad },
  };
}

/** Позиция слота в пикселях токена: пользовательская или автоматическая. */
function slotPosition(token, side, layout, w, h, size, pad, barOffset) {
  const saved = layout?.[side];
  const defaultX = side === "left" ? pad : w - size - pad;
  const baseX = saved && Number.isFinite(saved.x) ? Math.round(saved.x * w) : defaultX;
  const baseY = saved && Number.isFinite(saved.y) ? Math.round(saved.y * h) : h - size - pad;
  const maxX = Math.max(0, w - size);
  const maxY = Math.max(0, h - size - pad - barOffset);
  return {
    x: clamp(baseX, 0, maxX),
    y: Math.min(clamp(baseY, 0, h - size), maxY),
  };
}

/** Видимость слотов: личный переключатель, «только в бою» и участие в инициативе. */
function handsVisible(token) {
  if (!game.settings.get(MOD_ID, "enabled")) return false;
  if (!isTokenHandsEnabled(token)) return false;
  if (_providers.length === 0) return false;
  if (!game.settings.get(MOD_ID, "onlyInCombat")) return true;
  const combat = game.combat;
  if (!combat || combat.started === false) return false;
  const actorId = token.actor?.id;
  const tokenId = token.document?.id;
  for (const c of combat.combatants ?? []) {
    if (tokenId && c.tokenId === tokenId) return true;
    if (actorId && c.actorId === actorId) return true;
  }
  return false;
}

/** Сигнатура состава боя: меняется только при смене состава/статуса боя. */
function combatSignature() {
  const combat = game.combat;
  if (!combat || combat.started === false) return "none";
  const ids = [...(combat.combatants ?? [])].map((c) => c.tokenId ?? c.actorId ?? c.id).sort();
  return ids.join(",");
}

function needsRender(token, w, h) {
  const layout = token.handsLayout;
  const sprites = token.handsSprites;
  const alive = Array.isArray(sprites) && sprites.every((s) => !s.destroyed && s.parent === token);
  if (!alive) return true;
  if (!layout || layout.w !== w || layout.h !== h) return true;
  const bar = game.settings.get(MOD_ID, "avoidBar") ? barInset(token, h) : 0;
  if (layout.bar !== bar) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Переключатель в окне настройки токена                                     */
/* -------------------------------------------------------------------------- */

/**
 * Вставляет чекбокс «Руки на токене» во вторую вкладку окна настройки
 * («Внешний вид») — прямо над блоком динамического кольца. Хук вызывается и
 * для токена сцены, и для прототипа токена, поэтому поле доступно в обоих.
 */
function injectTokenConfigField(app, element) {
  if (!(element instanceof HTMLElement)) return;
  const tab = element.querySelector('.tab[data-tab="appearance"]');
  if (!tab) return;
  if (tab.querySelector(`input[name="${FLAG_INPUT_NAME}"]`)) return; // уже вставлен
  const ring = [...tab.querySelectorAll("fieldset")]
    .find((f) => f.querySelector('[name="ring.enabled"]')); // блок динамического кольца
  if (!ring) return;

  const token = app.token;
  const enabled = isTokenHandsEnabled({ document: token, actor: app.actor });
  const inputId = `${app.id || "token-config"}-hands-enabled`;

  const group = document.createElement("div");
  group.className = "form-group slim";

  const label = document.createElement("label");
  label.htmlFor = inputId;
  label.textContent = game.i18n.localize("TOKEN-HANDS.Settings.TokenEnabled");

  const fields = document.createElement("div");
  fields.className = "form-fields";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = inputId;
  input.name = FLAG_INPUT_NAME;
  input.checked = enabled;
  input.dataset.initial = enabled ? "1" : "0";
  fields.append(input);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = game.i18n.localize("TOKEN-HANDS.Settings.TokenEnabledHint");

  group.append(label, fields, hint);
  ring.before(group);

  // Не «закрепляем» флаг, если пользователь не трогал чекбокс: при отправке
  // формы убираем name, и значение наследуется из прототипа/глобальных настроек.
  bindTokenConfigSubmit(element);
}

const _tokenConfigForms = new WeakSet();

function bindTokenConfigSubmit(element) {
  const form = element.tagName === "FORM" ? element : element.querySelector?.("form");
  if (!form || _tokenConfigForms.has(form)) return;
  _tokenConfigForms.add(form);
  form.addEventListener("submit", () => {
    const input = form.querySelector(`input[name="${FLAG_INPUT_NAME}"]`);
    if (!input) return;
    if (input.checked === (input.dataset.initial === "1")) input.removeAttribute("name");
  }, true);
}

/* -------------------------------------------------------------------------- */
/*  Глобальные переопределения прототипов токенов                             */
/* -------------------------------------------------------------------------- */

/**
 * Добавляет строку «Руки на токене» (пусто / Да / Нет) в подвкладку «Основное»
 * окна Prototype Token Overrides — для «Всех типов» и каждого типа актёра.
 * Значения хранятся в собственной настройке мира и не смешиваются с core.
 */
function injectPrototypeOverridesField(app, element) {
  if (!(element instanceof HTMLElement)) return;
  const form = element.tagName === "FORM" ? element : element.querySelector?.("form");
  if (!form) return;

  for (const ring of form.querySelectorAll('select[name$=".ring.enabled"]')) {
    const type = ring.name.slice(0, -".ring.enabled".length);
    const ringGroup = ring.closest(".form-group");
    if (!ringGroup) continue;
    if (form.querySelector(`select[data-token-hands-type="${type}"]`)) continue;

    const override = readPrototypeOverrides()[type];
    const select = document.createElement("select");
    select.id = `${app.id || "prototype-token-overrides"}-${type}-token-hands`;
    select.dataset.tokenHandsType = type;

    const addOption = (value, label, selected) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = selected;
      select.append(option);
    };
    addOption("", "", override === undefined);
    addOption("true", game.i18n.localize("COMMON.Yes"), override === true);
    addOption("false", game.i18n.localize("COMMON.No"), override === false);

    const group = document.createElement("div");
    group.className = "form-group slim";
    const label = document.createElement("label");
    label.htmlFor = select.id;
    label.textContent = game.i18n.localize("TOKEN-HANDS.Settings.PrototypeOverride");
    const fields = document.createElement("div");
    fields.className = "form-fields";
    fields.append(select);
    group.append(label, fields);
    ringGroup.after(group);
  }

  bindPrototypeOverridesSubmit(form);
}

const _prototypeOverridesForms = new WeakSet();

function bindPrototypeOverridesSubmit(form) {
  if (_prototypeOverridesForms.has(form)) return;
  _prototypeOverridesForms.add(form);
  // Capture-фаза: core-обработчик формы не увидит наши поля (у них нет name),
  // а мы успеваем сохранить значения до закрытия окна.
  form.addEventListener("submit", () => {
    const values = {};
    for (const select of form.querySelectorAll("select[data-token-hands-type]")) {
      const type = select.dataset.tokenHandsType;
      if (select.value === "true") values[type] = true;
      else if (select.value === "false") values[type] = false;
    }
    game.settings.set(MOD_ID, PROTOTYPE_OVERRIDES_SETTING, values).catch((err) => {
      console.error(`[${MOD_ID}] не удалось сохранить переопределения прототипов:`, err);
    });
  }, true);
}

/* -------------------------------------------------------------------------- */
/*  Подпись автора в настройках модуля                                        */
/* -------------------------------------------------------------------------- */

/**
 * Добавляет в самый низ вкладки модуля в окне настроек мира строку
 * «Автор: …». Не участвует в форме и не мешает настройкам.
 */
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
  author.textContent = `${game.i18n.localize("TOKEN-HANDS.Settings.Credits.Author")}: ${AUTHOR_NAME}`;

  box.append(author);
  section.append(box);
}

/* -------------------------------------------------------------------------- */
/*  Визуальный редактор расположения слотов                                   */
/* -------------------------------------------------------------------------- */

const LAYOUT_GRID_STEP = 0.1;

const LAYOUT_EDITOR_CSS = `
.token-hands-layout { display:flex; flex-direction:column; gap:.6rem; height:100%; }
.token-hands-layout .th-preview {
  position:relative; width:100%; max-width:420px; aspect-ratio:1; margin:0 auto;
  border:1px solid var(--color-border-light-tertiary, #7a7971); border-radius:8px; overflow:hidden;
  background:#111 center/cover no-repeat; touch-action:none; user-select:none;
}
.token-hands-layout .th-grid {
  position:absolute; inset:0; pointer-events:none;
  background-image:
    linear-gradient(to right, rgba(217,197,131,.35) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(217,197,131,.35) 1px, transparent 1px);
  background-size:10% 10%;
}
.token-hands-layout .th-grid[hidden] { display:none; }
.token-hands-layout .th-hpbar {
  position:absolute; left:0; right:0; bottom:0; height:8%;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(#5fca5f, #2f8f2f);
  border-top:1px solid rgba(0,0,0,.65);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.25);
  font-size:10px; line-height:1; color:rgba(255,255,255,.9); text-shadow:0 0 2px #000;
  pointer-events:none; user-select:none;
}
.token-hands-layout .th-slot {
  position:absolute; box-sizing:border-box; border-radius:18%;
  background:rgba(14,14,20,.62); border:2px solid rgba(217,197,131,.85);
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.45);
  display:flex; align-items:center; justify-content:center; cursor:grab; touch-action:none;
}
.token-hands-layout .th-slot:active { cursor:grabbing; }
.token-hands-layout .th-slot img { width:72%; height:72%; object-fit:contain; pointer-events:none; }
.token-hands-layout .th-toggles {
  display:flex; gap:1rem; justify-content:center; align-items:center; flex-wrap:wrap;
}
.token-hands-layout .th-footer {
  display:flex; gap:.5rem; justify-content:flex-end; margin-top:auto; padding-top:.5rem;
}
.token-hands-layout .th-footer button { flex:0 0 auto; }
`;

/** Окно визуальной настройки положения слотов рук на токене. */
class HandsLayoutConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "token-hands-layout-config",
    tag: "div",
    classes: ["token-hands-layout-config"],
    window: {
      title: "TOKEN-HANDS.Layout.Title",
      icon: "fa-solid fa-arrows-up-down-left-right",
      resizable: false,
      contentClasses: ["standard-form"],
    },
    position: { width: 540, height: 700 },
    actions: {
      browseImage: HandsLayoutConfig.#onBrowseImage,
      resetLayout: HandsLayoutConfig.#onResetLayout,
      clearLayout: HandsLayoutConfig.#onClearLayout,
      saveLayout: HandsLayoutConfig.#onSaveLayout,
    },
  };

  #preview = null;
  #imageInput = null;
  #slots = {};
  #drag = null;
  #gridEl = null;
  #hpBar = null;
  #image = DEFAULT_PREVIEW_IMAGE;
  #positions = null;
  #grid = true;
  #sync = false;

  constructor(options = {}) {
    super(options);
    const defaults = defaultSlotPositions();
    const saved = readEditableSlotLayout();
    this.#image = (typeof saved.image === "string" && saved.image) ? saved.image : DEFAULT_PREVIEW_IMAGE;
    this.#positions = {
      left: this.#normalizePosition(saved.left, defaults.left),
      right: this.#normalizePosition(saved.right, defaults.right),
    };
    this.#grid = game.settings.get(MOD_ID, "layoutGrid") !== false;
    this.#sync = game.settings.get(MOD_ID, "layoutSync") === true;
  }

  #normalizePosition(value, fallback) {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return { ...fallback };
    return { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) };
  }

  /** @override */
  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "token-hands-layout";

    const style = document.createElement("style");
    style.textContent = LAYOUT_EDITOR_CSS;
    root.append(style);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = game.i18n.localize("TOKEN-HANDS.Layout.Hint");
    root.append(hint);

    const preview = document.createElement("div");
    preview.className = "th-preview";
    const grid = document.createElement("div");
    grid.className = "th-grid";
    preview.append(grid);
    const hpBar = document.createElement("div");
    hpBar.className = "th-hpbar";
    hpBar.textContent = game.i18n.localize("TOKEN-HANDS.Layout.HpBar");
    preview.append(hpBar);
    root.append(preview);

    for (const side of ["left", "right"]) {
      const slot = document.createElement("div");
      slot.className = "th-slot";
      slot.dataset.side = side;
      slot.title = game.i18n.localize(`TOKEN-HANDS.Layout.${side === "left" ? "Left" : "Right"}`);
      const img = document.createElement("img");
      img.src = side === "left" ? "icons/svg/shield.svg" : "icons/svg/sword.svg";
      img.alt = "";
      img.draggable = false;
      slot.append(img);
      preview.append(slot);
    }

    const toggles = document.createElement("div");
    toggles.className = "th-toggles";
    const gridToggle = document.createElement("label");
    gridToggle.className = "checkbox";
    const gridInput = document.createElement("input");
    gridInput.type = "checkbox";
    gridInput.className = "th-grid-toggle";
    gridToggle.append(gridInput, document.createTextNode(` ${game.i18n.localize("TOKEN-HANDS.Layout.Grid")}`));
    const syncToggle = document.createElement("label");
    syncToggle.className = "checkbox";
    syncToggle.title = game.i18n.localize("TOKEN-HANDS.Layout.SyncHint");
    const syncInput = document.createElement("input");
    syncInput.type = "checkbox";
    syncInput.className = "th-sync-toggle";
    syncToggle.append(syncInput, document.createTextNode(` ${game.i18n.localize("TOKEN-HANDS.Layout.Sync")}`));
    toggles.append(gridToggle, syncToggle);
    root.append(toggles);

    const imageGroup = document.createElement("div");
    imageGroup.className = "form-group slim";
    const imageLabel = document.createElement("label");
    imageLabel.textContent = game.i18n.localize("TOKEN-HANDS.Layout.Image");
    const imageFields = document.createElement("div");
    imageFields.className = "form-fields";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "th-image-path";
    input.placeholder = DEFAULT_PREVIEW_IMAGE;
    const browse = this.#makeButton("browseImage", "fa-solid fa-folder-open", "TOKEN-HANDS.Layout.Browse");
    imageFields.append(input, browse);
    imageGroup.append(imageLabel, imageFields);
    root.append(imageGroup);

    const footer = document.createElement("footer");
    footer.className = "th-footer";
    footer.append(
      this.#makeButton("resetLayout", "fa-solid fa-arrow-rotate-left", "TOKEN-HANDS.Layout.Reset"),
      this.#makeButton("clearLayout", "fa-solid fa-wand-magic-sparkles", "TOKEN-HANDS.Layout.Clear"),
      this.#makeButton("saveLayout", "fa-solid fa-floppy-disk", "TOKEN-HANDS.Layout.Save", true),
    );
    root.append(footer);
    return root;
  }

  /** @override */
  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#preview = this.element.querySelector(".th-preview");
    this.#imageInput = this.element.querySelector(".th-image-path");
    this.#slots = {};
    for (const slot of this.element.querySelectorAll(".th-slot")) {
      const side = slot.dataset.side;
      this.#slots[side] = slot;
      slot.addEventListener("pointerdown", (event) => this.#startDrag(side, event));
      slot.addEventListener("pointermove", (event) => this.#moveDrag(event));
      slot.addEventListener("pointerup", (event) => this.#endDrag(event));
      slot.addEventListener("pointercancel", (event) => this.#endDrag(event));
    }
    this.#imageInput?.addEventListener("change", () => {
      const value = this.#imageInput.value.trim();
      this.#image = value || DEFAULT_PREVIEW_IMAGE;
      this.#applyPreview();
    });

    this.#gridEl = this.element.querySelector(".th-grid");
    this.#hpBar = this.element.querySelector(".th-hpbar");
    const gridToggle = this.element.querySelector(".th-grid-toggle");
    if (gridToggle) {
      gridToggle.checked = this.#grid;
      gridToggle.addEventListener("change", () => {
        this.#grid = gridToggle.checked;
        game.settings.set(MOD_ID, "layoutGrid", this.#grid);
        this.#applyGrid();
      });
    }
    const syncToggle = this.element.querySelector(".th-sync-toggle");
    if (syncToggle) {
      syncToggle.checked = this.#sync;
      syncToggle.addEventListener("change", () => {
        this.#sync = syncToggle.checked;
        game.settings.set(MOD_ID, "layoutSync", this.#sync);
      });
    }
    this.#applyGrid();
    this.#applyPreview();
  }

  #makeButton(action, iconClass, labelKey, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    if (primary) button.classList.add("default");
    const icon = document.createElement("i");
    icon.className = iconClass;
    icon.setAttribute("aria-hidden", "true");
    button.append(icon, document.createTextNode(` ${game.i18n.localize(labelKey)}`));
    return button;
  }

  #slotFraction() {
    return clamp((game.settings.get(MOD_ID, "sizePercent") ?? 30) / 100, 0.15, 0.6);
  }

  /** Высота HP-бара относительно токена 1×1 (как в игре). */
  #barFraction() {
    const uiScale = canvas?.dimensions?.uiScale ?? 1;
    const gridSize = Math.max(1, canvas?.grid?.size ?? 100);
    return clamp((8 * uiScale) / gridSize, 0.03, 0.25);
  }

  #applyPreview() {
    if (!this.#preview) return;
    this.#preview.style.backgroundImage = `url(${JSON.stringify(this.#image)})`;
    if (this.#imageInput) this.#imageInput.value = this.#image;
    if (this.#hpBar) this.#hpBar.style.height = `${this.#barFraction() * 100}%`;
    const pct = this.#slotFraction();
    for (const side of ["left", "right"]) {
      const slot = this.#slots[side];
      if (!slot) continue;
      slot.style.width = `${pct * 100}%`;
      slot.style.height = `${pct * 100}%`;
      this.#placeSlot(side);
    }
  }

  #applyGrid() {
    if (this.#gridEl) this.#gridEl.hidden = !this.#grid;
  }

  #placeSlot(side) {
    const slot = this.#slots[side];
    const position = this.#positions?.[side];
    if (!slot || !position) return;
    const max = 1 - this.#slotFraction();
    const x = clamp(position.x, 0, max);
    const y = clamp(position.y, 0, max);
    this.#positions[side] = { x, y };
    slot.style.left = `${x * 100}%`;
    slot.style.top = `${y * 100}%`;
  }

  #startDrag(side, event) {
    if (event.button !== 0 || !this.#preview) return;
    event.preventDefault();
    const rect = this.#preview.getBoundingClientRect();
    const position = this.#positions[side];
    this.#drag = {
      side,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  #moveDrag(event) {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const max = 1 - this.#slotFraction();
    let x = drag.x + (event.clientX - drag.startX) / drag.width;
    let y = drag.y + (event.clientY - drag.startY) / drag.height;
    if (this.#grid) {
      x = Math.round(x / LAYOUT_GRID_STEP) * LAYOUT_GRID_STEP;
      y = Math.round(y / LAYOUT_GRID_STEP) * LAYOUT_GRID_STEP;
    }
    x = clamp(x, 0, max);
    y = clamp(y, 0, max);
    this.#positions[drag.side] = { x, y };
    this.#placeSlot(drag.side);

    if (this.#sync) {
      const other = drag.side === "left" ? "right" : "left";
      this.#positions[other] = { x: max - x, y };
      this.#placeSlot(other);
    }
  }

  #endDrag(event) {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#drag = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (err) { /* уже отпущено */ }
  }

  /** @this {HandsLayoutConfig} */
  static #onBrowseImage() {
    new foundry.applications.apps.FilePicker({
      type: "image",
      current: this.#image,
      callback: (path) => {
        if (!path) return;
        this.#image = path;
        this.#applyPreview();
      },
    }).render(true);
  }

  /** @this {HandsLayoutConfig} */
  static #onResetLayout() {
    const defaults = defaultSlotPositions();
    this.#image = DEFAULT_PREVIEW_IMAGE;
    this.#positions = { left: { ...defaults.left }, right: { ...defaults.right } };
    this.#applyPreview();
  }

  /** @this {HandsLayoutConfig} */
  static async #onClearLayout() {
    const target = layoutTargetSetting();
    if (target === WORLD_SLOT_LAYOUT_SETTING && !game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("TOKEN-HANDS.Layout.MasterOnly"));
      return;
    }
    await game.settings.set(MOD_ID, target, {});
    refreshAllTokens();
    await this.close();
  }

  /** @this {HandsLayoutConfig} */
  static async #onSaveLayout() {
    const target = layoutTargetSetting();
    if (target === WORLD_SLOT_LAYOUT_SETTING && !game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("TOKEN-HANDS.Layout.MasterOnly"));
      return;
    }
    const layout = {
      left: { ...this.#positions.left },
      right: { ...this.#positions.right },
      image: this.#image,
    };
    // При общей раскладке мастер сохраняет её и как свою личную, чтобы
    // после выключения опции у него осталось то же расположение.
    if (target === WORLD_SLOT_LAYOUT_SETTING) {
      await game.settings.set(MOD_ID, SLOT_LAYOUT_SETTING, layout);
    }
    await game.settings.set(MOD_ID, target, layout);
    refreshAllTokens();
    await this.close();
  }
}

const _pendingActors = new Set();
let _flushQueued = false;

function scheduleRefresh(actor) {
  if (!actor?.id) return;
  _pendingActors.add(actor.id);
  if (_flushQueued || !canvas?.ready) return;
  _flushQueued = true;
  requestAnimationFrame(flushPending);
}

function flushPending() {
  _flushQueued = false;
  const ids = new Set(_pendingActors);
  _pendingActors.clear();
  if (!canvas?.ready) return;
  for (const token of placedTokens()) {
    if (token.actor && ids.has(token.actor.id)) renderTokenHands(token);
  }
}

function placedTokens() {
  return canvas?.tokens?.placeables ?? [];
}

function refreshAllTokens() {
  if (!canvas?.ready) return;
  for (const t of placedTokens()) renderTokenHands(t);
}

/* -------------------------------------------------------------------------- */
/*  Плоская отрисовка: спрайты напрямую в токене                              */
/* -------------------------------------------------------------------------- */

function clearHandSprites(token) {
  for (const sprite of token.handsSprites ?? []) {
    if (!sprite.destroyed) sprite.destroy();
  }
  token.handsSprites = [];
}

async function renderTokenHands(token) {
  if (!token || token.destroyed) return;

  // Отменяем незавершённую предыдущую отрисовку этого токена: иначе при
  // быстрых refresh'ах два async-вызова могут добавить спрайты одновременно,
  // и на токене останутся дубли.
  const generation = (token.handsRenderGeneration ?? 0) + 1;
  token.handsRenderGeneration = generation;
  const isStale = () => token.destroyed || token.handsRenderGeneration !== generation;

  const { w, h } = tokenSize(token);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) return;

  clearHandSprites(token);
  const barOffset = game.settings.get(MOD_ID, "avoidBar") ? barInset(token, h) : 0;
  token.handsLayout = { w, h, bar: barOffset };

  const hands = handsVisible(token) ? resolveTokenHands(token) : null;
  if (!hands) return; // нет провайдера, руки пусты или токен вне боя

  const sizePct = (game.settings.get(MOD_ID, "sizePercent") ?? 30) / 100;
  const size = Math.round(Math.max(14, Math.min(w * sizePct, 150)));
  const pad = Math.max(1, Math.round(w * 0.02));
  const layout = readSlotLayout();
  const pos = {
    left: slotPosition(token, "left", layout, w, h, size, pad, barOffset),
    right: slotPosition(token, "right", layout, w, h, size, pad, barOffset),
  };

  const sprites = [];
  const discard = () => {
    for (const sprite of sprites) {
      if (!sprite.destroyed) sprite.destroy();
    }
  };

  for (const side of ["right", "left"]) {
    const data = hands[side];
    if (!data) continue;
    if (isStale()) { discard(); return; }
    const p = pos[side];

    // Рамка: спрайт с canvas-текстурой, напрямую в токене
    const frame = new PIXI.Sprite(getFrameTexture(size, data.dim));
    frame.name = `hand-${side}-frame`;
    frame.width = size;
    frame.height = size;
    frame.position.set(p.x, p.y);
    token.addChild(frame);
    sprites.push(frame);

    makeSlotClickable(frame, data);

    // Иконка предмета
    const texture = await loadIconTexture(data.img, data.fallbacks);
    if (isStale()) { discard(); return; }
    const inset = Math.round(size * 0.14);
    const icon = new PIXI.Sprite(texture);
    icon.name = `hand-${side}-icon`;
    icon.alpha = data.dim ? 0.4 : 1;
    icon.width = size - inset * 2;
    icon.height = size - inset * 2;
    icon.position.set(p.x + inset, p.y + inset);
    if (data.dim) {
      try {
        const grayscale = new PIXI.filters.ColorMatrixFilter();
        grayscale.grayscale?.(0.85, false);
        icon.filters = [grayscale];
      } catch (err) { /* остаётся полупрозрачность */ }
    }
    token.addChild(icon);
    sprites.push(icon);

    // Кликабельна вся площадь слота, а не только рамка по краям
    makeSlotClickable(icon, data);
  }

  if (isStale()) { discard(); return; }
  token.handsSprites = sprites;
  if (isDebug()) {
    console.info(`[${MOD_ID}] слоты «${token.name}» (${hands.providerId}): left=${!!hands.left}, right=${!!hands.right}, size=${size}, спрайтов=${sprites.length}`);
  }
}

/**
 * Клик по любой точке слота (рамка + иконка) открывает лист предмета.
 * stopPropagation нужен, чтобы клик по квадрату не выделял и не тащил токен:
 * событие до родителя-токена в этом случае не доходит.
 */
function makeSlotClickable(displayObject, data) {
  const item = data.item;
  const opensSheet = game.settings.get(MOD_ID, "clickOpensSheet") && item;
  if (!opensSheet) {
    // Квадрат прозрачен для мыши: токен и выделяется, и тащится за любой уголок.
    displayObject.eventMode = "none";
    return;
  }

  displayObject.eventMode = "static";
  displayObject.cursor = "pointer";

  let downAt = null;
  displayObject.on("pointerdown", (ev) => {
    ev.stopPropagation();
    downAt = { x: ev.global.x, y: ev.global.y };
  });
  displayObject.on("pointertap", (ev) => {
    ev.stopPropagation();
    if (downAt && Math.hypot(ev.global.x - downAt.x, ev.global.y - downAt.y) > 10) return;
    item.sheet?.render(true);
  });
}

/** Пиксельные габариты токена: dimensions → старое w/h → размер сетки. */
function tokenSize(token) {
  const d = token?.dimensions;
  if (d && Number.isFinite(d.width) && d.width > 0 && Number.isFinite(d.height)) {
    return { w: d.width, h: d.height };
  }
  if (Number.isFinite(token?.w) && token.w > 0) return { w: token.w, h: token.h };
  const gs = canvas.grid?.size ?? 100;
  const doc = token?.document;
  return { w: (doc?.width ?? 1) * gs, h: (doc?.height ?? 1) * gs };
}

/**
 * Насколько поднять слоты, чтобы они не перекрывали нижний HP-бар.
 * Если бар не виден (скрыт режимом показа, нет bar1/max и т.п.) — смещение 0,
 * и руки остаются в нижних углах токена.
 * Высота берётся из реальной позиции bar1, иначе — по формуле ядра Foundry.
 */
function barInset(token, h) {
  const bars = token?.bars;
  if (!bars?.visible || !bars.bar1?.visible) return 0;
  const y = Number(bars.bar1.position?.y);
  if (Number.isFinite(y) && y > 0 && y < h) return h - y;
  const s = canvas?.dimensions?.uiScale ?? 1;
  const bh = 8 * ((token.document?.height ?? 1) >= 2 ? 1.5 : 1) * s;
  return Math.max(0, Math.min(bh, h / 2));
}

/* -------------------------------------------------------------------------- */
/*  Рамка слота: offscreen-canvas → PIXI.Texture                              */
/* -------------------------------------------------------------------------- */

const _frameCache = new Map();

function getFrameTexture(size, dim) {
  const key = `${size}:${dim ? 1 : 0}`;
  if (_frameCache.has(key)) return _frameCache.get(key);

  const scale = 2; // двойное разрешение для чёткости на зуме
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.max(2, Math.round(size * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  const r = size * 0.18;

  // тень
  traceRoundedRect(ctx, 1.5, 2, size - 2, size - 2, r);
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fill();

  // фон + рамка
  traceRoundedRect(ctx, 0.5, 0.5, size - 1, size - 1, r);
  ctx.fillStyle = "rgba(14,14,20,0.62)";
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.05);
  ctx.strokeStyle = dim ? "rgba(150,150,158,0.55)" : "rgba(217,197,131,0.85)";
  ctx.stroke();

  const texture = PIXI.Texture.from(canvas);
  _frameCache.set(key, texture);
  return texture;
}

function traceRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Загрузка текстуры иконки с фолбэками: сама картинка → фолбэки слота → фолбэки модуля → кор-иконка. */
async function loadIconTexture(src, slotFallbacks) {
  const loader = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  const candidates = [src, ...(slotFallbacks ?? []), CORE_FALLBACK_ICON].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const texture = await loader(candidate);
      if (texture) return texture;
    } catch (err) { /* пробуем следующий */ }
  }
  return PIXI.Texture.WHITE ?? PIXI.Texture.EMPTY;
}

/* -------------------------------------------------------------------------- */
/*  Обратная совместимость с прошлыми версиями                               */
/* -------------------------------------------------------------------------- */

/**
 * Предметный модуль старше v1.3.0 не вызывает register(), а просто объявляет
 * глобальный resolveHands (window.pf2eHands / window.dnd5eHands). Такой
 * провайдер подхватывается автоматически, но только когда модуль уже успел
 * объявить глобал — поэтому проверка повторяется при каждом обновлении токена.
 */
const _legacyGlobals = [
  { global: "pf2eHands", id: "pf2e" },
  { global: "dnd5eHands", id: "dnd5e" },
];

function adoptLegacyProviders() {
  for (const { global, id } of _legacyGlobals) {
    if (_providers.some((p) => p.id === id)) continue; // уже подключился по-новому
    const candidate = globalThis[global];
    if (!candidate || typeof candidate.resolveHands !== "function") continue;
    register({ id, resolveHands: candidate.resolveHands });
  }
}
