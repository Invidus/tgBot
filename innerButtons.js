import { keyboard } from "telegraf/markup"

export const detailedMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Выберите действие", {
    reply_markup: {
      keyboard: [
        ["Другое блюдо➡️"],
        ["Получить подробный рецепт🔎"],
        ["Вернуться на главную↩️"],
        ["Закрыть❌"]
      ]
    }
  })
}

export const detailedCloseMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Меню закрыто", {
    reply_markup: {
      keyboard: [
        ["Запуск✅"]
      ]
    }
  })
}