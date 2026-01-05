import { Telegraf } from "telegraf";
import { config } from "../shared/config.js";
import { getDetailedMenuKeyboard, getSearchKeyboard, getStepNavigationKeyboard, getFavoritesKeyboard, getFavoriteRecipeKeyboard } from "./innerButtons.js";
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
    const response = await axios.post(`${databaseServiceUrl}/favorites/add`, data, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data.added || false;
  } catch (error) {
    console.error('Ошибка добавления в избранное:', error.message);
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
  await ctx.answerCbQuery(); // Сразу убираем загрузку

  const chatId = ctx.chat.id;
  await setUserState(chatId, 1);

  const loadingMsg = await ctx.reply("🔍 Ищу рецепт...");

  try {
    const result = await getRecipeFromParser('breakfast', chatId);
    await setUserHref(chatId, 'breakfast', result.url);
    await setRecipeRequested(chatId, 'breakfast', false);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const keyboard = getDetailedMenuKeyboard(false, false, false);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.telegram.editMessageMedia(
        chatId,
        loadingMsg.message_id,
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
        loadingMsg.message_id,
        null,
        recipeText,
        keyboard
      );
    }
  } catch (error) {
    console.error('Ошибка в breakfast:', error);
    try {
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        "❌ Ошибка при получении рецепта. Попробуйте позже."
      );
    } catch (e) {
      await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
    }
  }
});

// Обработчик выбора обеда
bot.action("dinner", async (ctx) => {
  await ctx.answerCbQuery(); // Сразу убираем загрузку

  const chatId = ctx.chat.id;
  await setUserState(chatId, 2);

  const loadingMsg = await ctx.reply("🔍 Ищу рецепт...");

  try {
    const result = await getRecipeFromParser('dinner', chatId);
    await setUserHref(chatId, 'dinner', result.url);
    await setRecipeRequested(chatId, 'dinner', false);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const keyboard = getDetailedMenuKeyboard(false, false, false);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.telegram.editMessageMedia(
        chatId,
        loadingMsg.message_id,
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
        loadingMsg.message_id,
        null,
        recipeText,
        keyboard
      );
    }
  } catch (error) {
    console.error('Ошибка в dinner:', error);
    try {
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        "❌ Ошибка при получении рецепта. Попробуйте позже."
      );
    } catch (e) {
      await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
    }
  }
});

// Обработчик выбора ужина
bot.action("lunch", async (ctx) => {
  await ctx.answerCbQuery(); // Сразу убираем загрузку

  const chatId = ctx.chat.id;
  await setUserState(chatId, 3);

  const loadingMsg = await ctx.reply("🔍 Ищу рецепт...");

  try {
    const result = await getRecipeFromParser('lunch', chatId);
    await setUserHref(chatId, 'lunch', result.url);
    await setRecipeRequested(chatId, 'lunch', false);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const keyboard = getDetailedMenuKeyboard(false, false, false);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.telegram.editMessageMedia(
        chatId,
        loadingMsg.message_id,
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
        loadingMsg.message_id,
        null,
        recipeText,
        keyboard
      );
    }
  } catch (error) {
    console.error('Ошибка в lunch:', error);
    try {
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        "❌ Ошибка при получении рецепта. Попробуйте позже."
      );
    } catch (e) {
      await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
    }
  }
});

// Обработчик поиска
bot.action("search", async (ctx) => {
  const chatId = ctx.chat.id;
  await setUserState(chatId, 4);

  await ctx.reply("Введите поисковый запрос:", getSearchKeyboard());
  await ctx.answerCbQuery();
});

// Обработчик получения полного рецепта (Ингредиенты)
bot.action("ingredients", async (ctx) => {
  // Показываем индикатор загрузки на кнопке
  await ctx.answerCbQuery("⏳ Загружаю рецепт...", { show_alert: false });

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

  // Редактируем существующее сообщение, показывая загрузку
  const currentMessage = ctx.callbackQuery?.message;
  if (!currentMessage) {
    await ctx.reply("❌ Ошибка: сообщение не найдено");
    return;
  }

  try {
    // Показываем загрузку в существующем сообщении
    await ctx.telegram.editMessageText(
      chatId,
      currentMessage.message_id,
      null,
      "⏳ Загружаю рецепт...",
      { reply_markup: { inline_keyboard: [] } } // Временно убираем кнопки
    );
  } catch (e) {
    // Если не удалось отредактировать (например, фото), отправляем новое сообщение
    const loadingMsg = await ctx.reply("⏳ Загружаю рецепт...");
    try {
      const result = await getFullRecipe(url, dishType);
      await setRecipeRequested(chatId, dishType, true);

      const recipeText = validateAndTruncateMessage(result.recipeText);
      const isInFav = await isInFavorites(chatId, url);
      const keyboard = getDetailedMenuKeyboard(true, false, isInFav);

      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        recipeText,
        keyboard
      );
    } catch (error) {
      console.error('Ошибка в ingredients:', error);
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        "❌ Ошибка при загрузке рецепта"
      );
    }
    return;
  }

  try {
    const result = await getFullRecipe(url, dishType);

    if (!result || !result.recipeText) {
      throw new Error('Пустой ответ от сервиса парсинга');
    }

    await setRecipeRequested(chatId, dishType, true);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const isInFav = await isInFavorites(chatId, url);
    const keyboard = getDetailedMenuKeyboard(true, false, isInFav);

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
  await ctx.answerCbQuery(); // Сразу убираем загрузку

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
  const recipeText = currentMessage?.text || currentMessage?.caption || '';
  const recipeTitle = recipeText.split('\n')[0] || 'Рецепт без названия';

  const added = await addToFavorites(chatId, {
    url,
    title: recipeTitle,
    text: recipeText,
    dishType,
    hasPhoto: !!(currentMessage?.photo && currentMessage?.photo.length > 0),
    photoFileId: currentMessage?.photo?.[currentMessage.photo.length - 1]?.file_id || null
  });

  if (added) {
    // Уведомление через отдельное сообщение, так как answerCbQuery уже вызван
    await ctx.reply("✅ Добавлено в избранное!").catch(() => {});
  }

  const recipeRequested = await getRecipeRequested(chatId, dishType);
  const isInFav = await isInFavorites(chatId, url);
  const keyboard = getDetailedMenuKeyboard(recipeRequested, false, isInFav);

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
  await ctx.answerCbQuery(); // Сразу убираем загрузку

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
  const isInFav = await isInFavorites(chatId, url);
  const keyboard = getDetailedMenuKeyboard(recipeRequested, false, isInFav);

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

// Обработчик "Другое блюдо"
bot.action("another_dish", async (ctx) => {
  // НЕ вызываем answerCbQuery сразу - кнопка будет показывать состояние загрузки
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

  // Показываем индикатор загрузки на кнопке
  await ctx.answerCbQuery("🔍 Ищу новое блюдо...", { show_alert: false });

  // Сбрасываем флаг запрошенного рецепта
  await setRecipeRequested(chatId, dishType, false);

  // Пытаемся удалить старое сообщение, если оно есть
  const currentMessage = ctx.callbackQuery?.message;
  let loadingMsg = null;

  try {
    if (currentMessage) {
      // Редактируем существующее сообщение
      await ctx.telegram.editMessageText(
        chatId,
        currentMessage.message_id,
        null,
        "🔍 Ищу рецепт...",
        { reply_markup: { inline_keyboard: [] } } // Убираем кнопки временно
      );
      loadingMsg = currentMessage;
    } else {
      // Отправляем новое сообщение
      loadingMsg = await ctx.reply("🔍 Ищу рецепт...");
    }
  } catch (e) {
    // Если не удалось отредактировать, отправляем новое
    loadingMsg = await ctx.reply("🔍 Ищу рецепт...");
  }

  try {
    // При нажатии "Другое блюдо" принудительно обновляем рецепт
    const result = await getRecipeFromParser(dishType, chatId, null, true);
    await setUserHref(chatId, dishType, result.url);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const isInFav = await isInFavorites(chatId, result.url);
    const keyboard = getDetailedMenuKeyboard(false, false, isInFav);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.telegram.editMessageMedia(
        chatId,
        loadingMsg.message_id,
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
        loadingMsg.message_id,
        null,
        recipeText,
        keyboard
      );
    }
  } catch (error) {
    console.error('Ошибка в another_dish:', error);
    try {
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        "❌ Ошибка при получении рецепта. Попробуйте позже."
      );
    } catch (e) {
      await ctx.reply("❌ Ошибка при получении рецепта. Попробуйте позже.");
    }
  }
});

// Обработчик возврата к предыдущему рецепту (пока упрощенный)
bot.action("previous_recipe", async (ctx) => {
  await ctx.answerCbQuery("Функция временно недоступна");
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

  // Отправляем новое сообщение с пошаговым рецептом (как в оригинале)
  const loadingMsg = await ctx.reply("⏳ Загружаю пошаговый рецепт...");

  try {
    const result = await getFullRecipe(url, dishType);

    if (!result || !result.recipeText) {
      throw new Error('Пустой ответ от сервиса парсинга');
    }

    await setRecipeRequested(chatId, dishType, true);

    const recipeText = validateAndTruncateMessage(result.recipeText);
    const isInFav = await isInFavorites(chatId, url);
    const keyboard = getDetailedMenuKeyboard(true, false, isInFav);

    if (result.hasPhoto && result.photoFileId) {
      await ctx.telegram.editMessageMedia(
        chatId,
        loadingMsg.message_id,
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
        loadingMsg.message_id,
        null,
        recipeText,
        keyboard
      );
    }
  } catch (error) {
    console.error('Ошибка в step_by_step:', error);
    try {
      await ctx.telegram.editMessageText(
        chatId,
        loadingMsg.message_id,
        null,
        "❌ Ошибка при загрузке рецепта"
      );
    } catch (e) {
      await ctx.reply("❌ Ошибка при загрузке рецепта");
    }
  }
});

// Обработчик списка избранного
bot.action("favorites_list", async (ctx) => {
  await ctx.answerCbQuery(); // Сразу убираем загрузку

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
});

// Обработчик возврата на главную
bot.action("back_to_main", async (ctx) => {
  await ctx.answerCbQuery(); // Сразу убираем загрузку

  const chatId = ctx.chat.id;
  await setUserState(chatId, 0);

  const favoritesCount = await getFavoritesCount(chatId);

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
      const loadingMsg = await ctx.reply("🔍 Ищу рецепты...");

      try {
        const result = await getRecipeFromParser('search', chatId, searchQuery);
        await setUserHref(chatId, 'search', result.url);
        await setRecipeRequested(chatId, 'search', false);

        const recipeText = validateAndTruncateMessage(result.recipeText);
        const keyboard = getDetailedMenuKeyboard(false, false, false);

        if (result.hasPhoto && result.photoFileId) {
          await ctx.telegram.editMessageMedia(
            chatId,
            loadingMsg.message_id,
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
            loadingMsg.message_id,
            null,
            recipeText,
            keyboard
          );
        }
      } catch (error) {
        console.error('Ошибка в поиске:', error);
        try {
          await ctx.telegram.editMessageText(
            chatId,
            loadingMsg.message_id,
            null,
            "❌ Ошибка при поиске рецепта. Попробуйте позже."
          );
        } catch (e) {
          await ctx.reply("❌ Ошибка при поиске рецепта. Попробуйте позже.");
        }
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

