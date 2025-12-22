import { Markup } from "telegraf";

export const getDetailedMenuKeyboard = (recipeRequested = false) => {
  const buttons = [
    [Markup.button.callback("Другое блюдо🔁", "another_dish")],
  ];

  // Если рецепт еще не был запрошен, показываем кнопки в одной строке
  if (!recipeRequested) {
    buttons.push([
      Markup.button.callback("Пошаговый рецепт📖", "step_by_step"),
      Markup.button.callback("Ингредиенты🔎", "ingredients")
    ]);
  }

  // Кнопки "Вернуться на главную" и "Закрыть" в одной строке
  buttons.push([
    Markup.button.callback("Вернуться на главную↩️", "back_to_main"),
    Markup.button.callback("Закрыть❌", "close_menu")
  ]);

  return Markup.inlineKeyboard(buttons);
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

  // Кнопка "Вернуться назад"
  buttons.push([Markup.button.callback("Вернуться назад↩️", "step_back")]);

  return Markup.inlineKeyboard(buttons);
};

export const detailedMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, " ", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Другое блюдо🔁", callback_data: "another_dish" }],
        [{ text: "Ингредиенты🔎", callback_data: "ingredients" }],
        [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }],
        [{ text: "Закрыть❌", callback_data: "close_menu" }]
      ]
    }
  });
}

export const getFullRecepieKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Другое блюдо🔁", "another_dish")],
    [Markup.button.callback("Вернуться на главную↩️", "back_to_main")],
    [Markup.button.callback("Закрыть❌", "close_menu")]
  ]);
};

export const fullRecepie = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, " ", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Другое блюдо🔁", callback_data: "another_dish" }],
        [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }],
        [{ text: "Закрыть❌", callback_data: "close_menu" }]
      ]
    }
  });
}

export const detailedCloseMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Меню закрыто", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Запуск✅", callback_data: "start_bot" }]
      ]
    }
  });
}

export const getSearchKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Вернуться на главную↩️", "back_to_main")]
  ]);
};