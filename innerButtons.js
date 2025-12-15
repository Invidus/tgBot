import { Markup } from "telegraf";

export const getDetailedMenuKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Другое блюдо🔁", "another_dish")],
    [Markup.button.callback("Что нужно для приготовления🔎", "ingredients")],
    [Markup.button.callback("Вернуться на главную↩️", "back_to_main")],
    [Markup.button.callback("Закрыть❌", "close_menu")]
  ]);
};

export const detailedMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, " ", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Другое блюдо🔁", callback_data: "another_dish" }],
        [{ text: "Что нужно для приготовления🔎", callback_data: "ingredients" }],
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