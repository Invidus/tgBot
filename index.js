import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { getDetailedMenuKeyboard, getSearchKeyboard, getStepNavigationKeyboard, getFavoritesKeyboard, getFavoriteRecipeKeyboard } from "./innerButtons.js";
import { getBreakFast, getFullRecepie } from "./breakfast.js";
import { getDinner, getFullRecepieDinner } from "./dinner.js";
import { getLunch, getFullRecepieLunch } from "./lunch.js";
import { search, getFullRecepieSearch } from "./search.js";
import { initBrowser, closeBrowser } from "./browserManager.js";
import { checkRateLimit } from "./rateLimiter.js";
import { getStepByStepRecipe } from "./stepByStepRecipe.js";
import { validateAndTruncateMessage } from "./messageUtils.js";
import { initTables, closePool, checkTableExists } from "./dataBase.js";
import {
  addToFavorites,
  isInFavorites,
  removeFromFavorites,
  getFavorites,
  getFavoritesCount,
  getFavoriteById,
  removeFromFavoritesById
} from "./favoritesService.js";

// TTL(time to live) очистка старых записей
const USER_DATA_TTL = 24 * 60 * 60 * 1000;
const userLastActivity = new Map(); // Отслеживание последней активности

// Хранилище ссылок на рецепты для каждого пользователя: chatId -> { breakfast: url, lunch: url, dinner: url }
const userHrefs = new Map();

// Хранилище последних поисковых запросов: chatId -> searchQuery
const userSearchQueries = new Map();

// Хранилище флагов запрошенных рецептов: chatId -> { breakfast: boolean, lunch: boolean, dinner: boolean, search: boolean }
const userRecipeRequested = new Map();

// Хранилище пошаговых рецептов: chatId -> { steps: Array, currentStep: number, dishMessageId: number, dishMessageText: string }
const userStepByStepRecipes = new Map();

// Хранилище истории рецептов: chatId -> { dishType: [{ url, text, hasPhoto, photoFileId }] }
// Ограничение: максимум 10 рецептов на тип блюда для оптимизации памяти
const userRecipeHistory = new Map();
const MAX_HISTORY_SIZE = 10;

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

// Функции для работы с историей рецептов (оптимизированы для скорости)
const saveRecipeToHistory = (chatId, dishType, url, text, hasPhoto = false, photoFileId = null) => {
    if (!url || !text) return; // Пропускаем пустые данные

    let history = userRecipeHistory.get(chatId);
    if (!history) {
        history = { breakfast: [], lunch: [], dinner: [], search: [] };
        userRecipeHistory.set(chatId, history);
    }

    if (!history[dishType]) {
        history[dishType] = [];
    }

    // Добавляем в конец (последний рецепт)
    history[dishType].push({ url, text, hasPhoto, photoFileId });

    // Ограничиваем размер истории для оптимизации памяти
    if (history[dishType].length > MAX_HISTORY_SIZE) {
        history[dishType].shift(); // Удаляем самый старый
    }
};

const getPreviousRecipe = (chatId, dishType) => {
    const history = userRecipeHistory.get(chatId);
    if (!history || !history[dishType] || history[dishType].length === 0) {
        return null;
    }
    // Получаем последний рецепт из истории и удаляем его (LIFO)
    // НЕ сохраняем текущий рецепт обратно - это предотвращает цикл
    return history[dishType].pop();
};

const hasRecipeHistory = (chatId, dishType) => {
    const history = userRecipeHistory.get(chatId);
    return history && history[dishType] && history[dishType].length > 0;
};

// Вспомогательные функции для работы с hrefOnProduct
const resetUserHrefs = (chatId) => {
    userHrefs.delete(chatId);
    userSearchQueries.delete(chatId);
    userRecipeRequested.delete(chatId);
    userStepByStepRecipes.delete(chatId);
    userRecipeHistory.delete(chatId);
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
        userStepByStepRecipes.delete(chatId);
        userRecipeHistory.delete(chatId);
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

// Вспомогательная функция для получения клавиатуры с проверкой избранного
const getDetailedMenuKeyboardWithFavorites = async (chatId, recipeUrl, recipeRequested, hasHistory) => {
  try {
    const inFavorites = await isInFavorites(chatId, recipeUrl);
    return getDetailedMenuKeyboard(recipeRequested, hasHistory, inFavorites);
  } catch (error) {
    console.error('Ошибка проверки избранного:', error);
    // В случае ошибки показываем клавиатуру без избранного
    return getDetailedMenuKeyboard(recipeRequested, hasHistory, false);
  }
};

// Функция для показа меню выбора типа блюда
const showDishTypeMenu = async (ctx, message = "Выберите тип блюда:") => {
    try {
        await ctx.editMessageText(message, {
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
        // Если не удалось отредактировать сообщение, отправляем новое
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            // Сообщение уже такое же, это нормально
        } else {
            await ctx.reply(message, {
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
    const favoritesCount = await getFavoritesCount(chatId).catch(() => 0);
    await ctx.reply("Выберите действие", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Завтрак🍏", callback_data: "breakfast" }],
                [{ text: "Обед🍜", callback_data: "dinner" }],
                [{ text: "Ужин🍝", callback_data: "lunch" }],
                [{ text: "Поиск🔎", callback_data: "search" }],
                [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
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

    // Сохраняем текущий рецепт в историю перед получением нового
    const currentMessage = ctx.callbackQuery?.message;
    const prevUrl = userHrefs.get(chatId)?.breakfast;
    if (prevUrl && currentMessage) {
        const currentText = currentMessage.text || currentMessage.caption || '';
        if (currentText.trim()) {
            const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
            const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
            saveRecipeToHistory(chatId, 'breakfast', prevUrl, currentText, hasPhoto, photoFileId);
        }
    }

    resetRecipeRequested(chatId, 'breakfast'); // Сбрасываем флаг при выборе нового блюда
        let breakfast = await getBreakFast(ctx, userHrefs);
    const recipeRequested = isRecipeRequested(chatId, 'breakfast');
    const hasHistory = hasRecipeHistory(chatId, 'breakfast');
    const recipeUrl = userHrefs.get(chatId)?.breakfast;
    const keyboard = recipeUrl ? await getDetailedMenuKeyboardWithFavorites(chatId, recipeUrl, recipeRequested, hasHistory) : getDetailedMenuKeyboard(recipeRequested, hasHistory, false);
    try {
        await ctx.editMessageText(breakfast, keyboard);
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            await ctx.reply(breakfast, keyboard);
        }
    }
        setUserState(chatId, 1);
});

bot.action("dinner", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    // Сохраняем текущий рецепт в историю перед получением нового
    const currentMessage = ctx.callbackQuery?.message;
    const prevUrl = userHrefs.get(chatId)?.dinner;
    if (prevUrl && currentMessage) {
        const currentText = currentMessage.text || currentMessage.caption || '';
        if (currentText.trim()) {
            const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
            const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
            saveRecipeToHistory(chatId, 'dinner', prevUrl, currentText, hasPhoto, photoFileId);
        }
    }

    resetRecipeRequested(chatId, 'dinner'); // Сбрасываем флаг при выборе нового блюда
        setUserState(chatId, 2);
        let dinner = await getDinner(ctx, userHrefs);
    const recipeRequested = isRecipeRequested(chatId, 'dinner');
    const hasHistory = hasRecipeHistory(chatId, 'dinner');
    const recipeUrl = userHrefs.get(chatId)?.dinner;
    const keyboard = recipeUrl ? await getDetailedMenuKeyboardWithFavorites(chatId, recipeUrl, recipeRequested, hasHistory) : getDetailedMenuKeyboard(recipeRequested, hasHistory, false);
    try {
        await ctx.editMessageText(dinner, keyboard);
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            await ctx.reply(dinner, keyboard);
        }
    }
});

bot.action("lunch", async (ctx) => {
    await ctx.answerCbQuery("Загрузка...", true);
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    // Сохраняем текущий рецепт в историю перед получением нового
    const currentMessage = ctx.callbackQuery?.message;
    const prevUrl = userHrefs.get(chatId)?.lunch;
    if (prevUrl && currentMessage) {
        const currentText = currentMessage.text || currentMessage.caption || '';
        if (currentText.trim()) {
            const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
            const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
            saveRecipeToHistory(chatId, 'lunch', prevUrl, currentText, hasPhoto, photoFileId);
        }
    }

    resetRecipeRequested(chatId, 'lunch'); // Сбрасываем флаг при выборе нового блюда
        setUserState(chatId, 3);
        let lunch = await getLunch(ctx, userHrefs);
    const recipeRequested = isRecipeRequested(chatId, 'lunch');
    const hasHistory = hasRecipeHistory(chatId, 'lunch');
    const recipeUrl = userHrefs.get(chatId)?.lunch;
    const keyboard = recipeUrl ? await getDetailedMenuKeyboardWithFavorites(chatId, recipeUrl, recipeRequested, hasHistory) : getDetailedMenuKeyboard(recipeRequested, hasHistory, false);
    try {
        await ctx.editMessageText(lunch, keyboard);
    } catch (error) {
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            await ctx.reply(lunch, keyboard);
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

    // Определяем тип блюда
    let dishType = '';
    if (state === 1) dishType = 'breakfast';
    else if (state === 2) dishType = 'dinner';
    else if (state === 3) dishType = 'lunch';
    else if (state === 4) dishType = 'search';

    // Сохраняем текущий рецепт в историю перед получением нового
    const currentMessage = ctx.callbackQuery?.message;
    const prevUrl = dishType ? userHrefs.get(chatId)?.[dishType] : null;
    if (prevUrl && currentMessage && dishType) {
        const currentText = currentMessage.text || currentMessage.caption || '';
        if (currentText.trim()) {
            const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
            const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
            saveRecipeToHistory(chatId, dishType, prevUrl, currentText, hasPhoto, photoFileId);
        }
    }

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
            await ctx.answerCbQuery();
            await showDishTypeMenu(ctx, "Сначала выберите тип блюда:");
            return;
    }

    // Определяем, был ли запрошен рецепт для текущего типа блюда
    let recipeRequested = false;
    if (state === 1) recipeRequested = isRecipeRequested(chatId, 'breakfast');
    else if (state === 2) recipeRequested = isRecipeRequested(chatId, 'dinner');
    else if (state === 3) recipeRequested = isRecipeRequested(chatId, 'lunch');
    else if (state === 4) recipeRequested = isRecipeRequested(chatId, 'search');

    // Проверяем наличие истории
    const hasHistory = dishType ? hasRecipeHistory(chatId, dishType) : false;

    // Получаем URL текущего рецепта для проверки избранного
    const recipeUrl = dishType ? userHrefs.get(chatId)?.[dishType] : null;
    const keyboard = recipeUrl ? await getDetailedMenuKeyboardWithFavorites(chatId, recipeUrl, recipeRequested, hasHistory) : getDetailedMenuKeyboard(recipeRequested, hasHistory, false);

    // Валидируем и обрезаем сообщение при необходимости
    messageText = validateAndTruncateMessage(messageText);
    try {
        await ctx.editMessageText(messageText, keyboard);
    } catch (error) {
        // Если сообщение не изменилось (такой же результат), это нормально
        if (error.response?.error_code === 400 && error.response?.description?.includes('message is not modified')) {
            await ctx.answerCbQuery("Показан тот же результат. Попробуйте еще раз.");
        } else {
            // Другая ошибка - отправляем новое сообщение
            await ctx.reply(messageText, keyboard);
        }
    }
    await ctx.answerCbQuery();
});

// Обработчик для возврата к предыдущему рецепту
bot.action("previous_recipe", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);

    let dishType = '';
    if (state === 1) dishType = 'breakfast';
    else if (state === 2) dishType = 'dinner';
    else if (state === 3) dishType = 'lunch';
    else if (state === 4) dishType = 'search';

    if (!dishType) {
        await ctx.answerCbQuery();
        await showDishTypeMenu(ctx, "Сначала выберите тип блюда:");
        return;
    }

    // Получаем предыдущий рецепт из истории
    // ВАЖНО: НЕ сохраняем текущий рецепт в историю здесь, чтобы избежать циклического переключения
    // Текущий рецепт сохраняется только при нажатии "Другое блюдо" или выборе нового типа блюда
    const previousRecipe = getPreviousRecipe(chatId, dishType);

    if (!previousRecipe) {
        await ctx.answerCbQuery("Нет предыдущих рецептов.");
        return;
    }

    // Восстанавливаем предыдущий рецепт
    if (!userHrefs.has(chatId)) {
        userHrefs.set(chatId, {});
    }
    userHrefs.get(chatId)[dishType] = previousRecipe.url;
    resetRecipeRequested(chatId, dishType);

    // Проверяем, есть ли еще история
    const hasHistory = hasRecipeHistory(chatId, dishType);
    const recipeRequested = isRecipeRequested(chatId, dishType);

    try {
        // Используем сохраненный текст для быстрого отображения
        const recipeText = validateAndTruncateMessage(previousRecipe.text || 'Меню блюда');
        const keyboard = getDetailedMenuKeyboard(recipeRequested, hasHistory);

        if (previousRecipe.hasPhoto && previousRecipe.photoFileId) {
            // Если был фото, пытаемся отредактировать медиа
            try {
                await ctx.telegram.editMessageMedia(
                    chatId,
                    ctx.callbackQuery.message.message_id,
                    null,
                    {
                        type: 'photo',
                        media: previousRecipe.photoFileId,
                        caption: recipeText
                    },
                    {
                        reply_markup: keyboard.reply_markup
                    }
                );
            } catch (e) {
                // Если не удалось отредактировать медиа, удаляем и отправляем новое
                try {
                    await ctx.deleteMessage();
                } catch (e2) {
                    // Игнорируем ошибки
                }
                await ctx.replyWithPhoto(previousRecipe.photoFileId, {
                    caption: recipeText,
                    reply_markup: keyboard.reply_markup
                });
            }
        } else {
            // Если не было фото, редактируем текст
            try {
                await ctx.editMessageText(recipeText, keyboard);
            } catch (e) {
                // Если не удалось отредактировать, отправляем новое
                try {
                    await ctx.deleteMessage();
                } catch (e2) {
                    // Игнорируем ошибки
                }
                await ctx.reply(recipeText, keyboard);
            }
        }
    } catch (error) {
        console.error('Ошибка при возврате к предыдущему рецепту:', error);
        await ctx.answerCbQuery("Ошибка при возврате к предыдущему рецепту.");
    }

    await ctx.answerCbQuery();
});

// Обработчик для добавления в избранное
bot.action("add_to_favorites", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);

    let dishType = '';
    let hrefOnProduct = null;
    if (state === 1) {
        dishType = 'breakfast';
        hrefOnProduct = userHrefs.get(chatId)?.breakfast;
    } else if (state === 2) {
        dishType = 'dinner';
        hrefOnProduct = userHrefs.get(chatId)?.dinner;
    } else if (state === 3) {
        dishType = 'lunch';
        hrefOnProduct = userHrefs.get(chatId)?.lunch;
    } else if (state === 4) {
        dishType = 'search';
        hrefOnProduct = userHrefs.get(chatId)?.search;
    }

    if (!hrefOnProduct) {
        await ctx.answerCbQuery("Сначала выберите блюдо из меню.");
        return;
    }

    const currentMessage = ctx.callbackQuery?.message;
    const recipeText = currentMessage?.text || currentMessage?.caption || '';
    const recipeTitle = recipeText.split('\n')[0] || 'Рецепт без названия';
    const hasPhoto = !!(currentMessage?.photo && currentMessage?.photo.length > 0);
    const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;

    try {
        const added = await addToFavorites(chatId, {
            url: hrefOnProduct,
            title: recipeTitle,
            text: recipeText,
            dishType: dishType,
            hasPhoto: hasPhoto,
            photoFileId: photoFileId
        });

        if (added) {
            await ctx.answerCbQuery("✅ Добавлено в избранное!");
            // Обновляем клавиатуру
            const recipeRequested = isRecipeRequested(chatId, dishType);
            const hasHistory = hasRecipeHistory(chatId, dishType);
            const keyboard = await getDetailedMenuKeyboardWithFavorites(chatId, hrefOnProduct, recipeRequested, hasHistory);

            try {
                if (hasPhoto && photoFileId) {
                    await ctx.telegram.editMessageCaption(
                        chatId,
                        currentMessage.message_id,
                        null,
                        recipeText,
                        keyboard
                    );
                } else {
                    await ctx.editMessageText(recipeText, keyboard);
                }
            } catch (e) {
                // Игнорируем ошибки редактирования
            }
        } else {
            await ctx.answerCbQuery("Рецепт уже в избранном");
        }
    } catch (error) {
        console.error('Ошибка добавления в избранное:', error);
        await ctx.answerCbQuery("❌ Ошибка при добавлении в избранное");
    }
});

// Обработчик для удаления из избранного
bot.action("remove_from_favorites", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const state = getUserState(chatId);

    let hrefOnProduct = null;
    let dishType = '';
    if (state === 1) {
        dishType = 'breakfast';
        hrefOnProduct = userHrefs.get(chatId)?.breakfast;
    } else if (state === 2) {
        dishType = 'dinner';
        hrefOnProduct = userHrefs.get(chatId)?.dinner;
    } else if (state === 3) {
        dishType = 'lunch';
        hrefOnProduct = userHrefs.get(chatId)?.lunch;
    } else if (state === 4) {
        dishType = 'search';
        hrefOnProduct = userHrefs.get(chatId)?.search;
    }

    if (!hrefOnProduct) {
        await ctx.answerCbQuery("Сначала выберите блюдо из меню.");
        return;
    }

    try {
        const removed = await removeFromFavorites(chatId, hrefOnProduct);

        if (removed) {
            await ctx.answerCbQuery("❌ Удалено из избранного");
            // Обновляем клавиатуру
            const currentMessage = ctx.callbackQuery?.message;
            const recipeText = currentMessage?.text || currentMessage?.caption || '';
            const recipeRequested = isRecipeRequested(chatId, dishType);
            const hasHistory = hasRecipeHistory(chatId, dishType);
            const keyboard = await getDetailedMenuKeyboardWithFavorites(chatId, hrefOnProduct, recipeRequested, hasHistory);

            try {
                const hasPhoto = !!(currentMessage?.photo && currentMessage?.photo.length > 0);
                if (hasPhoto) {
                    await ctx.telegram.editMessageCaption(
                        chatId,
                        currentMessage.message_id,
                        null,
                        recipeText,
                        keyboard
                    );
                } else {
                    await ctx.editMessageText(recipeText, keyboard);
                }
            } catch (e) {
                // Игнорируем ошибки редактирования
            }
        } else {
            await ctx.answerCbQuery("Рецепт не найден в избранном");
        }
    } catch (error) {
        console.error('Ошибка удаления из избранного:', error);
        await ctx.answerCbQuery("❌ Ошибка при удалении из избранного");
    }
});

// Обработчик для просмотра списка избранного
bot.action("favorites_list", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    await ctx.answerCbQuery("Загрузка избранного...");

    try {
        const favorites = await getFavorites(chatId, 50, 0);

        if (!favorites || favorites.length === 0) {
            const emptyMessage = "⭐ Ваше избранное пусто.\n\nДобавьте рецепты в избранное, нажав кнопку '⭐ Добавить в избранное' на странице рецепта.";
            try {
                await ctx.editMessageText(emptyMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }]
                        ]
                    }
                });
            } catch (e) {
                await ctx.reply(emptyMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }]
                        ]
                    }
                });
            }
            return;
        }

        // Сохраняем список избранного для пользователя (для пагинации)
        if (!userFavoritesLists.has(chatId)) {
            userFavoritesLists.set(chatId, {});
        }
        userFavoritesLists.get(chatId).list = favorites;
        userFavoritesLists.get(chatId).currentPage = 0;

        const keyboard = getFavoritesKeyboard(favorites, 0, 5);

        let message = `⭐ Избранное (${favorites.length} рецептов):\n\n`;
        const pageFavorites = favorites.slice(0, 5);
        pageFavorites.forEach((fav, index) => {
            message += `${index + 1}. ${fav.recipe_title}\n`;
        });
        if (favorites.length > 5) {
            message += `\nПоказано 5 из ${favorites.length} рецептов`;
        }

        message = validateAndTruncateMessage(message);

        try {
            await ctx.editMessageText(message, keyboard);
        } catch (e) {
            // Если не удалось отредактировать, отправляем новое
            await ctx.reply(message, keyboard);
        }
    } catch (error) {
        console.error('Ошибка получения избранного:', error);
        await ctx.reply("❌ Ошибка при загрузке избранного. Попробуйте позже.");
    }
});

// Хранилище списков избранного для пагинации
const userFavoritesLists = new Map();

// Обработчик для просмотра рецепта из избранного
bot.action(/^favorite_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const favoriteId = parseInt(ctx.match[1]);

    await ctx.answerCbQuery("Загрузка рецепта...");

    try {
        const favorite = await getFavoriteById(chatId, favoriteId);

        if (!favorite) {
            await ctx.reply("❌ Рецепт не найден в избранном.");
            return;
        }

        // Сохраняем URL в userHrefs для работы с ингредиентами и пошаговым рецептом
        if (!userHrefs.has(chatId)) {
            userHrefs.set(chatId, {});
        }
        userHrefs.get(chatId).favorite = favorite.recipe_url;

        const recipeText = validateAndTruncateMessage(favorite.recipe_text || favorite.recipe_title);
        const keyboard = getFavoriteRecipeKeyboard(favoriteId);

        if (favorite.has_photo && favorite.photo_file_id) {
            await ctx.replyWithPhoto(favorite.photo_file_id, {
                caption: recipeText,
                reply_markup: keyboard.reply_markup
            });
        } else {
            await ctx.reply(recipeText, keyboard);
        }
    } catch (error) {
        console.error('Ошибка получения рецепта из избранного:', error);
        await ctx.reply("❌ Ошибка при загрузке рецепта.");
    }
});

// Обработчик для удаления из избранного из списка
bot.action(/^remove_favorite_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const favoriteId = parseInt(ctx.match[1]);

    try {
        const removed = await removeFromFavoritesById(chatId, favoriteId);

        if (removed) {
            await ctx.answerCbQuery("❌ Удалено из избранного");
            // Обновляем список избранного
            const favorites = await getFavorites(chatId, 50, 0);
            const favoritesData = userFavoritesLists.get(chatId);
            const currentPage = favoritesData?.currentPage || 0;

            if (!favorites || favorites.length === 0) {
                await ctx.editMessageText("⭐ Ваше избранное пусто.\n\nДобавьте рецепты в избранное, нажав кнопку '⭐ Добавить в избранное' на странице рецепта.", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }]
                        ]
                    }
                });
                return;
            }

            userFavoritesLists.set(chatId, { list: favorites, currentPage: currentPage });
            const keyboard = getFavoritesKeyboard(favorites, currentPage, 5);

            let message = `⭐ Избранное (${favorites.length} рецептов):\n\n`;
            const startIndex = currentPage * 5;
            const endIndex = Math.min(startIndex + 5, favorites.length);
            const pageFavorites = favorites.slice(startIndex, endIndex);
            pageFavorites.forEach((fav, index) => {
                message += `${startIndex + index + 1}. ${fav.recipe_title}\n`;
            });
            if (favorites.length > 5) {
                message += `\nПоказано ${endIndex} из ${favorites.length} рецептов`;
            }

            message = validateAndTruncateMessage(message);
            await ctx.editMessageText(message, keyboard);
        } else {
            await ctx.answerCbQuery("Рецепт не найден в избранном");
        }
    } catch (error) {
        console.error('Ошибка удаления из избранного:', error);
        await ctx.answerCbQuery("❌ Ошибка при удалении из избранного");
    }
});

// Обработчик для пагинации избранного
bot.action(/^favorites_page_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const page = parseInt(ctx.match[1]);

    await ctx.answerCbQuery();

    try {
        const favoritesData = userFavoritesLists.get(chatId);
        if (!favoritesData || !favoritesData.list) {
            // Если список не сохранен, загружаем заново
            const favorites = await getFavorites(chatId, 50, 0);
            userFavoritesLists.set(chatId, { list: favorites, currentPage: page });
            const keyboard = getFavoritesKeyboard(favorites, page, 5);

            let message = `⭐ Избранное (${favorites.length} рецептов):\n\n`;
            const startIndex = page * 5;
            const endIndex = Math.min(startIndex + 5, favorites.length);
            const pageFavorites = favorites.slice(startIndex, endIndex);
            pageFavorites.forEach((fav, index) => {
                message += `${startIndex + index + 1}. ${fav.recipe_title}\n`;
            });
            if (favorites.length > 5) {
                message += `\nПоказано ${endIndex} из ${favorites.length} рецептов`;
            }

            message = validateAndTruncateMessage(message);
            await ctx.editMessageText(message, keyboard);
            return;
        }

        const favorites = favoritesData.list;
        userFavoritesLists.set(chatId, { list: favorites, currentPage: page });
        const keyboard = getFavoritesKeyboard(favorites, page, 5);

        let message = `⭐ Избранное (${favorites.length} рецептов):\n\n`;
        const startIndex = page * 5;
        const endIndex = Math.min(startIndex + 5, favorites.length);
        const pageFavorites = favorites.slice(startIndex, endIndex);
        pageFavorites.forEach((fav, index) => {
            message += `${startIndex + index + 1}. ${fav.recipe_title}\n`;
        });
        if (favorites.length > 5) {
            message += `\nПоказано ${endIndex} из ${favorites.length} рецептов`;
        }

        message = validateAndTruncateMessage(message);
        await ctx.editMessageText(message, keyboard);
    } catch (error) {
        console.error('Ошибка пагинации избранного:', error);
        await ctx.answerCbQuery("❌ Ошибка при загрузке страницы");
    }
});

// Обработчик для ингредиентов из избранного
bot.action(/^favorite_ingredients_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const favoriteId = parseInt(ctx.match[1]);

    // Проверка rate limit
    if (!checkRateLimit(chatId)) {
        await ctx.answerCbQuery("Слишком много запросов. Подождите минуту и попробуйте снова.");
        return;
    }

    try {
        const favorite = await getFavoriteById(chatId, favoriteId);
        if (!favorite) {
            await ctx.answerCbQuery("Рецепт не найден в избранном.");
            return;
        }

        // Сохраняем URL для получения ингредиентов
        if (!userHrefs.has(chatId)) {
            userHrefs.set(chatId, {});
        }
        userHrefs.get(chatId).favorite = favorite.recipe_url;

        // Определяем тип блюда для выбора правильной функции
        let getFullRecepieFunc = null;
        if (favorite.dish_type === 'breakfast') {
            getFullRecepieFunc = getFullRecepie;
            userHrefs.get(chatId).breakfast = favorite.recipe_url;
        } else if (favorite.dish_type === 'dinner') {
            getFullRecepieFunc = getFullRecepieDinner;
            userHrefs.get(chatId).dinner = favorite.recipe_url;
        } else if (favorite.dish_type === 'lunch') {
            getFullRecepieFunc = getFullRecepieLunch;
            userHrefs.get(chatId).lunch = favorite.recipe_url;
        } else if (favorite.dish_type === 'search') {
            getFullRecepieFunc = getFullRecepieSearch;
            userHrefs.get(chatId).search = favorite.recipe_url;
        }

        if (!getFullRecepieFunc) {
            await ctx.answerCbQuery("Не удалось определить тип рецепта.");
            return;
        }

        await ctx.answerCbQuery("Загрузка рецепта...");
        let loadingMessage = await ctx.reply("⏳ Загрузка рецепта...");

        await getFullRecepieFunc(ctx, userHrefs, loadingMessage);
    } catch (error) {
        console.error('Ошибка получения ингредиентов из избранного:', error);
        await ctx.answerCbQuery("❌ Ошибка при загрузке рецепта");
    }
});

// Обработчик для пошагового рецепта из избранного
bot.action(/^favorite_step_by_step_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
    const favoriteId = parseInt(ctx.match[1]);

    // Проверка rate limit
    if (!checkRateLimit(chatId)) {
        await ctx.answerCbQuery("Слишком много запросов. Подождите минуту и попробуйте снова.");
        return;
    }

    try {
        const favorite = await getFavoriteById(chatId, favoriteId);
        if (!favorite) {
            await ctx.answerCbQuery("Рецепт не найден в избранном.");
            return;
        }

        await ctx.answerCbQuery("Загрузка пошагового рецепта...");
        let loadingMessage = await ctx.reply("⏳ Загрузка пошагового рецепта...");

        const steps = await getStepByStepRecipe(favorite.recipe_url);

        if (!steps || steps.length === 0) {
            if (loadingMessage) {
                try {
                    await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
                } catch (e) {}
            }
            await ctx.reply("Не удалось получить пошаговый рецепт. Попробуйте еще раз.");
            return;
        }

        // Сохраняем шаги для навигации
        const dishMessageId = ctx.callbackQuery?.message?.message_id;
        const dishMessageText = ctx.callbackQuery?.message?.text || ctx.callbackQuery?.message?.caption || '';
        const hasPhoto = !!(ctx.callbackQuery?.message?.photo && ctx.callbackQuery?.message?.photo.length > 0);
        const dishPhotoFileId = hasPhoto ? ctx.callbackQuery?.message?.photo[ctx.callbackQuery?.message?.photo.length - 1]?.file_id : null;

        userStepByStepRecipes.set(chatId, {
            steps: steps,
            currentStep: 0,
            dishMessageId: dishMessageId,
            dishMessageText: dishMessageText,
            hasPhoto: hasPhoto,
            dishPhotoFileId: dishPhotoFileId,
            isNavigating: false,
            returnToFavorites: true,
            favoriteId: favoriteId
        });

        await displayStep(ctx, chatId, 0, steps, loadingMessage);
    } catch (error) {
        console.error('Ошибка получения пошагового рецепта из избранного:', error);
        await ctx.answerCbQuery("❌ Ошибка при загрузке пошагового рецепта");
    }
});

// Обработчик для неактивной кнопки информации о странице
bot.action("favorites_info", async (ctx) => {
    await ctx.answerCbQuery(); // Просто убираем индикатор загрузки
});

bot.action("ingredients", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    // Проверка rate limit
    if (!checkRateLimit(chatId)) {
        await ctx.answerCbQuery("Слишком много запросов. Подождите минуту и попробуйте снова.");
        return;
    }

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

    // Отправляем уведомление о загрузке
    let loadingMessage = null;
    try {
        loadingMessage = await ctx.reply("⏳ Загрузка рецепта...");
    } catch (e) {
        console.error('Ошибка отправки уведомления о загрузке:', e);
    }

    try {
        switch (state) {
            case 1:
                await getFullRecepie(ctx, userHrefs, loadingMessage);
                setRecipeRequested(chatId, 'breakfast');
                break;
            case 2:
                await getFullRecepieDinner(ctx, userHrefs, loadingMessage);
                setRecipeRequested(chatId, 'dinner');
                break;
            case 3:
                await getFullRecepieLunch(ctx, userHrefs, loadingMessage);
                setRecipeRequested(chatId, 'lunch');
                break;
            case 4:
                await getFullRecepieSearch(ctx, userHrefs, loadingMessage);
                setRecipeRequested(chatId, 'search');
                break;
            default:
                // Удаляем сообщение о загрузке, если оно было отправлено
                if (loadingMessage) {
                    try {
                        await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
                    } catch (e) {
                        // Игнорируем ошибки удаления
                    }
                }
                await showDishTypeMenu(ctx, "Сначала выберите тип блюда:");
                break;
        }
    } catch (error) {
        console.error('Ошибка при получении рецепта:', error);
        // Удаляем сообщение о загрузке при ошибке
        if (loadingMessage) {
            try {
                await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
            } catch (e) {
                // Игнорируем ошибки удаления
            }
        }
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

// Обработчик для пошагового рецепта
bot.action("step_by_step", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    // Проверка rate limit
    if (!checkRateLimit(chatId)) {
        await ctx.answerCbQuery("Слишком много запросов. Подождите минуту и попробуйте снова.");
        return;
    }

    const state = getUserState(chatId);
    let hrefOnProduct = null;
    let dishType = '';

    // Получаем ссылку на рецепт в зависимости от состояния
    if (state === 1) {
        hrefOnProduct = userHrefs.get(chatId)?.breakfast;
        dishType = 'breakfast';
    } else if (state === 2) {
        hrefOnProduct = userHrefs.get(chatId)?.dinner;
        dishType = 'dinner';
    } else if (state === 3) {
        hrefOnProduct = userHrefs.get(chatId)?.lunch;
        dishType = 'lunch';
    } else if (state === 4) {
        hrefOnProduct = userHrefs.get(chatId)?.search;
        dishType = 'search';
    }

    if (!hrefOnProduct) {
        await ctx.answerCbQuery();
        await showDishTypeMenu(ctx, "Сначала выберите тип блюда:");
        return;
    }

    // Сохраняем message_id, текст и информацию о фото исходного сообщения с блюдом для возврата назад
    const dishMessageId = ctx.callbackQuery?.message?.message_id;
    const dishMessageText = ctx.callbackQuery?.message?.text || ctx.callbackQuery?.message?.caption || '';
    const hasPhoto = !!(ctx.callbackQuery?.message?.photo && ctx.callbackQuery?.message?.photo.length > 0);
    // Сохраняем file_id самого большого фото (последний элемент массива)
    const dishPhotoFileId = hasPhoto ? ctx.callbackQuery?.message?.photo[ctx.callbackQuery?.message?.photo.length - 1]?.file_id : null;

    // Сразу отвечаем на callback query
    try {
        await ctx.answerCbQuery("Загрузка пошагового рецепта...");
    } catch (e) {
        console.log('Callback query уже истек, продолжаем...');
    }

    // Отправляем уведомление о загрузке
    let loadingMessage = null;
    try {
        loadingMessage = await ctx.reply("⏳ Загрузка пошагового рецепта...");
    } catch (e) {
        console.error('Ошибка отправки уведомления о загрузке:', e);
    }

    try {
        // Получаем пошаговый рецепт
        const steps = await getStepByStepRecipe(hrefOnProduct);

        if (!steps || steps.length === 0) {
            // Удаляем сообщение о загрузке
            if (loadingMessage) {
                try {
                    await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
                } catch (e) {
                    // Игнорируем ошибки удаления
                }
            }
            await ctx.reply("Не удалось получить пошаговый рецепт. Попробуйте еще раз.");
            return;
        }

        // Сохраняем шаги, текущий шаг, message_id, текст и информацию о фото исходного сообщения
        userStepByStepRecipes.set(chatId, {
            steps: steps,
            currentStep: 0,
            dishMessageId: dishMessageId,
            dishMessageText: dishMessageText,
            hasPhoto: hasPhoto,
            dishPhotoFileId: dishPhotoFileId,
            isNavigating: false // Флаг для блокировки повторных нажатий во время загрузки
        });

        // Отображаем первый шаг
        await displayStep(ctx, chatId, 0, steps, loadingMessage);

    } catch (error) {
        console.error('Ошибка при получении пошагового рецепта:', error);
        console.error('Детали ошибки:', {
            message: error.message,
            stack: error.stack,
            href: hrefOnProduct
        });

        // Удаляем сообщение о загрузке при ошибке
        if (loadingMessage) {
            try {
                await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
            } catch (e) {
                // Игнорируем ошибки удаления
            }
        }

        // Определяем более информативное сообщение об ошибке
        let errorMessage = "Произошла ошибка при получении пошагового рецепта. Попробуйте еще раз.";

        if (error.message && error.message.includes('timeout')) {
            errorMessage = "Превышено время ожидания. Попробуйте еще раз через несколько секунд.";
        } else if (error.message && error.message.includes('Шаги не найдены')) {
            errorMessage = "Пошаговый рецепт не найден для этого блюда. Попробуйте другое блюдо.";
        } else if (error.message && error.message.includes('PLAYWRIGHT_UNAVAILABLE')) {
            errorMessage = "Сервис временно недоступен. Попробуйте позже.";
        }

        try {
            await ctx.reply(errorMessage);
        } catch (e) {
            // Игнорируем ошибки отправки сообщения
            console.error('Ошибка отправки сообщения об ошибке:', e);
        }
    }
});

// Функция для отображения шага рецепта
const displayStep = async (ctx, chatId, stepIndex, steps, loadingMessage = null) => {
    if (stepIndex < 0 || stepIndex >= steps.length) {
        return;
    }

    const step = steps[stepIndex];
    let stepText = `${step.stepNumber}\n\n${step.instruction}`;
    // Валидируем и обрезаем сообщение при необходимости
    stepText = validateAndTruncateMessage(stepText);
    const keyboard = getStepNavigationKeyboard(stepIndex, steps.length);

    try {
        if (loadingMessage && stepIndex === 0) {
            // Для первого шага удаляем сообщение о загрузке и отправляем новое
            // (нельзя редактировать текстовое сообщение в медиа)
            try {
                await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
            } catch (e) {
                // Игнорируем ошибки удаления
            }
        }

        // Отправляем новое сообщение
        if (step.imageUrl) {
            await ctx.replyWithPhoto(step.imageUrl, {
                caption: stepText,
                reply_markup: keyboard.reply_markup
            });
        } else {
            await ctx.reply(stepText, keyboard);
        }
    } catch (error) {
        console.error('Ошибка при отображении шага:', error);
        try {
            await ctx.reply(stepText, keyboard);
        } catch (e) {
            // Игнорируем ошибки
        }
    }
};

// Обработчик для перехода к предыдущему шагу
bot.action("step_prev", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    const recipeData = userStepByStepRecipes.get(chatId);
    if (!recipeData || !recipeData.steps || recipeData.steps.length === 0) {
        await ctx.answerCbQuery("Пошаговый рецепт не найден. Начните заново.");
        return;
    }

    if (recipeData.currentStep <= 0) {
        await ctx.answerCbQuery("Вы уже на первом шаге.");
        return;
    }

    // Проверяем, не идет ли уже загрузка
    if (recipeData.isNavigating) {
        await ctx.answerCbQuery("⏳ Загрузка... Подождите.");
        return;
    }

    // Устанавливаем флаг загрузки
    recipeData.isNavigating = true;

    // Сразу отвечаем на callback query с индикатором загрузки
    try {
        await ctx.answerCbQuery("⏳ Загрузка...");
    } catch (e) {
        // Игнорируем ошибки
    }

    try {
        recipeData.currentStep--;

        // Обновляем сообщение
        await updateStepMessage(ctx, chatId, recipeData.currentStep, recipeData.steps);
    } catch (error) {
        console.error('Ошибка при переходе к предыдущему шагу:', error);
    } finally {
        // Снимаем флаг загрузки
        recipeData.isNavigating = false;
    }
});

// Обработчик для перехода к следующему шагу
bot.action("step_next", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    const recipeData = userStepByStepRecipes.get(chatId);
    if (!recipeData || !recipeData.steps || recipeData.steps.length === 0) {
        await ctx.answerCbQuery("Пошаговый рецепт не найден. Начните заново.");
        return;
    }

    if (recipeData.currentStep >= recipeData.steps.length - 1) {
        await ctx.answerCbQuery("Вы уже на последнем шаге.");
        return;
    }

    // Проверяем, не идет ли уже загрузка
    if (recipeData.isNavigating) {
        await ctx.answerCbQuery("⏳ Загрузка... Подождите.");
        return;
    }

    // Устанавливаем флаг загрузки
    recipeData.isNavigating = true;

    // Сразу отвечаем на callback query с индикатором загрузки
    try {
        await ctx.answerCbQuery("⏳ Загрузка...");
    } catch (e) {
        // Игнорируем ошибки
    }

    try {
        recipeData.currentStep++;

        // Обновляем сообщение
        await updateStepMessage(ctx, chatId, recipeData.currentStep, recipeData.steps);
    } catch (error) {
        console.error('Ошибка при переходе к следующему шагу:', error);
    } finally {
        // Снимаем флаг загрузки
        recipeData.isNavigating = false;
    }
});

// Функция для обновления сообщения со шагом
const updateStepMessage = async (ctx, chatId, stepIndex, steps) => {
    if (stepIndex < 0 || stepIndex >= steps.length) {
        return;
    }

    const step = steps[stepIndex];
    let stepText = `${step.stepNumber}\n\n${step.instruction}`;
    // Валидируем и обрезаем сообщение при необходимости
    stepText = validateAndTruncateMessage(stepText);
    const keyboard = getStepNavigationKeyboard(stepIndex, steps.length);

    const messageId = ctx.callbackQuery?.message?.message_id;

    try {
        // Пытаемся отредактировать сообщение
        if (step.imageUrl) {
            // Если есть изображение, пытаемся отредактировать медиа
            if (messageId) {
                try {
                    await ctx.telegram.editMessageMedia(chatId, messageId, null, {
                        type: 'photo',
                        media: step.imageUrl,
                        caption: stepText
                    }, {
                        reply_markup: keyboard.reply_markup
                    });
                    return;
                } catch (e) {
                    // Если не удалось отредактировать медиа (например, предыдущее сообщение было текстовым),
                    // удаляем и отправляем новое
                    try {
                        await ctx.deleteMessage();
                    } catch (e2) {
                        // Игнорируем ошибки
                    }
                }
            }
            // Отправляем новое сообщение с фото
            await ctx.replyWithPhoto(step.imageUrl, {
                caption: stepText,
                reply_markup: keyboard.reply_markup
            });
        } else {
            // Если нет изображения, редактируем текст
            if (messageId) {
                try {
                    await ctx.telegram.editMessageText(chatId, messageId, null, stepText, keyboard);
                    return;
                } catch (e) {
                    // Если не удалось отредактировать (например, предыдущее сообщение было с фото),
                    // удаляем и отправляем новое
                    try {
                        await ctx.deleteMessage();
                    } catch (e2) {
                        // Игнорируем ошибки
                    }
                }
            }
            // Отправляем новое текстовое сообщение
            await ctx.reply(stepText, keyboard);
        }
    } catch (error) {
        console.error('Ошибка при обновлении шага:', error);
        // В случае ошибки удаляем и отправляем новое
        try {
            await ctx.deleteMessage();
        } catch (e) {
            // Игнорируем ошибки
        }
        if (step.imageUrl) {
            await ctx.replyWithPhoto(step.imageUrl, {
                caption: stepText,
                reply_markup: keyboard.reply_markup
            });
        } else {
            await ctx.reply(stepText, keyboard);
        }
    }
};

// Обработчик для возврата назад (к меню блюда)
bot.action("step_back", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);

    const recipeData = userStepByStepRecipes.get(chatId);

    await ctx.answerCbQuery();

    // Удаляем сообщение со шагом
    try {
        await ctx.deleteMessage();
    } catch (e) {
        // Игнорируем ошибки удаления
    }

    // Проверяем, пришли ли мы из избранного
    if (recipeData && recipeData.returnToFavorites && recipeData.favoriteId) {
        // Возвращаемся к рецепту из избранного
        try {
            const favorite = await getFavoriteById(chatId, recipeData.favoriteId);
            if (favorite) {
                const recipeText = validateAndTruncateMessage(favorite.recipe_text || favorite.recipe_title);
                const keyboard = getFavoriteRecipeKeyboard(recipeData.favoriteId);

                if (favorite.has_photo && favorite.photo_file_id) {
                    await ctx.replyWithPhoto(favorite.photo_file_id, {
                        caption: recipeText,
                        reply_markup: keyboard.reply_markup
                    });
                } else {
                    await ctx.reply(recipeText, keyboard);
                }

                // Удаляем данные пошагового рецепта
                userStepByStepRecipes.delete(chatId);
                return;
            }
        } catch (error) {
            console.error('Ошибка возврата к избранному:', error);
        }
    }

    // Возвращаемся к исходному сообщению с блюдом
    const state = getUserState(chatId);
    let dishType = '';
    if (state === 1) dishType = 'breakfast';
    else if (state === 2) dishType = 'dinner';
    else if (state === 3) dishType = 'lunch';
    else if (state === 4) dishType = 'search';

    const recipeRequested = dishType ? isRecipeRequested(chatId, dishType) : false;
    const hasHistory = dishType ? hasRecipeHistory(chatId, dishType) : false;

    // Получаем URL для проверки избранного
    const recipeUrl = dishType ? userHrefs.get(chatId)?.[dishType] : null;
    const keyboard = recipeUrl ? await getDetailedMenuKeyboardWithFavorites(chatId, recipeUrl, recipeRequested, hasHistory) : getDetailedMenuKeyboard(recipeRequested, hasHistory, false);

    // Если есть сохраненное сообщение с блюдом, редактируем его
    if (recipeData && recipeData.dishMessageId && recipeData.dishMessageText && recipeData.dishMessageText.trim()) {
        try {
            if (recipeData.hasPhoto && recipeData.dishPhotoFileId) {
                // Если сообщение было с фото, редактируем caption
                await ctx.telegram.editMessageCaption(
                    chatId,
                    recipeData.dishMessageId,
                    null,
                    recipeData.dishMessageText,
                    keyboard
                );
            } else {
                // Если сообщение было текстовым, редактируем текст
                await ctx.telegram.editMessageText(
                    chatId,
                    recipeData.dishMessageId,
                    null,
                    recipeData.dishMessageText,
                    keyboard
                );
            }
        } catch (e) {
            // Если не удалось отредактировать, пробуем альтернативные способы
            try {
                if (recipeData.hasPhoto && recipeData.dishPhotoFileId) {
                    // Пробуем отредактировать медиа полностью
                    await ctx.telegram.editMessageMedia(
                        chatId,
                        recipeData.dishMessageId,
                        null,
                        {
                            type: 'photo',
                            media: recipeData.dishPhotoFileId,
                            caption: recipeData.dishMessageText || 'Меню блюда'
                        },
                        {
                            reply_markup: getDetailedMenuKeyboard(recipeRequested, hasHistory).reply_markup
                        }
                    );
                } else {
                    // Пробуем отредактировать как текст еще раз
                    await ctx.telegram.editMessageText(
                        chatId,
                        recipeData.dishMessageId,
                        null,
                        recipeData.dishMessageText || 'Меню блюда',
                        keyboard
                    );
                }
            } catch (e2) {
                // Если и это не получилось, отправляем новое сообщение
                try {
                    if (recipeData.hasPhoto && recipeData.dishPhotoFileId) {
                        await ctx.replyWithPhoto(recipeData.dishPhotoFileId, {
                            caption: recipeData.dishMessageText || 'Меню блюда',
                            reply_markup: getDetailedMenuKeyboard(recipeRequested, hasHistory).reply_markup
                        });
                    } else {
                        await ctx.reply(recipeData.dishMessageText || 'Меню блюда', getDetailedMenuKeyboard(recipeRequested, hasHistory));
                    }
                } catch (e3) {
                    console.error('Ошибка при возврате к меню блюда:', e3);
                }
            }
        }
    } else {
        // Если нет сохраненного сообщения, отправляем новое
        try {
            // Получаем текст блюда заново
            let messageText = "";
            try {
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
                        const lastSearchQuery = userSearchQueries.get(chatId);
                        if (lastSearchQuery) {
                            messageText = await search(ctx, userHrefs, lastSearchQuery);
                        } else {
                            messageText = "Напишите что хотите найти: например ПП ужин, спаггети с креветками и т.п.";
                        }
                break;
        }

                // Проверяем, что текст не пустой
                if (!messageText || !messageText.trim()) {
                    messageText = "Меню блюда";
                }

                // Валидируем и обрезаем сообщение при необходимости
                messageText = validateAndTruncateMessage(messageText);
                await ctx.reply(messageText, getDetailedMenuKeyboard(recipeRequested, hasHistory));
            } catch (e) {
                console.error('Ошибка при получении текста блюда:', e);
                await ctx.reply("Меню блюда", getDetailedMenuKeyboard(recipeRequested, hasHistory));
            }
        } catch (e) {
            console.error('Ошибка при возврате к меню блюда:', e);
        }
    }

    // Удаляем данные пошагового рецепта
    userStepByStepRecipes.delete(chatId);
});

// Обработчики для неактивных кнопок
bot.action("step_prev_disabled", async (ctx) => {
    await ctx.answerCbQuery("Вы уже на первом шаге.");
});

bot.action("step_next_disabled", async (ctx) => {
    await ctx.answerCbQuery("Вы уже на последнем шаге.");
});

bot.action("step_info", async (ctx) => {
    await ctx.answerCbQuery(); // Просто убираем индикатор загрузки
});

bot.action("back_to_main", async (ctx) => {
    const chatId = ctx.chat.id;
    updateUserActivity(chatId);
        resetUserState(chatId);
        resetUserHrefs(chatId);
    const favoritesCount = await getFavoritesCount(chatId).catch(() => 0);
    try {
        await ctx.editMessageText("Выберите действие", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Завтрак🍏", callback_data: "breakfast" }],
                    [{ text: "Обед🍜", callback_data: "dinner" }],
                    [{ text: "Ужин🍝", callback_data: "lunch" }],
                    [{ text: "Поиск🔎", callback_data: "search" }],
                    [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
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
                        [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
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
    const favoritesCount = await getFavoritesCount(chatId).catch(() => 0);
    await ctx.reply("Выберите действие", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Завтрак🍏", callback_data: "breakfast" }],
                [{ text: "Обед🍜", callback_data: "dinner" }],
                [{ text: "Ужин🍝", callback_data: "lunch" }],
                [{ text: "Поиск🔎", callback_data: "search" }],
                [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
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

                // Сохраняем текущий рецепт в историю перед новым поиском (если есть)
                const currentUrl = userHrefs.get(chatId)?.search;
                // Получаем последнее сообщение бота для этого пользователя (если возможно)
                // В данном случае мы не можем получить предыдущее сообщение напрямую,
                // поэтому сохраняем только если есть текущий URL

                const searchResult = await search(ctx, userHrefs, searchQuery);

                if (searchResult && typeof searchResult === 'string') {
                    console.log('🔍 Результат поиска:', searchResult.length > 100 ? searchResult.substring(0, 100) + '...' : searchResult);
                    const recipeRequested = isRecipeRequested(chatId, 'search');
                    const hasHistory = hasRecipeHistory(chatId, 'search');
                    const recipeUrl = userHrefs.get(chatId)?.search;
                    const keyboard = recipeUrl ? await getDetailedMenuKeyboardWithFavorites(chatId, recipeUrl, recipeRequested, hasHistory) : getDetailedMenuKeyboard(recipeRequested, hasHistory, false);
                    await ctx.reply(searchResult, keyboard);
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
// Инициализируем браузер при старте бота (не критично, если не получится)
initBrowser()
  .then(() => {
    console.log('✅ Браузер Playwright готов');
    // Инициализируем БД
    return initTables();
  })
  .then((dbInitialized) => {
    if (dbInitialized) {
      console.log('✅ База данных готова');
      // Проверяем, что таблица действительно создана
      checkTableExists('favorites').catch(err => {
        console.warn('⚠️ Не удалось проверить таблицу:', err.message);
      });
    } else {
      console.warn('⚠️ База данных не инициализирована, избранное недоступно');
    }
  })
  .catch((err) => {
    console.warn('⚠️ Ошибка инициализации:', err.message);
  })
  .finally(() => {
    // Запускаем бота в любом случае
bot.launch()
  .then(() => {
    console.log('✅ Бот успешно запущен!');
  })
  .catch((err) => {
    console.error('❌ Ошибка при запуске бота:', err);
    process.exit(1);
      });
  });

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n🛑 Получен сигнал ${signal}, завершаем работу...`);
  try {
    await bot.stop(signal);
    await closeBrowser();
    await closePool(); // Закрываем пул подключений
    console.log('✅ Бот, браузер и БД успешно остановлены');
    process.exit(0);
  } catch (err) {
    console.error('❌ Ошибка при завершении работы:', err);
    process.exit(1);
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));