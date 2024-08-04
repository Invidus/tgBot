import { keyboard } from "telegraf/markup"

export const showMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Выберите действие", {
    reply_markup: {
      keyboard: [
        ["Завтрак🍏"],
        ["Обед🍜"],
        ["Ужин🍝"],
        ["Закрыть❌"]
      ]
    }
  })
}

export const closeMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, "Закрыть", {
    reply_markup: {
      remove_keyboard: true
    }
  })
}