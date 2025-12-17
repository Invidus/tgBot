import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { showMenu } from "./menu.js";
import { detailedMenu, detailedCloseMenu, fullRecepie, getDetailedMenuKeyboard, getSearchKeyboard } from "./innerButtons.js";
import { getBreakFast, getFullRecepie } from "./breakfast.js";
import { getDinner, getFullRecepieDinner } from "./dinner.js";
import { getLunch, getFullRecepieLunch } from "./lunch.js";
import { search, getFullRecepieSearch } from "./search.js";
import { Pagination } from "telegraf-pagination";
import { Markup } from "telegraf";

// TTL(time to live) очистка старых записей
const USER_DATA_TTL = 24 * 60 * 60 * 1000;
const userLastActivity = new Map(); // Отслеживание последней активности

// Хранилище ссылок на рецепты для каждого пользователя: chatId -> { breakfast: url, lunch: url, dinner: url }
const userHrefs = new Map();

// Хранилище последних поисковых запросов: chatId -> searchQuery
const userSearchQueries = new Map();

const bot = new Telegraf(config.telegramToken, {});

// Хранилище состояний пользователей: chatId -> state
const userStates = new Map();

// Вспомогательные функции для работы с состоянием
const getUserState = (chatId) => {
    return userStates.get(chatId) || 0;
};

const setUserState = (chatId, state) => {
    userStates.set(chatId, state);
};

const resetUserState = (chatId) => {
    userStates.set(chatId, 0);
};

// Вспомогательные функции для работы с hrefOnProduct
const resetUserHrefs = (chatId) => {
    userHrefs.delete(chatId);
    userSearchQueries.delete(chatId);
};
// Функция очистки старых данных
const cleanupOldUsers = () => {
    const now = Date.now();
    for (const [chatId, lastActivity] of userLastActivity.entries()) {
      if (now - lastActivity > USER_DATA_TTL) {
        userStates.delete(chatId);
        userHrefs.delete(chatId);
        userSearchQueries.delete(chatId);
        userLastActivity.delete(chatId);
      }
    }
  };
  // Запускать очистку каждые 6 часов
setInterval(cleanupOldUsers, 6 * 60 * 60 * 1000);
// Обновлять lastActivity при каждом взаимодействии
const updateUserActivity = (chatId) => {
    userLastActivity.set(chatId, Date.now());
  };

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    resetUserState(chatId);
    resetUserHrefs(chatId);

    // Сначала удаляем старую reply keyboard
    await ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️', {
        reply_markup: {
            remove_keyboard: true
        }
    });

    // Затем отправляем inline-кнопки
    await ctx.reply("Выберите действие", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Завтрак🍏", callback_data: "breakfast" }],
                [{ text: "Обед🍜", callback_data: "dinner" }],
                [{ text: "Ужин🍝", callback_data: "lunch" }],
                [{ text: "Поиск🔎", callback_data: "search" }],
                [{ text: "Закрыть❌", callback_data: "close_menu" }]
            ]
        }
    });
});

bot.command("playlist", async (ctx) => {
    const data = await getFullRecepie(ctx, userHrefs); // Replace this with your data retrieval logic
    const pagination = new Pagination({
       data: data,
       header: (currentPage, pageSize, total) => `Nəsimi BR: 250* 299k\nPage ${currentPage} of ${total}`,
       format: (item, index) => `${index + 1}. ${item.full_name} - ${item.company}`,
       pageSize: 5,
       rowSize: 5,
       onSelect: (item, index) => {
          // You can perform actions when an item is selected here
          ctx.reply(`You selected ${item.quantity} - ${item.price_usd}`);
       },
    });

    pagination.handleActions(bot);
    let text = await pagination.text();
    let keyboard = await pagination.keyboard();
    ctx.reply(text, keyboard);
 });

// Команда для удаления reply keyboard
bot.command("removekeyboard", async (ctx) => {
    await ctx.reply("Клавиатура удалена", {
        reply_markup: {
            remove_keyboard: true
        }
    });
});

 // Обработка inline-кнопок
bot.action("breakfast", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    let breakfast = await getBreakFast(ctx, userHrefs);
    await ctx.editMessageText(breakfast, getDetailedMenuKeyboard());
    setUserState(chatId, 1);
    await ctx.answerCbQuery();
});

bot.action("dinner", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    setUserState(chatId, 2);
    let dinner = await getDinner(ctx, userHrefs);
    await ctx.editMessageText(dinner, getDetailedMenuKeyboard());
    await ctx.answerCbQuery();
});

bot.action("lunch", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    setUserState(chatId, 3);
    let lunch = await getLunch(ctx, userHrefs);
    await ctx.editMessageText(lunch, getDetailedMenuKeyboard());
    await ctx.answerCbQuery();
});

bot.action("search", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    setUserState(chatId, 4);
    await ctx.editMessageText("Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.", getSearchKeyboard());
});

bot.action("another_dish", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);
    console.log(`User ${chatId} state:`, state);

    let messageText = "";
    switch (state) {
        case 1:
            messageText = await getBreakFast(ctx, userHrefs);
            break;
        case 2:
            messageText = await getDinner(ctx, userHrefs);
            break;
        case 3:
            messageText = await getLunch(ctx, userHrefs);
            break;
        case 4:
            // Повторяем последний поисковый запрос
            const lastSearchQuery = userSearchQueries.get(chatId);
            if (lastSearchQuery) {
                try {
                    messageText = await search(ctx, userHrefs, lastSearchQuery);
                } catch (error) {
                    console.error('Ошибка при повторном поиске:', error);
                    await ctx.answerCbQuery("Ошибка при поиске");
                    return;
                }
            } else {
                // Если запроса нет, просим ввести новый
                await ctx.answerCbQuery("Введите новый поисковый запрос");
                await ctx.editMessageText("Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.", getSearchKeyboard());
                return;
            }
            break;
        default:
            await ctx.answerCbQuery("Сначала выберите тип блюда");
            return;
    }

    await ctx.editMessageText(messageText, getDetailedMenuKeyboard());
    await ctx.answerCbQuery();
});

bot.action("ingredients", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);

    switch (state) {
        case 1:
            await getFullRecepie(ctx, userHrefs);
            break;
        case 2:
            await getFullRecepieDinner(ctx, userHrefs);
            break;
        case 3:
            await getFullRecepieLunch(ctx, userHrefs);
            break;
        case 4:
            await getFullRecepieSearch(ctx, userHrefs);
            break;
        default:
            await ctx.reply("Сначала выберите завтрак, обед или ужин.");
            break;
    }
    await ctx.answerCbQuery();
});

bot.action("back_to_main", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    resetUserState(chatId);
    resetUserHrefs(chatId);
    await ctx.editMessageText("Выберите действие", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Завтрак🍏", callback_data: "breakfast" }],
                [{ text: "Обед🍜", callback_data: "dinner" }],
                [{ text: "Ужин🍝", callback_data: "lunch" }],
                [{ text: "Поиск🔎", callback_data: "search" }],
                [{ text: "Закрыть❌", callback_data: "close_menu" }]
            ]
        }
    });
    await ctx.answerCbQuery();
});

bot.action("close_menu", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.editMessageText("Меню закрыто", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Запуск✅", callback_data: "start_bot" }]
            ]
        }
    });
    await ctx.answerCbQuery();
});

bot.action("start_bot", async (ctx) => {
    const chatId = ctx.chat.id;
    resetUserState(chatId);
    resetUserHrefs(chatId);

    // Удаляем reply keyboard через отдельное сообщение
    await ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️', {
        reply_markup: {
            remove_keyboard: true
        }
    });

    // Отправляем inline-кнопки
    await ctx.reply("Выберите действие", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Завтрак🍏", callback_data: "breakfast" }],
                [{ text: "Обед🍜", callback_data: "dinner" }],
                [{ text: "Ужин🍝", callback_data: "lunch" }],
                [{ text: "Поиск🔎", callback_data: "search" }],
                [{ text: "Закрыть❌", callback_data: "close_menu" }]
            ]
        }
    });
    await ctx.answerCbQuery();
});

bot.on("message", async ctx => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);

    // Обработка поискового запроса (state = 4)
    if (state === 4 && ctx.message.text && !ctx.message.text.startsWith('/')) {
        const searchQuery = ctx.message.text.trim();
        console.log('🔍 Получен поисковый запрос:', searchQuery, 'от пользователя', chatId);
        if (searchQuery) {
            try {
                // Сохраняем поисковый запрос для повторного использования
                userSearchQueries.set(chatId, searchQuery);

                const searchResult = await search(ctx, userHrefs, searchQuery);
                console.log('🔍 Результат поиска:', searchResult.substring(0, 100));
                await ctx.reply(searchResult, getDetailedMenuKeyboard());
            } catch (error) {
                console.error('❌ Ошибка при поиске:', error);
                await ctx.reply('Произошла ошибка при поиске. Попробуйте позже.');
            }
        }
        return;
    }

    // Обрабатывать только текстовые сообщения, не связанные с кнопками
    // Кнопки теперь обрабатываются через bot.action()
});
bot.launch()
  .then(() => {
    console.log('✅ Бот успешно запущен!');
  })
  .catch((err) => {
    console.error('❌ Ошибка при запуске бота:', err);
    process.exit(1);
  });

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));