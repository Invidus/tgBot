import { keyboard } from "telegraf/markup"

export const getDetailedMenuKeyboard = () => {
  return {
    reply_markup: {
      keyboard: [
        ["Другое блюдо🔁"],
        ["Что нужно для приготовления🔎"],
        ["Вернуться на главную↩️"],
        ["Закрыть❌"]
      ]
    }
  };
};

export const detailedMenu = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, " ", {
    reply_markup: {
      keyboard: [
        ["Другое блюдо🔁"],
        ["Что нужно для приготовления🔎"],
        ["Вернуться на главную↩️"],
        ["Закрыть❌"]
      ]
    }
  })
}

export const getFullRecepieKeyboard = () => {
  return {
    reply_markup: {
      keyboard: [
        ["Другое блюдо🔁"],
        ["Вернуться на главную↩️"],
        ["Закрыть❌"]
      ]
    }
  };
};

export const fullRecepie = (bot, chatId) => {
  bot.telegram.sendMessage(chatId, " ", {
    reply_markup: {
      keyboard: [
        ["Другое блюдо🔁"],
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
