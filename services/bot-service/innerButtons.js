import { Markup } from "telegraf";

// Функция для проверки, является ли URL рецептом
export const isRecipeUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  // Рецепты на 1000.menu имеют путь /cooking/
  // Исключаем служебные страницы: /vacancies, /about, /contacts и т.д.
  return url.includes('/cooking/') &&
         !url.includes('/vacancies') &&
         !url.includes('/about') &&
         !url.includes('/contacts') &&
         !url.includes('/privacy') &&
         !url.includes('/terms');
};

export const getDetailedMenuKeyboard = (recipeRequested = false, hasHistory = false, isInFavorites = false, isRecipe = true) => {
  const buttons = [];

  // Показываем кнопки только для рецептов
  if (isRecipe) {
    buttons.push([Markup.button.callback("Другое блюдо🔁", "another_dish")]);

    // Кнопка "Вернуться к прошлому рецепту" под кнопкой "Другое блюдо"
    if (hasHistory) {
      buttons.push([Markup.button.callback("◀️ Вернуться к прошлому рецепту", "previous_recipe")]);
    }

    // Кнопка избранного
    if (isInFavorites) {
      buttons.push([Markup.button.callback("❌ Удалить из избранного", "remove_from_favorites")]);
    } else {
      buttons.push([Markup.button.callback("⭐ Добавить в избранное", "add_to_favorites")]);
    }

    // Если рецепт еще не был запрошен, показываем кнопки в одной строке
    if (!recipeRequested) {
      buttons.push([
        Markup.button.callback("Как приготовить📖", "step_by_step"),
        Markup.button.callback("Ингредиенты и БЖУ🔎", "ingredients")
      ]);
    }
  }

  // Кнопка "Вернуться на главную" на всю ширину
  buttons.push([Markup.button.callback("Вернуться на главную↩️", "back_to_main")]);

  return Markup.inlineKeyboard(buttons);
};

// Клавиатура для списка избранного
export const getFavoritesKeyboard = (favorites, currentPage = 0, pageSize = 5) => {
  const buttons = [];
  const startIndex = currentPage * pageSize;
  const endIndex = Math.min(startIndex + pageSize, favorites.length);
  const currentPageFavorites = favorites.slice(startIndex, endIndex);

  // Кнопки для каждого рецепта
  currentPageFavorites.forEach(fav => {
    const title = fav.recipe_title.length > 40
      ? fav.recipe_title.substring(0, 40) + '...'
      : fav.recipe_title;
    buttons.push([
      Markup.button.callback(title, `favorite_${fav.id}`),
      Markup.button.callback("❌", `remove_favorite_${fav.id}`)
    ]);
  });

  // Кнопки навигации
  const navButtons = [];
  if (currentPage > 0) {
    navButtons.push(Markup.button.callback("◀️", `favorites_page_${currentPage - 1}`));
  }
  navButtons.push(Markup.button.callback(`${currentPage + 1} / ${Math.ceil(favorites.length / pageSize)}`, "favorites_info"));
  if (endIndex < favorites.length) {
    navButtons.push(Markup.button.callback("▶️", `favorites_page_${currentPage + 1}`));
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  // Кнопка возврата
  buttons.push([Markup.button.callback("Вернуться на главную↩️", "back_to_main")]);

  return Markup.inlineKeyboard(buttons);
};

// Клавиатура для просмотра рецепта из избранного
export const getFavoriteRecipeKeyboard = (favoriteId) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Ингредиенты и БЖУ🔎", `favorite_ingredients_${favoriteId}`)],
    [Markup.button.callback("Как приготовить📖", `favorite_step_by_step_${favoriteId}`)],
    [Markup.button.callback("❌ Удалить из избранного", `remove_favorite_${favoriteId}`)],
    [Markup.button.callback("◀️ Вернуться к списку", "favorites_list")],
    [Markup.button.callback("Вернуться на главную↩️", "back_to_main")]
  ]);
};

/**
 * Клавиатура для навигации по шагам рецепта
 * @param {number} currentStep - Текущий шаг (начиная с 0)
 * @param {number} totalSteps - Общее количество шагов
 * @returns {Markup} Inline клавиатура
 */
export const getStepNavigationKeyboard = (currentStep, totalSteps) => {
  const buttons = [];

  // Кнопки навигации
  const navButtons = [];

  // Кнопка "Назад" (<) - неактивна на первом шаге
  if (currentStep === 0) {
    navButtons.push(Markup.button.callback("◀️", "step_prev_disabled"));
  } else {
    navButtons.push(Markup.button.callback("◀️", "step_prev"));
  }

  // Индикатор шага (например, "1 / 5")
  navButtons.push(Markup.button.callback(`${currentStep + 1} / ${totalSteps}`, "step_info"));

  // Кнопка "Вперед" (>) - неактивна на последнем шаге
  if (currentStep === totalSteps - 1) {
    navButtons.push(Markup.button.callback("▶️", "step_next_disabled"));
  } else {
    navButtons.push(Markup.button.callback("▶️", "step_next"));
  }

  buttons.push(navButtons);

  // Кнопка "Назад" - возвращает к исходному сообщению с блюдом
  buttons.push([Markup.button.callback("Назад", "step_back")]);

  return Markup.inlineKeyboard(buttons);
};

export const getSearchKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Вернуться на главную↩️", "back_to_main")]
  ]);
};

// Клавиатура для меню подписки
export const getSubscriptionKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("1 месяц - 300₽", "subscribe_month")],
    [Markup.button.callback("6 месяцев - 1620₽ (скидка 10%)", "subscribe_half_year")],
    [Markup.button.callback("12 месяцев - 2880₽ (скидка 20%)", "subscribe_year")],
    [Markup.button.callback("◀️ Вернуться на главную", "back_to_main")]
  ]);
};

// Клавиатура для информации о подписке
export const getSubscriptionInfoKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 Купить подписку", "subscription_menu")],
    [Markup.button.callback("◀️ Вернуться на главную", "back_to_main")]
  ]);
};

