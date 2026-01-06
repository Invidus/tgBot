import { Telegraf } from "telegraf";
import { config } from "../shared/config.js";
import { getDetailedMenuKeyboard, getSearchKeyboard, getStepNavigationKeyboard, getFavoritesKeyboard, getFavoriteRecipeKeyboard, isRecipeUrl } from "./innerButtons.js";
import { validateAndTruncateMessage } from "./messageUtils.js";
import Redis from "ioredis";
import axios from "axios";

const bot = new Telegraf(config.telegramToken);
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

const recipeParserUrl = config.services.recipeParser;
const databaseServiceUrl = config.services.database;

// Вспомогательные функции для работы с Redis
const getUserState = async (chatId) => {
  const state = await redis.get(`user:state:${chatId}`);
  return state ? parseInt(state) : 0;
};

const setUserState = async (chatId, state) => {
  await redis.setex(`user:state:${chatId}`, 86400, state.toString());
};

const getUserHref = async (chatId, dishType) => {
  return await redis.get(`user:href:${chatId}:${dishType}`);
};

const setUserHref = async (chatId, dishType, url) => {
  await redis.setex(`user:href:${chatId}:${dishType}`, 3600, url);
};

const getRecipeRequested = async (chatId, dishType) => {
  const result = await redis.get(`user:recipeRequested:${chatId}:${dishType}`);
  return result === 'true';
};

const setRecipeRequested = async (chatId, dishType, value) => {
  await redis.setex(`user:recipeRequested:${chatId}:${dishType}`, 3600, value ? 'true' : 'false');
};

// Функции для сохранения и получения поискового запроса
const getUserSearchQuery = async (chatId) => {
  return await redis.get(`user:searchQuery:${chatId}`);
};

const setUserSearchQuery = async (chatId, query) => {
  if (query) {
    await redis.setex(`user:searchQuery:${chatId}`, 3600, query);
  } else {
    await redis.del(`user:searchQuery:${chatId}`);
  }
};

// Функции для работы с историей рецептов в Redis
const MAX_HISTORY_SIZE = 10;

const saveRecipeToHistory = async (chatId, dishType, url, text, hasPhoto = false, photoFileId = null) => {
  if (!url || !text) return; // Пропускаем пустые данные

  try {
    const historyKey = `user:history:${chatId}:${dishType}`;
    const historyData = {
      url,
      text,
      hasPhoto,
      photoFileId,
      timestamp: Date.now()
    };

    // Получаем текущую историю
    const existingHistory = await redis.lrange(historyKey, 0, -1);
    const history = existingHistory.map(item => JSON.parse(item));

    // Добавляем новый рецепт в конец
    history.push(historyData);

    // Ограничиваем размер истории
    if (history.length > MAX_HISTORY_SIZE) {
      history.shift(); // Удаляем самый старый
    }

    // Сохраняем обновленную историю
    await redis.del(historyKey);
    if (history.length > 0) {
      await redis.rpush(historyKey, ...history.map(item => JSON.stringify(item)));
      await redis.expire(historyKey, 86400); // 24 часа
    }
  } catch (error) {
    console.error('Ошибка сохранения истории рецепта:', error);
  }
};

const getPreviousRecipe = async (chatId, dishType) => {
  try {
    const historyKey = `user:history:${chatId}:${dishType}`;
    const history = await redis.lrange(historyKey, 0, -1);

    if (history.length === 0) {
      return null;
    }

    // Получаем последний рецепт из истории и удаляем его (LIFO)
    const lastRecipe = JSON.parse(history[history.length - 1]);
    await redis.rpop(historyKey);

    return lastRecipe;
  } catch (error) {
    console.error('Ошибка получения предыдущего рецепта:', error);
    return null;
  }
};

const hasRecipeHistory = async (chatId, dishType) => {
  try {
    const historyKey = `user:history:${chatId}:${dishType}`;
    const length = await redis.llen(historyKey);
    return length > 0;
  } catch (error) {
    return false;
  }
};

// Функция для получения рецепта через Recipe Parser Service
const getRecipeFromParser = async (dishType, chatId, searchQuery = null, forceRefresh = false) => {
  try {
    const response = await axios.post(`${recipeParserUrl}/parse/${dishType}`, {
      chatId,
      searchQuery,
      forceRefresh
    }, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (error) {
    console.error(`Ошибка получения рецепта ${dishType}:`, error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      throw new Error('Сервис парсинга недоступен. Попробуйте позже.');
    }
    // Обрабатываем ошибки от API (404, 500 и т.д.)
    if (error.response) {
      const status = error.response.status;
      const errorMessage = error.response.data?.error || 'Неизвестная ошибка';
      if (status === 404) {
        throw new Error(errorMessage);
      }
      throw new Error(`Ошибка сервера: ${errorMessage}`);
    }
    throw error;
  }
};

// Функция для получения полного рецепта
const getFullRecipe = async (url, dishType) => {
  try {
    const response = await axios.post(`${recipeParserUrl}/parse/full`, {
      url,
      dishType
    }, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (error) {
    console.error('Ошибка получения полного рецепта:', error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      throw new Error('Сервис парсинга недоступен. Попробуйте позже.');
    }
    throw error;
  }
};

// Функция для получения пошагового рецепта
const getStepByStepRecipe = async (url) => {
  try {
    const response = await axios.post(`${recipeParserUrl}/parse/step-by-step`, {
      url
    }, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data.steps || [];
  } catch (error) {
    console.error('Ошибка получения пошагового рецепта:', error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      throw new Error('Сервис парсинга недоступен. Попробуйте позже.');
    }
    throw error;
  }
};

// Функции для работы с состоянием пошагового рецепта в Redis
const getStepByStepData = async (chatId) => {
  try {
    const data = await redis.get(`step_by_step:${chatId}`);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    return null;
  }
};

const setStepByStepData = async (chatId, data) => {
  try {
    await redis.setex(`step_by_step:${chatId}`, 3600, JSON.stringify(data));
  } catch (error) {
    console.error('Ошибка сохранения состояния шагов:', error);
  }
};

const clearStepByStepData = async (chatId) => {
  try {
    await redis.del(`step_by_step:${chatId}`);
  } catch (error) {
    console.error('Ошибка очистки состояния шагов:', error);
  }
};

// Функция для получения избранного
const getFavoritesFromDB = async (chatId, page = 0, pageSize = 50) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/favorites/${chatId}`, {
      params: { page, pageSize },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error('Ошибка получения избранного:', error.message);
    return [];
  }
};

const getFavoritesCount = async (chatId) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/favorites/count/${chatId}`, {
      timeout: 10000,
      validateStatus: (status) => status < 500 // Не бросать ошибку для 4xx
    });
    if (response.status === 200) {
      return response.data.count || 0;
    }
    return 0;
  } catch (error) {
    if (error.response && error.response.status >= 500) {
      console.error('Ошибка получения количества избранного (500):', error.message);
    }
    return 0;
  }
};

const isInFavorites = async (chatId, url) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/favorites/check/${chatId}`, {
      params: { url },
      timeout: 10000
    });
    return response.data.isInFavorites || false;
  } catch (error) {
    return false;
  }
};

const addToFavorites = async (chatId, data) => {
  try {
    const response = await axios.post(`${databaseServiceUrl}/favorites/add`, {
      chatId,
      ...data
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data.added || false;
  } catch (error) {
    console.error('Ошибка добавления в избранное:', error.message);
    if (error.response) {
      console.error('Детали ошибки:', error.response.data);
    }
    return false;
  }
};

const removeFromFavorites = async (chatId, url) => {
  try {
    const response = await axios.delete(`${databaseServiceUrl}/favorites/${chatId}`, {
      params: { url },
      timeout: 10000
    });
    return response.data.removed || false;
  } catch (error) {
    console.error('Ошибка удаления из избранного:', error.message);
    return false;
  }
};

// Обработчик команды /start
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  await setUserState(chatId, 0);

  const favoritesCount = await getFavoritesCount(chatId);

  await ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️', {
    reply_markup: {
      remove_keyboard: true
    }
  });

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

// Обработчик выбора завтрака
bot.action("breakfast", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  await setUserState(chatId, 1);

  try {
    const result = await getRecipeFromParser('breakfast', chatId);
    await setUserHref(chatId, 'breakfast', result.url);
    await setRecipeRequested(chatId, 'breakfast', false);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const hasHistory = await hasRecipeHistory(chatId, 'breakfast');
    const isInFav = await isInFavorites(chatId, result.url);
    const isRecipe = isRecipeUrl(result.url);
    const keyboard = getDetailedMenuKeyboard(false, hasHistory, isInFav, isRecipe);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.replyWithPhoto(result.photoFileId, {
        caption: recipeText,
        reply_markup: keyboard.reply_markup
      });
    } else {
      await ctx.reply(recipeText, keyboard);
    }
    // Убираем индикатор загрузки после успешной отправки
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка в breakfast:', error);
    await ctx.answerCbQuery("❌ Ошибка при получении рецепта").catch(() => {});
    await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
  }
});

// Обработчик выбора обеда
bot.action("dinner", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  await setUserState(chatId, 2);

  // Сохраняем текущий рецепт в историю перед получением нового
  const currentMessage = ctx.callbackQuery?.message;
  const prevUrl = await getUserHref(chatId, 'dinner');
  if (prevUrl && currentMessage) {
    const currentText = currentMessage.text || currentMessage.caption || '';
    if (currentText.trim()) {
      const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
      const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
      await saveRecipeToHistory(chatId, 'dinner', prevUrl, currentText, hasPhoto, photoFileId);
    }
  }

  try {
    const result = await getRecipeFromParser('dinner', chatId);
    await setUserHref(chatId, 'dinner', result.url);
    await setRecipeRequested(chatId, 'dinner', false);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const hasHistory = await hasRecipeHistory(chatId, 'dinner');
    const isInFav = await isInFavorites(chatId, result.url);
    const isRecipe = isRecipeUrl(result.url);
    const keyboard = getDetailedMenuKeyboard(false, hasHistory, isInFav, isRecipe);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.replyWithPhoto(result.photoFileId, {
        caption: recipeText,
        reply_markup: keyboard.reply_markup
      });
    } else {
      await ctx.reply(recipeText, keyboard);
    }
    // Убираем индикатор загрузки после успешной отправки
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка в dinner:', error);
    await ctx.answerCbQuery("❌ Ошибка при получении рецепта").catch(() => {});
    await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
  }
});

// Обработчик выбора ужина
bot.action("lunch", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  await setUserState(chatId, 3);

  // Сохраняем текущий рецепт в историю перед получением нового
  const currentMessage = ctx.callbackQuery?.message;
  const prevUrl = await getUserHref(chatId, 'lunch');
  if (prevUrl && currentMessage) {
    const currentText = currentMessage.text || currentMessage.caption || '';
    if (currentText.trim()) {
      const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
      const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
      await saveRecipeToHistory(chatId, 'lunch', prevUrl, currentText, hasPhoto, photoFileId);
    }
  }

  try {
    const result = await getRecipeFromParser('lunch', chatId);
    await setUserHref(chatId, 'lunch', result.url);
    await setRecipeRequested(chatId, 'lunch', false);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const hasHistory = await hasRecipeHistory(chatId, 'lunch');
    const isInFav = await isInFavorites(chatId, result.url);
    const isRecipe = isRecipeUrl(result.url);
    const keyboard = getDetailedMenuKeyboard(false, hasHistory, isInFav, isRecipe);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.replyWithPhoto(result.photoFileId, {
        caption: recipeText,
        reply_markup: keyboard.reply_markup
      });
    } else {
      await ctx.reply(recipeText, keyboard);
    }
    // Убираем индикатор загрузки после успешной отправки
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка в lunch:', error);
    await ctx.answerCbQuery("❌ Ошибка при получении рецепта").catch(() => {});
    await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
  }
});

// Обработчик поиска
bot.action("search", async (ctx) => {
  const chatId = ctx.chat.id;
  await setUserState(chatId, 4);

  await ctx.reply("Введите поисковый запрос:", getSearchKeyboard());
  await ctx.answerCbQuery();
});

// Обработчик для неактивной кнопки ингредиентов (если рецепт уже был показан)
bot.action("ingredients_disabled", async (ctx) => {
  await ctx.answerCbQuery("Рецепт уже был показан. Выберите другое блюдо для нового рецепта.");
});

// Обработчик получения полного рецепта (Ингредиенты)
bot.action("ingredients", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  let dishType = '';
  if (state === 1) dishType = 'breakfast';
  else if (state === 2) dishType = 'dinner';
  else if (state === 3) dishType = 'lunch';
  else if (state === 4) dishType = 'search';

  if (!dishType) {
    await ctx.answerCbQuery("Сначала выберите тип блюда");
    return;
  }

  const url = await getUserHref(chatId, dishType);
  if (!url) {
    await ctx.answerCbQuery("Сначала выберите блюдо");
    return;
  }

  const currentMessage = ctx.callbackQuery?.message;
  if (!currentMessage) {
    await ctx.reply("❌ Ошибка: сообщение не найдено");
    return;
  }

  try {
    const result = await getFullRecipe(url, dishType);

    if (!result || !result.recipeText) {
      throw new Error('Пустой ответ от сервиса парсинга');
    }

    await setRecipeRequested(chatId, dishType, true);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const hasHistory = await hasRecipeHistory(chatId, dishType);
    const isInFav = await isInFavorites(chatId, url);
    const isRecipe = isRecipeUrl(url);
    const keyboard = getDetailedMenuKeyboard(true, hasHistory, isInFav, isRecipe);

    // Редактируем существующее сообщение
    if (currentMessage.photo && currentMessage.photo.length > 0) {
      // Если было фото, заменяем на текст
      await ctx.telegram.editMessageMedia(
        chatId,
        currentMessage.message_id,
        null,
        {
          type: 'photo',
          media: currentMessage.photo[currentMessage.photo.length - 1].file_id,
          caption: recipeText
        },
        { reply_markup: keyboard.reply_markup }
      );
    } else {
      // Если было текстовое сообщение, просто редактируем
      await ctx.telegram.editMessageText(
        chatId,
        currentMessage.message_id,
        null,
        recipeText,
        keyboard
      );
    }
    // Убираем индикатор загрузки после успешного обновления
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка в ingredients:', error);
    try {
      await ctx.telegram.editMessageText(
        chatId,
        currentMessage.message_id,
        null,
        "❌ Ошибка при загрузке рецепта"
      );
    } catch (e) {
      await ctx.reply("❌ Ошибка при загрузке рецепта");
    }
  }
});

// Обработчик добавления в избранное
bot.action("add_to_favorites", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  let dishType = '';
  let url = null;
  if (state === 1) {
    dishType = 'breakfast';
    url = await getUserHref(chatId, 'breakfast');
  } else if (state === 2) {
    dishType = 'dinner';
    url = await getUserHref(chatId, 'dinner');
  } else if (state === 3) {
    dishType = 'lunch';
    url = await getUserHref(chatId, 'lunch');
  } else if (state === 4) {
    dishType = 'search';
    url = await getUserHref(chatId, 'search');
  }

  if (!url) {
    await ctx.answerCbQuery("Сначала выберите блюдо");
    return;
  }

  const currentMessage = ctx.callbackQuery?.message;
  if (!currentMessage) {
    await ctx.answerCbQuery("❌ Ошибка: сообщение не найдено");
    return;
  }

  const recipeText = currentMessage?.text || currentMessage?.caption || '';
  const recipeTitle = recipeText.split('\n')[0] || 'Рецепт без названия';

  // Проверяем, не добавлен ли уже рецепт
  const alreadyInFav = await isInFavorites(chatId, url);
  if (alreadyInFav) {
    await ctx.answerCbQuery("Рецепт уже в избранном");
    return;
  }

  try {
    const added = await addToFavorites(chatId, {
      url,
      title: recipeTitle,
      text: recipeText,
      dishType,
      hasPhoto: !!(currentMessage?.photo && currentMessage?.photo.length > 0),
      photoFileId: currentMessage?.photo?.[currentMessage.photo.length - 1]?.file_id || null
    });

    if (added) {
      // Уведомление через отдельное сообщение
      await ctx.reply("✅ Добавлено в избранное!").catch(() => {});
    } else {
      // Рецепт уже в избранном (на случай race condition)
      await ctx.answerCbQuery("Рецепт уже в избранном");
    }
  } catch (error) {
    console.error('Ошибка при добавлении в избранное:', error);
    await ctx.answerCbQuery("❌ Ошибка при добавлении в избранное");
    return;
  }

  const recipeRequested = await getRecipeRequested(chatId, dishType);
  const isInFav = await isInFavorites(chatId, url);
  const isRecipe = isRecipeUrl(url);
  const keyboard = getDetailedMenuKeyboard(recipeRequested, false, isInFav, isRecipe);

  try {
    if (currentMessage?.photo) {
      await ctx.telegram.editMessageCaption(
        chatId,
        currentMessage.message_id,
        null,
        recipeText,
        keyboard
      );
    } else {
      await ctx.telegram.editMessageText(
        chatId,
        currentMessage.message_id,
        null,
        recipeText,
        keyboard
      );
    }
  } catch (e) {
    // Игнорируем ошибки редактирования
  }
});

// Обработчик удаления из избранного
bot.action("remove_from_favorites", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  let dishType = '';
  let url = null;
  if (state === 1) {
    dishType = 'breakfast';
    url = await getUserHref(chatId, 'breakfast');
  } else if (state === 2) {
    dishType = 'dinner';
    url = await getUserHref(chatId, 'dinner');
  } else if (state === 3) {
    dishType = 'lunch';
    url = await getUserHref(chatId, 'lunch');
  } else if (state === 4) {
    dishType = 'search';
    url = await getUserHref(chatId, 'search');
  }

  if (!url) {
    await ctx.answerCbQuery("Сначала выберите блюдо");
    return;
  }

  const removed = await removeFromFavorites(chatId, url);

  if (removed) {
    await ctx.reply("❌ Удалено из избранного!").catch(() => {});
  }

  const currentMessage = ctx.callbackQuery?.message;
  const recipeText = currentMessage?.text || currentMessage?.caption || '';
  const recipeRequested = await getRecipeRequested(chatId, dishType);
  const hasHistory = await hasRecipeHistory(chatId, dishType);
  const isInFav = await isInFavorites(chatId, url);
  const isRecipe = isRecipeUrl(url);
  const keyboard = getDetailedMenuKeyboard(recipeRequested, hasHistory, isInFav, isRecipe);

  try {
    if (currentMessage?.photo) {
      await ctx.telegram.editMessageCaption(
        chatId,
        currentMessage.message_id,
        null,
        recipeText,
        keyboard
      );
    } else {
      await ctx.telegram.editMessageText(
        chatId,
        currentMessage.message_id,
        null,
        recipeText,
        keyboard
      );
    }
    // Убираем индикатор загрузки после успешного обновления
    await ctx.answerCbQuery().catch(() => {});
  } catch (e) {
    // Игнорируем ошибки редактирования
  }
});

// Обработчик "Другое блюдо"
bot.action("another_dish", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  let dishType = '';
  if (state === 1) dishType = 'breakfast';
  else if (state === 2) dishType = 'dinner';
  else if (state === 3) dishType = 'lunch';
  else if (state === 4) dishType = 'search';

  if (!dishType) {
    await ctx.answerCbQuery("Сначала выберите тип блюда");
    return;
  }

  // Сохраняем текущий рецепт в историю перед получением нового
  const currentMessage = ctx.callbackQuery?.message;
  const prevUrl = await getUserHref(chatId, dishType);
  if (prevUrl && currentMessage) {
    const currentText = currentMessage.text || currentMessage.caption || '';
    if (currentText.trim()) {
      const hasPhoto = !!(currentMessage.photo && currentMessage.photo.length > 0);
      const photoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;
      await saveRecipeToHistory(chatId, dishType, prevUrl, currentText, hasPhoto, photoFileId);
    }
  }

  // Сбрасываем флаг запрошенного рецепта
  await setRecipeRequested(chatId, dishType, false);

  try {
    // Для поиска получаем сохраненный запрос, для остальных типов - null
    const searchQuery = dishType === 'search' ? await getUserSearchQuery(chatId) : null;
    console.log(`🔄 another_dish: dishType=${dishType}, searchQuery="${searchQuery}", chatId=${chatId}`);
    if (dishType === 'search' && !searchQuery) {
      console.log(`❌ another_dish: поисковый запрос не найден для chatId=${chatId}`);
      await ctx.answerCbQuery("Сначала выполните поиск");
      return;
    }
    // При нажатии "Другое блюдо" принудительно обновляем рецепт
    console.log(`📤 another_dish: отправка запроса с searchQuery="${searchQuery}", forceRefresh=true`);
    const result = await getRecipeFromParser(dishType, chatId, searchQuery, true);
    console.log(`✅ another_dish: получен результат, url=${result.url}`);

    // Проверяем, не совпадает ли новый рецепт с текущим (до обновления в Redis)
    if (prevUrl === result.url && currentMessage) {
      // Если рецепт тот же, просто уведомляем пользователя
      await ctx.answerCbQuery("Это то же самое блюдо. Попробуйте еще раз.");
      return;
    }

    await setUserHref(chatId, dishType, result.url);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const hasHistory = await hasRecipeHistory(chatId, dishType);
    const isInFav = await isInFavorites(chatId, result.url);
    const isRecipe = isRecipeUrl(result.url);
    const keyboard = getDetailedMenuKeyboard(false, hasHistory, isInFav, isRecipe);

    if (currentMessage) {
      // Редактируем существующее сообщение
      try {
        if (result.hasPhoto && result.photoFileId) {
          await ctx.telegram.editMessageMedia(
            chatId,
            currentMessage.message_id,
            null,
            {
              type: 'photo',
              media: result.photoFileId,
              caption: recipeText
            },
            { reply_markup: keyboard.reply_markup }
          );
        } else {
          await ctx.telegram.editMessageText(
            chatId,
            currentMessage.message_id,
            null,
            recipeText,
            keyboard
          );
        }
        // Убираем индикатор загрузки после успешного обновления
        await ctx.answerCbQuery().catch(() => {});
      } catch (editError) {
        // Игнорируем ошибку "message is not modified" - это не критично
        if (editError.response?.error_code === 400 &&
            editError.response?.description?.includes('message is not modified')) {
          await ctx.answerCbQuery("Рецепт не изменился. Попробуйте еще раз.");
          return;
        }
        // Для других ошибок пробрасываем дальше
        throw editError;
      }
    } else {
      // Если нет сообщения, отправляем новое
      if (result.hasPhoto && result.photoFileId) {
        await ctx.replyWithPhoto(result.photoFileId, {
          caption: recipeText,
          reply_markup: keyboard.reply_markup
        });
      } else {
        await ctx.reply(recipeText, keyboard);
      }
      // Убираем индикатор загрузки после успешной отправки
      await ctx.answerCbQuery().catch(() => {});
    }
  } catch (error) {
    console.error('Ошибка в another_dish:', error);
    // Игнорируем ошибку "message is not modified"
    if (error.response?.error_code === 400 &&
        error.response?.description?.includes('message is not modified')) {
      await ctx.answerCbQuery("Рецепт не изменился. Попробуйте еще раз.");
      return;
    }
    try {
      if (currentMessage) {
        await ctx.telegram.editMessageText(
          chatId,
          currentMessage.message_id,
          null,
          "❌ Ошибка при получении рецепта. Попробуйте позже."
        );
      } else {
        await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
      }
    } catch (e) {
      await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
    }
  }
});

// Обработчик возврата к предыдущему рецепту (пока упрощенный)
// Обработчик возврата к предыдущему рецепту
bot.action("previous_recipe", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  let dishType = '';
  if (state === 1) dishType = 'breakfast';
  else if (state === 2) dishType = 'dinner';
  else if (state === 3) dishType = 'lunch';
  else if (state === 4) dishType = 'search';

  if (!dishType) {
    await ctx.answerCbQuery("Сначала выберите тип блюда");
    return;
  }

  // Получаем предыдущий рецепт из истории
  // ВАЖНО: НЕ сохраняем текущий рецепт в историю здесь, чтобы избежать циклического переключения
  const previousRecipe = await getPreviousRecipe(chatId, dishType);

  if (!previousRecipe) {
    await ctx.answerCbQuery("Нет предыдущих рецептов.");
    return;
  }

  // Восстанавливаем предыдущий рецепт
  await setUserHref(chatId, dishType, previousRecipe.url);
  await setRecipeRequested(chatId, dishType, false);

  // Проверяем, есть ли еще история
  const hasHistory = await hasRecipeHistory(chatId, dishType);
  const recipeRequested = await getRecipeRequested(chatId, dishType);
  const isInFav = await isInFavorites(chatId, previousRecipe.url);
  const isRecipe = isRecipeUrl(previousRecipe.url);
  const keyboard = getDetailedMenuKeyboard(recipeRequested, hasHistory, isInFav, isRecipe);

  try {
    // Используем сохраненный текст для быстрого отображения
    const recipeText = validateAndTruncateMessage(previousRecipe.text || 'Меню блюда');

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
          await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id);
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
        await ctx.telegram.editMessageText(
          chatId,
          ctx.callbackQuery.message.message_id,
          null,
          recipeText,
          keyboard
        );
      } catch (e) {
        // Если не удалось отредактировать, отправляем новое
        try {
          await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id);
        } catch (e2) {
          // Игнорируем ошибки
        }
        await ctx.reply(recipeText, keyboard);
      }
    }
    // Убираем индикатор загрузки после успешного обновления
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка при возврате к предыдущему рецепту:', error);
    await ctx.answerCbQuery("Ошибка при возврате к предыдущему рецепту.");
  }
});

// Обработчик пошагового рецепта
bot.action("step_by_step", async (ctx) => {
  // Показываем индикатор загрузки на кнопке
  await ctx.answerCbQuery("⏳ Загружаю пошаговый рецепт...", { show_alert: false });

  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  let dishType = '';
  if (state === 1) dishType = 'breakfast';
  else if (state === 2) dishType = 'dinner';
  else if (state === 3) dishType = 'lunch';
  else if (state === 4) dishType = 'search';

  if (!dishType) {
    await ctx.answerCbQuery("Сначала выберите тип блюда");
    return;
  }

  const url = await getUserHref(chatId, dishType);
  if (!url) {
    await ctx.answerCbQuery("Сначала выберите блюдо");
    return;
  }

  // Сохраняем информацию о исходном сообщении для возврата
  const currentMessage = ctx.callbackQuery?.message;
  const dishMessageId = currentMessage?.message_id;
  const dishMessageText = currentMessage?.text || currentMessage?.caption || '';
  const hasPhoto = !!(currentMessage?.photo && currentMessage?.photo.length > 0);
  const dishPhotoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;

  // Отправляем уведомление о загрузке
  const loadingMsg = await ctx.reply("⏳ Загрузка пошагового рецепта...");

  try {
    const steps = await getStepByStepRecipe(url);

    if (!steps || steps.length === 0) {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await ctx.reply("Не удалось получить пошаговый рецепт. Попробуйте еще раз.");
      return;
    }

    // Проверяем статус избранного перед сохранением
    const isInFav = await isInFavorites(chatId, url);
    const hasHistory = await hasRecipeHistory(chatId, dishType);
    const recipeRequested = await getRecipeRequested(chatId, dishType);

    // Сохраняем состояние в Redis (включая URL и статус избранного)
    await setStepByStepData(chatId, {
      steps: steps,
      currentStep: 0,
      dishMessageId: dishMessageId,
      dishMessageText: dishMessageText,
      hasPhoto: hasPhoto,
      dishPhotoFileId: dishPhotoFileId,
      isNavigating: false,
      url: url, // Сохраняем URL рецепта
      dishType: dishType, // Сохраняем тип блюда
      isInFav: isInFav, // Сохраняем статус избранного
      hasHistory: hasHistory, // Сохраняем наличие истории
      recipeRequested: recipeRequested // Сохраняем флаг запрошенного рецепта
    });

    // Отображаем первый шаг
    await displayStep(ctx, chatId, 0, steps, loadingMsg);
  } catch (error) {
    console.error('Ошибка в step_by_step:', error);
    try {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    } catch (e) {}
    await ctx.reply("❌ Ошибка при загрузке пошагового рецепта. Попробуйте позже.");
  }
});

// Функция для отображения шага
const displayStep = async (ctx, chatId, stepIndex, steps, loadingMessage = null) => {
  if (stepIndex < 0 || stepIndex >= steps.length) {
    return;
  }

  const step = steps[stepIndex];
  let stepText = `${step.stepNumber}\n\n${step.instruction}`;
  stepText = validateAndTruncateMessage(stepText);
  const keyboard = getStepNavigationKeyboard(stepIndex, steps.length);

  try {
    if (loadingMessage && stepIndex === 0) {
      // Для первого шага удаляем сообщение о загрузке
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

// Функция для обновления сообщения со шагом
const updateStepMessage = async (ctx, chatId, stepIndex, steps) => {
  if (stepIndex < 0 || stepIndex >= steps.length) {
    return;
  }

  const step = steps[stepIndex];
  let stepText = `${step.stepNumber}\n\n${step.instruction}`;
  stepText = validateAndTruncateMessage(stepText);
  const keyboard = getStepNavigationKeyboard(stepIndex, steps.length);

  const messageId = ctx.callbackQuery?.message?.message_id;

  try {
    if (step.imageUrl) {
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
          try {
            await ctx.telegram.deleteMessage(chatId, messageId);
          } catch (e2) {}
        }
      }
      await ctx.replyWithPhoto(step.imageUrl, {
        caption: stepText,
        reply_markup: keyboard.reply_markup
      });
    } else {
      if (messageId) {
        try {
          await ctx.telegram.editMessageText(chatId, messageId, null, stepText, keyboard);
          return;
        } catch (e) {
          try {
            await ctx.telegram.deleteMessage(chatId, messageId);
          } catch (e2) {}
        }
      }
      await ctx.reply(stepText, keyboard);
    }
  } catch (error) {
    console.error('Ошибка при обновлении шага:', error);
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

// Обработчик для перехода к предыдущему шагу
bot.action("step_prev", async (ctx) => {
  await ctx.answerCbQuery("⏳ Загрузка...", { show_alert: false });

  const chatId = ctx.chat.id;
  const recipeData = await getStepByStepData(chatId);

  if (!recipeData || !recipeData.steps || recipeData.steps.length === 0) {
    await ctx.answerCbQuery("Пошаговый рецепт не найден. Начните заново.");
    return;
  }

  if (recipeData.currentStep <= 0) {
    await ctx.answerCbQuery("Вы уже на первом шаге.");
    return;
  }

  if (recipeData.isNavigating) {
    await ctx.answerCbQuery("⏳ Загрузка... Подождите.");
    return;
  }

  recipeData.isNavigating = true;
  recipeData.currentStep--;
  await setStepByStepData(chatId, recipeData);

  try {
    await updateStepMessage(ctx, chatId, recipeData.currentStep, recipeData.steps);
  } catch (error) {
    console.error('Ошибка при переходе к предыдущему шагу:', error);
  } finally {
    recipeData.isNavigating = false;
    await setStepByStepData(chatId, recipeData);
  }
});

// Обработчик для перехода к следующему шагу
bot.action("step_next", async (ctx) => {
  await ctx.answerCbQuery("⏳ Загрузка...", { show_alert: false });

  const chatId = ctx.chat.id;
  const recipeData = await getStepByStepData(chatId);

  if (!recipeData || !recipeData.steps || recipeData.steps.length === 0) {
    await ctx.answerCbQuery("Пошаговый рецепт не найден. Начните заново.");
    return;
  }

  if (recipeData.currentStep >= recipeData.steps.length - 1) {
    await ctx.answerCbQuery("Вы уже на последнем шаге.");
    return;
  }

  if (recipeData.isNavigating) {
    await ctx.answerCbQuery("⏳ Загрузка... Подождите.");
    return;
  }

  recipeData.isNavigating = true;
  recipeData.currentStep++;
  await setStepByStepData(chatId, recipeData);

  try {
    await updateStepMessage(ctx, chatId, recipeData.currentStep, recipeData.steps);
  } catch (error) {
    console.error('Ошибка при переходе к следующему шагу:', error);
  } finally {
    recipeData.isNavigating = false;
    await setStepByStepData(chatId, recipeData);
  }
});

// Обработчик для возврата назад (к меню блюда)
bot.action("step_back", async (ctx) => {
  await ctx.answerCbQuery();

  const chatId = ctx.chat.id;
  const recipeData = await getStepByStepData(chatId);

  // Удаляем сообщение со шагом
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Игнорируем ошибки удаления
  }

  if (recipeData && recipeData.dishMessageId) {
    // Восстанавливаем исходное сообщение с блюдом
    try {
      // Используем сохраненные данные из recipeData, если они есть
      // Иначе получаем из текущего состояния
      let url = recipeData.url;
      let dishType = recipeData.dishType;
      let isInFav = recipeData.isInFav;
      let hasHistory = recipeData.hasHistory;
      let recipeRequested = recipeData.recipeRequested;

      // Если данных нет в recipeData, получаем из текущего состояния
      if (!url || !dishType) {
        const state = await getUserState(chatId);
        if (state === 1) dishType = 'breakfast';
        else if (state === 2) dishType = 'dinner';
        else if (state === 3) dishType = 'lunch';
        else if (state === 4) dishType = 'search';

        url = await getUserHref(chatId, dishType);
      }

      // Для рецептов из избранного статус всегда true
      // Для обычных рецептов проверяем актуальный статус при возврате
      if (recipeData.favoriteId) {
        isInFav = true; // Рецепт из избранного всегда в избранном
      } else if (url) {
        // Проверяем актуальный статус избранного при возврате
        isInFav = await isInFavorites(chatId, url);
      }

      // Если другие данные не были сохранены, получаем их
      if (typeof hasHistory !== 'boolean' && dishType) {
        hasHistory = await hasRecipeHistory(chatId, dishType);
      }
      if (typeof recipeRequested !== 'boolean' && dishType) {
        recipeRequested = await getRecipeRequested(chatId, dishType);
      }

      const isRecipe = url ? isRecipeUrl(url) : true; // По умолчанию считаем рецептом, если URL есть

      // Если это рецепт из избранного, используем специальную клавиатуру
      let keyboard;
      if (recipeData.favoriteId) {
        keyboard = getFavoriteRecipeKeyboard(recipeData.favoriteId);
      } else {
        keyboard = getDetailedMenuKeyboard(recipeRequested, hasHistory, isInFav, isRecipe);
      }

      if (recipeData.hasPhoto && recipeData.dishPhotoFileId) {
        await ctx.telegram.editMessageMedia(
          chatId,
          recipeData.dishMessageId,
          null,
          {
            type: 'photo',
            media: recipeData.dishPhotoFileId,
            caption: recipeData.dishMessageText
          },
          { reply_markup: keyboard.reply_markup }
        );
      } else {
        await ctx.telegram.editMessageText(
          chatId,
          recipeData.dishMessageId,
          null,
          recipeData.dishMessageText,
          keyboard
        );
      }
    } catch (e) {
      // Если не удалось отредактировать, отправляем новое
      const hasHistory = await hasRecipeHistory(chatId, 'breakfast');
      const url = await getUserHref(chatId, 'breakfast');
      const isRecipe = url ? isRecipeUrl(url) : true;
      await ctx.reply(recipeData.dishMessageText, getDetailedMenuKeyboard(false, hasHistory, false, isRecipe));
    }
  }

  // Очищаем состояние
  await clearStepByStepData(chatId);
});

// Обработчики для неактивных кнопок навигации
bot.action("step_prev_disabled", async (ctx) => {
  await ctx.answerCbQuery("Вы уже на первом шаге.");
});

bot.action("step_next_disabled", async (ctx) => {
  await ctx.answerCbQuery("Вы уже на последнем шаге.");
});

bot.action("step_info", async (ctx) => {
  await ctx.answerCbQuery();
});

// Обработчик списка избранного
bot.action("favorites_list", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const favorites = await getFavoritesFromDB(chatId, 0, 50);

  if (!favorites || favorites.length === 0) {
    await ctx.reply("⭐ Ваше избранное пусто.\n\nДобавьте рецепты в избранное, нажав кнопку '⭐ Добавить в избранное' на странице рецепта.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }]
        ]
      }
    });
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const keyboard = getFavoritesKeyboard(favorites, 0, 5);
  let message = `⭐ Избранное (${favorites.length} рецептов):\n\n`;
  const pageFavorites = favorites.slice(0, 5);
  pageFavorites.forEach((fav, index) => {
    message += `${index + 1}. ${fav.recipe_title}\n`;
  });
  if (favorites.length > 5) {
    message += `\nПоказано 5 из ${favorites.length} рецептов`;
  }

  await ctx.reply(validateAndTruncateMessage(message), keyboard);
  // Убираем индикатор загрузки после успешной отправки
  await ctx.answerCbQuery().catch(() => {});
});

// Обработчик просмотра рецепта из избранного
bot.action(/^favorite_(\d+)$/, async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const favoriteId = parseInt(ctx.match[1]);

  try {
    const response = await axios.get(`${databaseServiceUrl}/favorites/${chatId}/${favoriteId}`, {
      timeout: 10000
    });

    if (!response.data || !response.data.favorite) {
      await ctx.answerCbQuery("❌ Рецепт не найден в избранном");
      return;
    }

    const favorite = response.data.favorite;

    // Сохраняем URL для работы с ингредиентами и пошаговым рецептом
    await setUserHref(chatId, 'favorite', favorite.recipe_url);
    await setUserState(chatId, 5); // Специальное состояние для избранного

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
    // Убираем индикатор загрузки после успешной отправки
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка получения рецепта из избранного:', error);
    await ctx.answerCbQuery("❌ Ошибка при загрузке рецепта");
  }
});

// Обработчик удаления из избранного из списка
bot.action(/^remove_favorite_(\d+)$/, async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const favoriteId = parseInt(ctx.match[1]);

  try {
    const response = await axios.delete(`${databaseServiceUrl}/favorites/${chatId}/${favoriteId}`, {
      timeout: 10000
    });

    if (response.data && response.data.removed) {
      // Обновляем список избранного
      const favorites = await getFavoritesFromDB(chatId, 0, 50);

      if (!favorites || favorites.length === 0) {
        await ctx.telegram.editMessageText(
          chatId,
          ctx.callbackQuery.message.message_id,
          null,
          "⭐ Ваше избранное пусто.\n\nДобавьте рецепты в избранное, нажав кнопку '⭐ Добавить в избранное' на странице рецепта.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }]
              ]
            }
          }
        );
        await ctx.answerCbQuery("❌ Удалено из избранного");
        return;
      }

      const keyboard = getFavoritesKeyboard(favorites, 0, 5);
      let message = `⭐ Избранное (${favorites.length} рецептов):\n\n`;
      const pageFavorites = favorites.slice(0, 5);
      pageFavorites.forEach((fav, index) => {
        message += `${index + 1}. ${fav.recipe_title}\n`;
      });
      if (favorites.length > 5) {
        message += `\nПоказано 5 из ${favorites.length} рецептов`;
      }

      await ctx.telegram.editMessageText(
        chatId,
        ctx.callbackQuery.message.message_id,
        null,
        validateAndTruncateMessage(message),
        keyboard
      );
      await ctx.answerCbQuery("❌ Удалено из избранного");
    } else {
      await ctx.answerCbQuery("❌ Не удалось удалить из избранного");
    }
  } catch (error) {
    console.error('Ошибка удаления из избранного:', error);
    await ctx.answerCbQuery("❌ Ошибка при удалении");
  }
});

// Обработчик пагинации избранного
bot.action(/^favorites_page_(\d+)$/, async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const page = parseInt(ctx.match[1]);

  try {
    const favorites = await getFavoritesFromDB(chatId, 0, 50);

    if (!favorites || favorites.length === 0) {
      await ctx.telegram.editMessageText(
        chatId,
        ctx.callbackQuery.message.message_id,
        null,
        "⭐ Ваше избранное пусто.\n\nДобавьте рецепты в избранное, нажав кнопку '⭐ Добавить в избранное' на странице рецепта.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Вернуться на главную↩️", callback_data: "back_to_main" }]
            ]
          }
        }
      );
      return;
    }

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

    await ctx.telegram.editMessageText(
      chatId,
      ctx.callbackQuery.message.message_id,
      null,
      validateAndTruncateMessage(message),
      keyboard
    );
    // Убираем индикатор загрузки после успешного обновления
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка пагинации избранного:', error);
    await ctx.answerCbQuery("❌ Ошибка при загрузке страницы");
  }
});

// Обработчик информации о странице избранного
bot.action("favorites_info", async (ctx) => {
  await ctx.answerCbQuery();
});

// Обработчик ингредиентов из избранного
bot.action(/^favorite_ingredients_(\d+)$/, async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const favoriteId = parseInt(ctx.match[1]);

  try {
    const response = await axios.get(`${databaseServiceUrl}/favorites/${chatId}/${favoriteId}`, {
      timeout: 10000
    });

    if (!response.data || !response.data.favorite) {
      await ctx.answerCbQuery("❌ Рецепт не найден");
      return;
    }

    const favorite = response.data.favorite;
    const url = favorite.recipe_url;

    // Получаем полный рецепт с ингредиентами
    const result = await getFullRecipe(url, favorite.dish_type || 'breakfast');

    if (!result || !result.recipeText) {
      throw new Error('Пустой ответ от сервиса парсинга');
    }

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const keyboard = getFavoriteRecipeKeyboard(favoriteId);

    const currentMessage = ctx.callbackQuery?.message;
    if (currentMessage) {
      if (currentMessage.photo && currentMessage.photo.length > 0) {
        await ctx.telegram.editMessageMedia(
          chatId,
          currentMessage.message_id,
          null,
          {
            type: 'photo',
            media: currentMessage.photo[currentMessage.photo.length - 1].file_id,
            caption: recipeText
          },
          { reply_markup: keyboard.reply_markup }
        );
      } else {
        await ctx.telegram.editMessageText(
          chatId,
          currentMessage.message_id,
          null,
          recipeText,
          keyboard
        );
      }
    } else {
      await ctx.reply(recipeText, keyboard);
    }
    // Убираем индикатор загрузки после успешного обновления
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    console.error('Ошибка получения ингредиентов из избранного:', error);
    await ctx.answerCbQuery("❌ Ошибка при загрузке рецепта");
  }
});

// Обработчик пошагового рецепта из избранного
bot.action(/^favorite_step_by_step_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("⏳ Загружаю пошаговый рецепт...", { show_alert: false });

  const chatId = ctx.chat.id;
  const favoriteId = parseInt(ctx.match[1]);

  try {
    const response = await axios.get(`${databaseServiceUrl}/favorites/${chatId}/${favoriteId}`, {
      timeout: 10000
    });

    if (!response.data || !response.data.favorite) {
      await ctx.answerCbQuery("❌ Рецепт не найден");
      return;
    }

    const favorite = response.data.favorite;
    const url = favorite.recipe_url;

    // Сохраняем информацию о исходном сообщении
    const currentMessage = ctx.callbackQuery?.message;
    const dishMessageId = currentMessage?.message_id;
    const dishMessageText = currentMessage?.text || currentMessage?.caption || '';
    const hasPhoto = !!(currentMessage?.photo && currentMessage?.photo.length > 0);
    const dishPhotoFileId = hasPhoto ? currentMessage.photo[currentMessage.photo.length - 1]?.file_id : null;

    const loadingMsg = await ctx.reply("⏳ Загрузка пошагового рецепта...");

    const steps = await getStepByStepRecipe(url);

    if (!steps || steps.length === 0) {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await ctx.reply("Не удалось получить пошаговый рецепт. Попробуйте еще раз.");
      return;
    }

    // Проверяем статус избранного (должен быть true, так как это из избранного)
    const isInFav = true; // Рецепт из избранного всегда в избранном
    const hasHistory = false; // Для рецептов из избранного истории нет
    const recipeRequested = false; // Рецепт уже запрошен

    // Сохраняем состояние в Redis (включая URL и статус избранного)
    await setStepByStepData(chatId, {
      steps: steps,
      currentStep: 0,
      dishMessageId: dishMessageId,
      dishMessageText: dishMessageText,
      hasPhoto: hasPhoto,
      dishPhotoFileId: dishPhotoFileId,
      isNavigating: false,
      favoriteId: favoriteId, // Сохраняем ID избранного для возврата
      url: url, // Сохраняем URL рецепта
      dishType: 'favorite', // Специальный тип для избранного
      isInFav: isInFav, // Сохраняем статус избранного (всегда true)
      hasHistory: hasHistory, // Сохраняем наличие истории
      recipeRequested: recipeRequested // Сохраняем флаг запрошенного рецепта
    });

    // Отображаем первый шаг
    await displayStep(ctx, chatId, 0, steps, loadingMsg);
  } catch (error) {
    console.error('Ошибка получения пошагового рецепта из избранного:', error);
    try {
      await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery?.message?.message_id).catch(() => {});
    } catch (e) {}
    await ctx.reply("❌ Ошибка при загрузке пошагового рецепта. Попробуйте позже.");
  }
});

// Обработчик возврата на главную
bot.action("back_to_main", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  await setUserState(chatId, 0);

  const favoritesCount = await getFavoritesCount(chatId);
  const mainMenuKeyboard = {
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
  };

  const currentMessage = ctx.callbackQuery?.message;
  const messageText = "Выберите действие";

  try {
    if (currentMessage) {
      // Пытаемся отредактировать существующее сообщение
      if (currentMessage.photo && currentMessage.photo.length > 0) {
        // Если было фото, заменяем на текст с клавиатурой
        try {
          await ctx.telegram.editMessageMedia(
            chatId,
            currentMessage.message_id,
            null,
            {
              type: 'photo',
              media: currentMessage.photo[currentMessage.photo.length - 1].file_id,
              caption: messageText
            },
            mainMenuKeyboard
          );
        } catch (e) {
          // Если не удалось отредактировать медиа, удаляем и отправляем новое
          await ctx.telegram.deleteMessage(chatId, currentMessage.message_id).catch(() => {});
          await ctx.reply(messageText, mainMenuKeyboard);
        }
      } else {
        // Если было текстовое сообщение, редактируем его
        await ctx.telegram.editMessageText(
          chatId,
          currentMessage.message_id,
          null,
          messageText,
          mainMenuKeyboard
        );
      }
    } else {
      // Если нет сообщения, отправляем новое
      await ctx.reply(messageText, mainMenuKeyboard);
    }
    // Убираем индикатор загрузки после успешного обновления
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    // Если редактирование не удалось, отправляем новое сообщение
    console.error('Ошибка при редактировании сообщения в back_to_main:', error);
    try {
      await ctx.reply(messageText, mainMenuKeyboard);
      await ctx.answerCbQuery().catch(() => {});
    } catch (e) {
      await ctx.answerCbQuery("❌ Ошибка при возврате на главную").catch(() => {});
    }
  }
});

// Обработчик закрытия меню
bot.action("close_menu", async (ctx) => {
  const chatId = ctx.chat.id;
  try {
    await ctx.editMessageText("Бот остановлен. Нажмите кнопку 'Запуск✅', чтобы начать работу", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Запуск✅", callback_data: "start_bot" }]
        ]
      }
    });
  } catch (error) {
    await ctx.reply("Бот остановлен. Нажмите кнопку 'Запуск✅', чтобы начать работу", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Запуск✅", callback_data: "start_bot" }]
        ]
      }
    });
  }
  await ctx.answerCbQuery();
});

// Обработчик запуска бота
bot.action("start_bot", async (ctx) => {
  const chatId = ctx.chat.id;
  await setUserState(chatId, 0);

  try {
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId) {
      await ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
    }
  } catch (e) {}

  const favoritesCount = await getFavoritesCount(chatId);

  await ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️', {
    reply_markup: {
      remove_keyboard: true
    }
  });

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

// Обработчик текстовых сообщений (поиск)
bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  const state = await getUserState(chatId);

  if (state === 4 && ctx.message.text && !ctx.message.text.startsWith('/')) {
    const searchQuery = ctx.message.text.trim();
    if (searchQuery) {
      try {
        // Сохраняем поисковый запрос для использования при нажатии "Другое блюдо"
        console.log(`💾 Сохранение поискового запроса: "${searchQuery}" для chatId=${chatId}`);
        await setUserSearchQuery(chatId, searchQuery);
        const result = await getRecipeFromParser('search', chatId, searchQuery);
        await setUserHref(chatId, 'search', result.url);
        await setRecipeRequested(chatId, 'search', false);

        const recipeText = validateAndTruncateMessage(result.recipeText);
        const hasHistory = await hasRecipeHistory(chatId, 'search');
        const isInFav = await isInFavorites(chatId, result.url);
        const isRecipe = isRecipeUrl(result.url);
        const keyboard = getDetailedMenuKeyboard(false, hasHistory, isInFav, isRecipe);

        if (result.hasPhoto && result.photoFileId) {
          await ctx.replyWithPhoto(result.photoFileId, {
            caption: recipeText,
            reply_markup: keyboard.reply_markup
          });
        } else {
          await ctx.reply(recipeText, keyboard);
        }
      } catch (error) {
        console.error('Ошибка в поиске:', error);
        // Показываем понятное сообщение об ошибке
        const errorMessage = error.message || 'Ошибка при поиске рецепта. Попробуйте позже.';
        await ctx.reply(`❌ ${errorMessage}`);
      }
    }
  }
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n🛑 Получен сигнал ${signal}, завершаем работу...`);
  try {
    await bot.stop(signal);
    await redis.quit();
    console.log('✅ Bot Service успешно остановлен');
    process.exit(0);
  } catch (err) {
    console.error('❌ Ошибка при завершении работы:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Запуск бота
bot.launch()
  .then(() => {
    console.log('✅ Bot Service запущен');
  })
  .catch((err) => {
    console.error('❌ Ошибка при запуске Bot Service:', err);
    process.exit(1);
  });

