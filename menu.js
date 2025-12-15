import { Markup } from "telegraf";

export const showMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Выберите действие", {
    reply_markup: {
      remove_keyboard: true,  // Удаляем старую reply keyboard
      inline_keyboard: [
        [{ text: "Завтрак🍏", callback_data: "breakfast" }],
        [{ text: "Обед🍜", callback_data: "dinner" }],
        [{ text: "Ужин🍝", callback_data: "lunch" }],
        [{ text: "Закрыть❌", callback_data: "close_menu" }]
      ]
    }
  });
}

export const closeMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Меню закрыто", {
    reply_markup: {
      remove_keyboard: true
    }
  });
}