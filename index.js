import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { getDetailedMenuKeyboard, getSearchKeyboard } from "./innerButtons.js";
import { getBreakFast, getFullRecepie } from "./breakfast.js";
import { getDinner, getFullRecepieDinner } from "./dinner.js";
import { getLunch, getFullRecepieLunch } from "./lunch.js";
import { search, getFullRecepieSearch } from "./search.js";
import { initBrowser, closeBrowser } from "./browserManager.js";

// TTL(time to live) очистка старых записей
const USER_DATA_TTL = 24 * 60 * 60 * 1000;
const userLastActivity = new Map(); // Отслеживание последней активности

// Хранилище ссылок на рецепты для каждого пользователя: chatId -> { breakfast: url, lunch: url, dinner: url }
const userHrefs = new Map();

// Хранилище последних поисковых запросов: chatId -> searchQuery
const userSearchQueries = new Map();

// Хранилище флагов запрошенных рецептов: chatId -> { breakfast: boolean, lunch: boolean, dinner: boolean, search: boolean }
const userRecipeRequested = new Map();

// Функции для работы с запрошенными рецептами
const setRecipeRequested = (chatId, dishType) => {
    if (!userRecipeRequested.has(chatId)) {
        userRecipeRequested.set(chatId, { breakfast: false, lunch: false, dinner: false, search: false });
    }
    const requested = userRecipeRequested.get(chatId);
    requested[dishType] = true;
};

const isRecipeRequested = (chatId, dishType) => {
    const requested = userRecipeRequested.get(chatId);
    return requested && requested[dishType] === true;
};

const resetRecipeRequested = (chatId, dishType) => {
    if (userRecipeRequested.has(chatId)) {
        const requested = userRecipeRequested.get(chatId);
        requested[dishType] = false;
    }
};

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
    userRecipeRequested.delete(chatId);
};
// Функция очистки старых данных
const cleanupOldUsers = () => {
    const now = Date.now();
    for (const [chatId, lastActivity] of userLastActivity.entries()) {
      if (now - lastActivity > USER_DATA_TTL) {
        userStates.delete(chatId);
        userHrefs.delete(chatId);
        userSearchQueries.delete(chatId);
        userRecipeRequested.delete(chatId);
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
    resetRecipeRequested(chatId, 'breakfast'); // Сбрасываем флаг при выборе нового блюда
    let breakfast = await getBreakFast(ctx, userHrefs);
    const recipeRequested = isRecipeRequested(chatId, 'breakfast');
    try {
        await ctx.editMessageText(breakfast, getDetailedMenuKeyboard(recipeRequested));
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            await ctx.reply(breakfast, getDetailedMenuKeyboard(recipeRequested));
        }
    }
    setUserState(chatId, 1);
});

bot.action("dinner", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    resetRecipeRequested(chatId, 'dinner'); // Сбрасываем флаг при выборе нового блюда
    setUserState(chatId, 2);
    let dinner = await getDinner(ctx, userHrefs);
    const recipeRequested = isRecipeRequested(chatId, 'dinner');
    try {
        await ctx.editMessageText(dinner, getDetailedMenuKeyboard(recipeRequested));
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            await ctx.reply(dinner, getDetailedMenuKeyboard(recipeRequested));
        }
    }
});

bot.action("lunch", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    resetRecipeRequested(chatId, 'lunch'); // Сбрасываем флаг при выборе нового блюда
    setUserState(chatId, 3);
    let lunch = await getLunch(ctx, userHrefs);
    const recipeRequested = isRecipeRequested(chatId, 'lunch');
    try {
        await ctx.editMessageText(lunch, getDetailedMenuKeyboard(recipeRequested));
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            await ctx.reply(lunch, getDetailedMenuKeyboard(recipeRequested));
        }
    }
});

bot.action("search", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    setUserState(chatId, 4);
    try {
        await ctx.editMessageText("Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.", getSearchKeyboard());
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            // Сообщение уже такое же, это нормально
        } else {
            await ctx.reply("Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.", getSearchKeyboard());
        }
    }
});

bot.action("another_dish", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);
    console.log(`User ${chatId} state:`, state);

    // Сбрасываем флаг запрошенного рецепта при выборе нового блюда
    if (state === 1) resetRecipeRequested(chatId, 'breakfast');
    else if (state === 2) resetRecipeRequested(chatId, 'dinner');
    else if (state === 3) resetRecipeRequested(chatId, 'lunch');
    else if (state === 4) resetRecipeRequested(chatId, 'search');

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
                try {
                    await ctx.editMessageText("Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.", getSearchKeyboard());
                } catch (error) {
                    if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
                        // Сообщение уже такое же, это нормально
                    } else {
                        await ctx.reply("Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.", getSearchKeyboard());
                    }
                }                return;
            }
            break;
        default:
            await ctx.answerCbQuery("Сначала выберите тип блюда");
            return;
    }

    // Определяем, был ли запрошен рецепт для текущего типа блюда
    let recipeRequested = false;
    if (state === 1) recipeRequested = isRecipeRequested(chatId, 'breakfast');
    else if (state === 2) recipeRequested = isRecipeRequested(chatId, 'dinner');
    else if (state === 3) recipeRequested = isRecipeRequested(chatId, 'lunch');
    else if (state === 4) recipeRequested = isRecipeRequested(chatId, 'search');

    try {
        await ctx.editMessageText(messageText, getDetailedMenuKeyboard(recipeRequested));
    } catch (error) {
        // Если сообщение не изменилось (такой же результат), это нормально
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            // Другая ошибка - отправляем новое сообщение
            await ctx.reply(messageText, getDetailedMenuKeyboard(recipeRequested));
        }
    }
    await ctx.answerCbQuery();
});

bot.action("ingredients", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    const state = getUserState(chatId);

    // Проверяем, не был ли уже запрошен рецепт
    let dishType = '';
    if (state === 1) dishType = 'breakfast';
    else if (state === 2) dishType = 'dinner';
    else if (state === 3) dishType = 'lunch';
    else if (state === 4) dishType = 'search';

    if (dishType && isRecipeRequested(chatId, dishType)) {
        await ctx.answerCbQuery("Рецепт уже был показан. Выберите другое блюдо для нового рецепта.");
        return;
    }

    // Сразу отвечаем на callback query, чтобы избежать таймаута
    try {
        await ctx.answerCbQuery("Загрузка рецепта...");
    } catch (e) {
        // Игнорируем ошибки, если callback уже истек
        console.log('Callback query уже истек, продолжаем...');
    }

    try {
        switch (state) {
            case 1:
                await getFullRecepie(ctx, userHrefs);
                setRecipeRequested(chatId, 'breakfast');
                break;
            case 2:
                await getFullRecepieDinner(ctx, userHrefs);
                setRecipeRequested(chatId, 'dinner');
                break;
            case 3:
                await getFullRecepieLunch(ctx, userHrefs);
                setRecipeRequested(chatId, 'lunch');
                break;
            case 4:
                await getFullRecepieSearch(ctx, userHrefs);
                setRecipeRequested(chatId, 'search');
                break;
            default:
                await ctx.reply("Сначала выберите завтрак, обед или ужин.");
                break;
        }
    } catch (error) {
        console.error('Ошибка при получении рецепта:', error);
        try {
            await ctx.reply("Произошла ошибка при получении рецепта. Попробуйте еще раз.");
        } catch (e) {
            // Игнорируем ошибки отправки сообщения
        }
    }
});

// Обработчик для отключенной кнопки
bot.action("ingredients_disabled", async (ctx) => {
    await ctx.answerCbQuery("Рецепт уже был показан. Выберите другое блюдо для нового рецепта.");
});

bot.action("back_to_main", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    resetUserState(chatId);
    resetUserHrefs(chatId);
    try {
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
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            // Сообщение уже такое же, это нормально
        } else {
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
        }
    }
    await ctx.answerCbQuery();
});

bot.action("close_menu", async (ctx) => {
    const chatId = ctx.chat.id;
    try {
        await ctx.editMessageText("Меню закрыто", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Запуск✅", callback_data: "start_bot" }]
                ]
            }
        });
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            // Сообщение уже такое же, это нормально
        } else {
            await ctx.reply("Меню закрыто", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Запуск✅", callback_data: "start_bot" }]
                    ]
                }
            });
        }
    }
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
                // Удаляем reply keyboard после ввода запроса (если есть)
                try {
                    await ctx.telegram.sendMessage(chatId, "🔍 Ищу рецепты...", {
                        reply_markup: {
                            remove_keyboard: true
                        }
                    }).catch(() => {
                        // Игнорируем ошибку отправки
                    });
                } catch (kbError) {
                    // Игнорируем ошибку, если клавиатуры нет
                    console.log('Клавиатура уже удалена или не была установлена');
                }

                // Сохраняем поисковый запрос для повторного использования
                userSearchQueries.set(chatId, searchQuery);

                const searchResult = await search(ctx, userHrefs, searchQuery);

                if (searchResult && typeof searchResult === 'string') {
                    console.log('🔍 Результат поиска:', searchResult.length > 100 ? searchResult.substring(0, 100) + '...' : searchResult);
                    const recipeRequested = isRecipeRequested(chatId, 'search');
                    await ctx.reply(searchResult, getDetailedMenuKeyboard(recipeRequested));
                } else {
                    console.error('❌ Неожиданный результат поиска:', searchResult);
                    await ctx.reply('Произошла ошибка при поиске. Попробуйте позже.');
                }
            } catch (error) {
                console.error('❌ Ошибка при поиске:', error);
                console.error('❌ Stack trace:', error.stack);
                await ctx.reply('Произошла ошибка при поиске. Попробуйте позже.');
            }
        }
        return;
    }

    // Обрабатывать только текстовые сообщения, не связанные с кнопками
    // Кнопки теперь обрабатываются через bot.action()
});
// Инициализируем браузер при старте бота
initBrowser()
  .then(() => {
    return bot.launch();
  })
  .then(() => {
    console.log('✅ Бот успешно запущен!');
  })
  .catch((err) => {
    console.error('❌ Ошибка при запуске бота:', err);
    process.exit(1);
  });

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n🛑 Получен сигнал ${signal}, завершаем работу...`);
  try {
    await bot.stop(signal);
    await closeBrowser();
    console.log('✅ Бот и браузер успешно остановлены');
    process.exit(0);
  } catch (err) {
    console.error('❌ Ошибка при завершении работы:', err);
    process.exit(1);
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));