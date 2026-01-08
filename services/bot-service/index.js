import { Telegraf } from "telegraf";
import { config } from "../shared/config.js";
import { getDetailedMenuKeyboard, getSearchKeyboard, getStepNavigationKeyboard, getFavoritesKeyboard, getFavoriteRecipeKeyboard, isRecipeUrl, getSubscriptionKeyboard, getSubscriptionInfoKeyboard } from "./innerButtons.js";
import { validateAndTruncateMessage } from "./messageUtils.js";
import Redis from "ioredis";
import axios from "axios";
import { createPayment, getPayment, parseWebhookEvent } from "./yookassa.js";
import { randomUUID } from "node:crypto";
import {
  isAdmin,
  getAdminMainKeyboard,
  handleGetUserInfo,
  handleSetFreeRequests,
  handleSetSubscription,
  processGetUserInfo,
  processSetFreeRequests,
  processSetSubscription
} from "./adminPanel.js";

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

// ==================== ФУНКЦИИ ДЛЯ РАБОТЫ С ПОДПИСКАМИ ====================

const FREE_REQUESTS_LIMIT = 10;

// Получение информации о подписке пользователя
const getSubscription = async (chatId) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/subscriptions/${chatId}`, {
      timeout: 10000
    });
    return response.data.subscription || null;
  } catch (error) {
    console.error('Ошибка получения подписки:', error.message);
    return null;
  }
};

// Проверка, есть ли у пользователя активная подписка
const hasActiveSubscription = async (chatId) => {
  const subscription = await getSubscription(chatId);
  if (!subscription) return false;

  const now = new Date();
  const endDate = new Date(subscription.end_date);
  return endDate > now && subscription.is_active;
};

// Получение или создание пользователя
const getOrCreateUser = async (chatId, username = null) => {
  try {
    const response = await axios.post(`${databaseServiceUrl}/users`, {
      chatId,
      username
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data.user;
  } catch (error) {
    console.error('Ошибка получения/создания пользователя:', error.message);
    return null;
  }
};

// Получение пользователя по chat_id
const getUserByChatId = async (chatId) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/users/chat/${chatId}`, {
      timeout: 10000
    });
    return response.data.user || null;
  } catch (error) {
    console.error('Ошибка получения пользователя:', error.message);
    return null;
  }
};

// Уменьшение счетчика бесплатных запросов
const decrementFreeRequests = async (chatId) => {
  try {
    const response = await axios.post(`${databaseServiceUrl}/users/${chatId}/free-requests/decrement`, {}, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data.user;
  } catch (error) {
    console.error('Ошибка уменьшения счетчика запросов:', error.message);
    throw error;
  }
};

// Проверка лимита запросов перед выполнением действия
const checkRequestLimit = async (chatId) => {
  // Проверяем подписку из таблицы users
  const user = await getUserByChatId(chatId);

  // Проверяем подписку в таблице users
  let hasSubscription = false;
  if (user && user.subscription_end_date) {
    const endDate = new Date(user.subscription_end_date);
    hasSubscription = endDate > new Date();
  }

  // Если нет подписки в users, проверяем таблицу subscriptions
  if (!hasSubscription) {
    hasSubscription = await hasActiveSubscription(chatId);
  }

  // Если есть активная подписка, лимит не применяется
  if (hasSubscription) {
    console.log(`✅ Проверка лимита для chatId=${chatId}: есть активная подписка, лимит не применяется`);
    return { allowed: true, remaining: Infinity, hasSubscription: true };
  }

  // Для бесплатных пользователей проверяем лимит из таблицы users
  const freeRequests = user?.free_requests || 0;

  console.log(`📊 Проверка лимита для chatId=${chatId}: бесплатных запросов ${freeRequests}`);

  if (freeRequests <= 0) {
    console.log(`❌ Лимит исчерпан для chatId=${chatId}`);
    return { allowed: false, remaining: 0, hasSubscription: false };
  }

  return { allowed: true, remaining: freeRequests, hasSubscription: false };
};

// Создание подписки
const createSubscription = async (chatId, subscriptionType, months) => {
  try {
    const response = await axios.post(`${databaseServiceUrl}/subscriptions`, {
      chatId,
      subscriptionType,
      months
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data.subscription;
  } catch (error) {
    console.error('Ошибка создания подписки:', error.message);
    throw error;
  }
};

// Получение подписок, которые скоро истекают (для уведомлений)
const getExpiringSubscriptions = async (days = 3) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/subscriptions/expiring-soon`, {
      params: { days },
      timeout: 10000
    });
    return response.data.subscriptions || [];
  } catch (error) {
    console.error('Ошибка получения истекающих подписок:', error.message);
    return [];
  }
};

// Обработчик команды /start
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.from?.username;

  await setUserState(chatId, 0);

  // Создаем или обновляем пользователя в базе
  try {
    await getOrCreateUser(chatId, username);
  } catch (error) {
    console.error('Ошибка при создании пользователя:', error);
  }

  const favoritesCount = await getFavoritesCount(chatId);

  await ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️', {
    reply_markup: {
      remove_keyboard: true
    }
  });

  // Проверяем подписку для отображения статуса
  const user = await getUserByChatId(chatId);
  let hasActiveSub = false;
  if (user && user.subscription_end_date) {
    hasActiveSub = new Date(user.subscription_end_date) > new Date();
  }
  if (!hasActiveSub) {
    const subscription = await getSubscription(chatId);
    hasActiveSub = subscription && new Date(subscription.end_date) > new Date() && subscription.is_active;
  }

  const freeRequests = user?.free_requests || 0;

  let menuText = "Выберите что хотите приготовить или выполните поиск по продукту";
  if (!hasActiveSub) {
    menuText += `\n\n📊 Бесплатных запросов: ${freeRequests}`;
  }

  const mainMenuKeyboard = {
    inline_keyboard: [
      [{ text: "Завтрак🍏", callback_data: "breakfast" }],
      [{ text: "Обед🍜", callback_data: "dinner" }],
      [{ text: "Ужин🍝", callback_data: "lunch" }],
      [{ text: "Поиск🔎", callback_data: "search" }],
      [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
      [{ text: hasActiveSub ? "💳 Подписка активна" : "💳 Подписка", callback_data: "subscription_menu" }],
      [{ text: "Закрыть❌", callback_data: "close_menu" }]
    ]
  };

  await ctx.reply(menuText, {
    reply_markup: mainMenuKeyboard
  });
});

// Команда для админ-панели
bot.command("admin", async (ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.from?.username;

  if (!isAdmin(username)) {
    await ctx.reply("❌ У вас нет доступа к админ-панели.");
    return;
  }

  await ctx.reply("🔐 **Админ-панель**\n\nВыберите действие:", {
    parse_mode: 'Markdown',
    ...getAdminMainKeyboard()
  });
});

// Хранилище состояний админ-панели: chatId -> state
const adminStates = new Map();

// Функции для работы с состоянием админ-панели
const getAdminState = (chatId) => {
  return adminStates.get(chatId) || null;
};

const setAdminState = (chatId, state) => {
  if (state) {
    adminStates.set(chatId, state);
  } else {
    adminStates.delete(chatId);
  }
};

// Обработчики админ-панели
bot.action("admin_get_user_info", async (ctx) => {
  const username = ctx.from?.username;
  if (!isAdmin(username)) {
    await ctx.answerCbQuery("❌ У вас нет доступа");
    return;
  }
  const state = await handleGetUserInfo(ctx);
  if (state) {
    setAdminState(ctx.chat.id, state);
  }
});

bot.action("admin_set_free_requests", async (ctx) => {
  const username = ctx.from?.username;
  if (!isAdmin(username)) {
    await ctx.answerCbQuery("❌ У вас нет доступа");
    return;
  }
  const state = await handleSetFreeRequests(ctx);
  if (state) {
    setAdminState(ctx.chat.id, state);
  }
});

bot.action("admin_set_subscription", async (ctx) => {
  const username = ctx.from?.username;
  if (!isAdmin(username)) {
    await ctx.answerCbQuery("❌ У вас нет доступа");
    return;
  }
  const state = await handleSetSubscription(ctx);
  if (state) {
    setAdminState(ctx.chat.id, state);
  }
});

bot.action("admin_close", async (ctx) => {
  const username = ctx.from?.username;
  if (!isAdmin(username)) {
    await ctx.answerCbQuery("❌ У вас нет доступа");
    return;
  }
  await ctx.answerCbQuery();
  setAdminState(ctx.chat.id, null);
  await ctx.editMessageText("✅ Админ-панель закрыта");
});

bot.action("admin_cancel", async (ctx) => {
  const username = ctx.from?.username;
  if (!isAdmin(username)) {
    await ctx.answerCbQuery("❌ У вас нет доступа");
    return;
  }
  await ctx.answerCbQuery();
  setAdminState(ctx.chat.id, null);
  await ctx.editMessageText("🔐 **Админ-панель**\n\nВыберите действие:", {
    parse_mode: 'Markdown',
    ...getAdminMainKeyboard()
  });
});

// Обработчик выбора завтрака
bot.action("breakfast", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;

  // Проверяем лимит запросов
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery("❌ У вас закончились бесплатные запросы");
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

  await setUserState(chatId, 1);

  try {
    const result = await getRecipeFromParser('breakfast', chatId);
    // Увеличиваем счетчик запросов только после успешного получения рецепта
    try {
      if (!limitCheck.hasSubscription) {
        try {
          await decrementFreeRequests(chatId);
        } catch (error) {
          console.error('Ошибка при уменьшении счетчика запросов:', error);
        }
      }
      console.log(`✅ breakfast: счетчик увеличен, текущее значение: ${incremented.request_count}`);
    } catch (error) {
      console.error('❌ Ошибка увеличения счетчика запросов:', error.message);
    }
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

  // Проверяем лимит запросов
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery("❌ У вас закончились бесплатные запросы");
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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
    // Увеличиваем счетчик запросов только после успешного получения рецепта
    try {
      if (!limitCheck.hasSubscription) {
        try {
          await decrementFreeRequests(chatId);
        } catch (error) {
          console.error('Ошибка при уменьшении счетчика запросов:', error);
        }
      }
      console.log(`✅ dinner: счетчик увеличен, текущее значение: ${incremented.request_count}`);
    } catch (error) {
      console.error('❌ Ошибка увеличения счетчика запросов:', error.message);
    }
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

  // Проверяем лимит запросов
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery("❌ У вас закончились бесплатные запросы");
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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
    // Увеличиваем счетчик запросов только после успешного получения рецепта
    try {
      if (!limitCheck.hasSubscription) {
        try {
          await decrementFreeRequests(chatId);
        } catch (error) {
          console.error('Ошибка при уменьшении счетчика запросов:', error);
        }
      }
      console.log(`✅ lunch: счетчик увеличен, текущее значение: ${incremented.request_count}`);
    } catch (error) {
      console.error('❌ Ошибка увеличения счетчика запросов:', error.message);
    }
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

  // Проверка лимита запросов ПЕРЕД выполнением
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery("❌ У вас закончились бесплатные запросы");
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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

    // Уменьшаем счетчик бесплатных запросов, если нет подписки
    if (!limitCheck.hasSubscription) {
      try {
        await decrementFreeRequests(chatId);
      } catch (error) {
        console.error('Ошибка при уменьшении счетчика запросов:', error);
      }
    }

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
      // Рецепт успешно добавлен, обновляем кнопку без уведомления
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
    await ctx.answerCbQuery().catch(() => {});
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

  // Проверяем лимит запросов
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery("❌ У вас закончились бесплатные запросы");
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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

    // Получаем новый рецепт (вакансии тоже показываем с кнопкой "Другое блюдо")
    const result = await getRecipeFromParser(dishType, chatId, searchQuery, true);

    // Проверяем, не совпадает ли новый рецепт с текущим (до обновления в Redis)
    if (prevUrl === result.url && currentMessage) {
      // Если рецепт тот же, просто уведомляем пользователя (без увеличения счетчика)
      await ctx.answerCbQuery("Это то же самое блюдо. Попробуйте еще раз.");
      return;
    }

    // Увеличиваем счетчик запросов только после успешного получения РАЗНОГО рецепта
    try {
      if (!limitCheck.hasSubscription) {
        try {
          await decrementFreeRequests(chatId);
        } catch (error) {
          console.error('Ошибка при уменьшении счетчика запросов:', error);
        }
      }
      console.log(`✅ another_dish: счетчик увеличен, текущее значение: ${incremented.request_count}, url=${result.url}`);
    } catch (error) {
      console.error('❌ Ошибка увеличения счетчика запросов:', error.message);
      // Продолжаем выполнение даже при ошибке счетчика
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

  // Проверка лимита запросов ПЕРЕД выполнением
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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

    // Уменьшаем счетчик бесплатных запросов, если нет подписки
    if (!limitCheck.hasSubscription) {
      try {
        await decrementFreeRequests(chatId);
      } catch (error) {
        console.error('Ошибка при уменьшении счетчика запросов:', error);
      }
    }

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
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

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

      // При возврате из пошагового рецепта всегда показываем все кнопки (recipeRequested = false)
      // чтобы пользователь мог снова выбрать "Пошаговый рецепт" или "Ингредиенты"
      recipeRequested = false;

      // Если это рецепт из избранного, используем специальную клавиатуру
      let keyboard;
      if (recipeData.favoriteId) {
        keyboard = getFavoriteRecipeKeyboard(recipeData.favoriteId);
      } else {
        keyboard = getDetailedMenuKeyboard(recipeRequested, hasHistory, isInFav, isRecipe);
      }

      // Также сбрасываем флаг recipeRequested в Redis
      if (dishType) {
        await setRecipeRequested(chatId, dishType, false);
      }

      if (recipeData.hasPhoto && recipeData.dishPhotoFileId) {
        try {
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
        } catch (editError) {
          // Игнорируем ошибку "message is not modified" - это нормально
          if (editError.response?.error_code === 400 &&
              editError.response?.description?.includes('message is not modified')) {
            // Сообщение уже имеет правильное содержимое, это нормально
          } else {
            throw editError;
          }
        }
      } else {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            recipeData.dishMessageId,
            null,
            recipeData.dishMessageText,
            keyboard
          );
        } catch (editError) {
          // Игнорируем ошибку "message is not modified" - это нормально
          if (editError.response?.error_code === 400 &&
              editError.response?.description?.includes('message is not modified')) {
            // Сообщение уже имеет правильное содержимое, это нормально
          } else {
            throw editError;
          }
        }
      }
      // Убираем индикатор загрузки после успешного восстановления
      await ctx.answerCbQuery().catch(() => {});
    } catch (e) {
      console.error('Ошибка при восстановлении исходного сообщения:', e);
      // Если не удалось отредактировать исходное сообщение,
      // это значит, что оно было удалено или изменено
      // В этом случае не создаем новое сообщение, чтобы не было дублей
      // Просто убираем индикатор загрузки
      await ctx.answerCbQuery().catch(() => {});
    }
  } else {
    // Если нет данных о рецепте, просто убираем индикатор
    await ctx.answerCbQuery().catch(() => {});
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

  // Проверка лимита запросов - блокируем просмотр избранного если нет запросов
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery("❌ У вас закончились бесплатные запросы");
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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

    // Уменьшаем счетчик бесплатных запросов, если нет подписки
    if (!limitCheck.hasSubscription) {
      try {
        await decrementFreeRequests(chatId);
      } catch (error) {
        console.error('Ошибка при уменьшении счетчика запросов:', error);
      }
    }

    // Уменьшаем счетчик бесплатных запросов, если нет подписки
    if (!limitCheck.hasSubscription) {
      try {
        await decrementFreeRequests(chatId);
      } catch (error) {
        console.error('Ошибка при уменьшении счетчика запросов:', error);
      }
    }

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

  // Проверка лимита запросов ПЕРЕД выполнением
  const limitCheck = await checkRequestLimit(chatId);
  if (!limitCheck.allowed) {
    await ctx.reply(
      `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
      `💡 Для получения подписки обратитесь к администратору.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
          ]
        }
      }
    );
    return;
  }

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

    // Уменьшаем счетчик бесплатных запросов, если нет подписки
    if (!limitCheck.hasSubscription) {
      try {
        await decrementFreeRequests(chatId);
      } catch (error) {
        console.error('Ошибка при уменьшении счетчика запросов:', error);
      }
    }

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

// Функция для проверки и активации ожидающих платежей (fallback если webhook не работает)
const checkPendingPayments = async (chatId) => {
  try {
    // Получаем все ожидающие платежи пользователя
    const response = await axios.get(`${databaseServiceUrl}/payments`, {
      params: { chatId: chatId.toString(), status: 'pending' },
      timeout: 10000
    }).catch(() => ({ data: { payments: [] } }));

    const pendingPayments = response.data.payments || [];

    for (const payment of pendingPayments) {
      if (payment.yookassa_payment_id) {
        try {
          // Проверяем статус платежа в ЮKassa
          const yookassaPayment = await getPayment(payment.yookassa_payment_id);

          if (yookassaPayment.status === 'succeeded' && payment.status !== 'succeeded') {
            // Обновляем статус в БД
            await axios.put(`${databaseServiceUrl}/payments/${payment.payment_id}`, {
              status: 'succeeded',
              yookassaPaymentId: payment.yookassa_payment_id
            }, {
              timeout: 10000,
              headers: { 'Content-Type': 'application/json' }
            }).catch(() => {});

            // Активируем подписку
            await createSubscription(chatId, payment.subscription_type, payment.months);

            return {
              success: true,
              message: `✅ Подписка активирована!\n\n` +
                       `📅 Срок действия: ${payment.months} ${payment.months === 1 ? 'месяц' : payment.months < 5 ? 'месяца' : 'месяцев'}\n` +
                       `💰 Сумма: ${payment.amount}₽\n\n` +
                       `🎉 Теперь у вас неограниченный доступ к рецептам!`
            };
          } else if (yookassaPayment.status === 'canceled') {
            // Обновляем статус отмененного платежа
            await axios.put(`${databaseServiceUrl}/payments/${payment.payment_id}`, {
              status: 'canceled',
              yookassaPaymentId: payment.yookassa_payment_id
            }, {
              timeout: 10000,
              headers: { 'Content-Type': 'application/json' }
            }).catch(() => {});
          }
        } catch (error) {
          console.error('Ошибка проверки платежа:', error.message);
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Ошибка проверки ожидающих платежей:', error.message);
    return null;
  }
};

// Обработчик возврата на главную
bot.action("back_to_main", async (ctx) => {
  // Не вызываем answerCbQuery сразу, чтобы индикатор загрузки оставался на кнопке

  const chatId = ctx.chat.id;
  const currentMessage = ctx.callbackQuery?.message;

  // Проверяем ожидающие платежи (fallback если webhook не работает)
  const paymentCheck = await checkPendingPayments(chatId);
  if (paymentCheck && paymentCheck.success) {
    await ctx.reply(paymentCheck.message, {
      reply_markup: { inline_keyboard: [[{ text: "◀️ Вернуться на главную", callback_data: "back_to_main" }]] }
    }).catch(() => {});
  }

  // Проверяем, есть ли активный пошаговый рецепт
  const recipeData = await getStepByStepData(chatId);

  // Если есть активный пошаговый рецепт, удаляем текущее сообщение со шагом
  if (recipeData && currentMessage) {
    try {
      await ctx.telegram.deleteMessage(chatId, currentMessage.message_id).catch(() => {});
    } catch (e) {
      // Игнорируем ошибки удаления
    }
    // Очищаем данные пошагового рецепта
    await clearStepByStepData(chatId);
  }

  await setUserState(chatId, 0);

  const favoritesCount = await getFavoritesCount(chatId);
  // Проверяем подписку для отображения статуса
  // Проверяем подписку из таблицы users
  const user = await getUserByChatId(chatId);
  let hasActiveSub = false;
  if (user && user.subscription_end_date) {
    hasActiveSub = new Date(user.subscription_end_date) > new Date();
  }
  if (!hasActiveSub) {
    const subscription = await getSubscription(chatId);
    hasActiveSub = subscription && new Date(subscription.end_date) > new Date() && subscription.is_active;
  }

  const freeRequests = user?.free_requests || 0;

  const mainMenuKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Завтрак🍏", callback_data: "breakfast" }],
        [{ text: "Обед🍜", callback_data: "dinner" }],
        [{ text: "Ужин🍝", callback_data: "lunch" }],
        [{ text: "Поиск🔎", callback_data: "search" }],
        [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
        [{ text: hasActiveSub ? "💳 Подписка активна" : "💳 Подписка", callback_data: "subscription_menu" }],
        [{ text: "Закрыть❌", callback_data: "close_menu" }]
      ]
    }
  };

  let messageText = "Выберите что хотите приготовить или выполните поиск по продукту";
  if (!hasActiveSub) {
    messageText += `\n\n📊 Бесплатных запросов: ${freeRequests}`;
  }

  try {
    // Если мы удалили сообщение пошагового рецепта, просто отправляем новое
    if (recipeData) {
      await ctx.reply(messageText, mainMenuKeyboard);
    } else if (currentMessage) {
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

  const username = ctx.from?.username;

  // Создаем или обновляем пользователя в базе
  try {
    await getOrCreateUser(chatId, username);
  } catch (error) {
    console.error('Ошибка при создании пользователя:', error);
  }

  const favoritesCount = await getFavoritesCount(chatId);

  // Проверяем подписку для отображения статуса
  const user = await getUserByChatId(chatId);
  let hasActiveSub = false;
  if (user && user.subscription_end_date) {
    hasActiveSub = new Date(user.subscription_end_date) > new Date();
  }
  if (!hasActiveSub) {
    const subscription = await getSubscription(chatId);
    hasActiveSub = subscription && new Date(subscription.end_date) > new Date() && subscription.is_active;
  }

  const freeRequests = user?.free_requests || 0;

  await ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️', {
    reply_markup: {
      remove_keyboard: true
    }
  });

  let menuText = "Выберите что хотите приготовить или выполните поиск по продукту";
  if (!hasActiveSub) {
    menuText += `\n\n📊 Бесплатных запросов: ${freeRequests}`;
  }

  await ctx.reply(menuText, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Завтрак🍏", callback_data: "breakfast" }],
        [{ text: "Обед🍜", callback_data: "dinner" }],
        [{ text: "Ужин🍝", callback_data: "lunch" }],
        [{ text: "Поиск🔎", callback_data: "search" }],
        [{ text: `⭐ Избранное${favoritesCount > 0 ? ` (${favoritesCount})` : ''}`, callback_data: "favorites_list" }],
        [{ text: hasActiveSub ? "💳 Подписка активна" : "💳 Подписка", callback_data: "subscription_menu" }],
        [{ text: "Закрыть❌", callback_data: "close_menu" }]
      ]
    }
  });
  await ctx.answerCbQuery();
});

// Обработчик текстовых сообщений (поиск и админ-панель)
bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;

  // Проверяем состояние админ-панели
  const adminState = getAdminState(chatId);
  if (adminState && ctx.message.text && !ctx.message.text.startsWith('/')) {
    const username = ctx.from?.username;
    if (!isAdmin(username)) {
      setAdminState(chatId, null);
      return;
    }

    const text = ctx.message.text.trim();

    switch (adminState) {
      case 'admin_awaiting_username_info':
        await processGetUserInfo(ctx, text, databaseServiceUrl);
        setAdminState(chatId, null);
        return;

      case 'admin_awaiting_free_requests':
        await processSetFreeRequests(ctx, text, databaseServiceUrl);
        setAdminState(chatId, null);
        return;

      case 'admin_awaiting_subscription':
        await processSetSubscription(ctx, text, databaseServiceUrl);
        setAdminState(chatId, null);
        return;
    }
  }

  const state = await getUserState(chatId);

  if (state === 4 && ctx.message.text && !ctx.message.text.startsWith('/')) {
    const searchQuery = ctx.message.text.trim();
    if (searchQuery) {
      // Проверяем лимит запросов
      const limitCheck = await checkRequestLimit(chatId);
      if (!limitCheck.allowed) {
        const subscriptionKeyboard = getSubscriptionInfoKeyboard();
        await ctx.reply(
          `❌ У вас закончились бесплатные запросы (0 осталось).\n\n` +
          `💡 Для получения подписки обратитесь к администратору.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Вернуться в меню↩️", callback_data: "back_to_main" }]
              ]
            }
          }
        );
        return;
      }

      try {
        // Сохраняем поисковый запрос для использования при нажатии "Другое блюдо"
        console.log(`💾 Сохранение поискового запроса: "${searchQuery}" для chatId=${chatId}`);
        await setUserSearchQuery(chatId, searchQuery);
        // Получаем рецепт (вакансии тоже показываем с кнопкой "Другое блюдо")
        const result = await getRecipeFromParser('search', chatId, searchQuery, true);

        // Уменьшаем счетчик запросов только после успешного получения рецепта
        try {
          if (!limitCheck.hasSubscription) {
            await decrementFreeRequests(chatId);
          }
        } catch (error) {
          console.error('Ошибка при уменьшении счетчика запросов:', error);
        }

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

// ==================== ОБРАБОТЧИКИ ПОДПИСКИ ====================

// Обработчик меню подписки
bot.action("subscription_menu", async (ctx) => {
  await ctx.answerCbQuery();

  const chatId = ctx.chat.id;

  // Проверяем подписку из таблицы users
  const user = await getUserByChatId(chatId);
  let hasActiveSub = false;
  let subscriptionEndDate = null;

  if (user && user.subscription_end_date) {
    subscriptionEndDate = new Date(user.subscription_end_date);
    hasActiveSub = subscriptionEndDate > new Date();
  }
  if (!hasActiveSub) {
    const subscription = await getSubscription(chatId);
    if (subscription && subscription.end_date) {
      subscriptionEndDate = new Date(subscription.end_date);
      hasActiveSub = subscriptionEndDate > new Date() && subscription.is_active;
    }
  }

  let message = "💳 **Подписка**\n\n";

  if (hasActiveSub && subscriptionEndDate) {
    const daysLeft = Math.ceil((subscriptionEndDate - new Date()) / (1000 * 60 * 60 * 24));
    message += `✅ У вас активная подписка!\n`;
    message += `📅 Подписка действует до: ${subscriptionEndDate.toLocaleDateString('ru-RU')}\n`;
    message += `⏰ Осталось дней: ${daysLeft}\n\n`;
    message += `💡 С подпиской у вас неограниченный доступ к рецептам!\n\n`;
    message += `Вы можете продлить подписку:`;
  } else {
    const freeRequests = user?.free_requests || 0;
    message += `📊 Бесплатных запросов осталось: ${freeRequests}\n\n`;
    message += `💡 С подпиской вы получите:\n`;
    message += `✨ Неограниченный доступ к рецептам\n`;
    message += `🚀 Без ограничений по количеству запросов\n\n`;
    message += `Выберите период подписки:`;
  }

  const keyboard = getSubscriptionKeyboard();
  await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
});

// Обработчик покупки подписки на месяц
bot.action("subscribe_month", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const chatId = ctx.chat.id;
  const price = 300;
  const months = 1;
  const subscriptionType = 'month';

  try {
    // Создаем уникальный ID платежа
    const paymentId = randomUUID();

    // Создаем запись о платеже в БД
    await axios.post(`${databaseServiceUrl}/payments`, {
      chatId,
      paymentId,
      subscriptionType,
      months,
      amount: price
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Ошибка создания записи о платеже:', err));

    // Создаем платеж в ЮKassa
    const payment = await createPayment({
      amount: price,
      description: `Подписка на ${months} ${months === 1 ? 'месяц' : 'месяца'}`,
      paymentId,
      metadata: {
        chatId: chatId.toString(),
        subscriptionType,
        months: months.toString()
      }
    });

    // Обновляем запись о платеже с ID из ЮKassa
    await axios.put(`${databaseServiceUrl}/payments/${paymentId}`, {
      status: 'pending',
      yookassaPaymentId: payment.id
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Ошибка обновления платежа:', err));

    await ctx.reply(
      `💳 **Оплата подписки**\n\n` +
      `📅 Период: ${months} ${months === 1 ? 'месяц' : 'месяца'}\n` +
      `💰 Сумма: ${price}₽\n\n` +
      `Нажмите на кнопку ниже, чтобы перейти к оплате:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Оплатить", url: payment.confirmationUrl }],
            [{ text: "◀️ Вернуться на главную", callback_data: "back_to_main" }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Ошибка создания платежа:', error);
    await ctx.reply("❌ Ошибка при создании платежа. Попробуйте позже.");
  }
});

// Обработчик покупки подписки на полгода
bot.action("subscribe_half_year", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const chatId = ctx.chat.id;
  const pricePerMonth = 270; // 300 - 10%
  const months = 6;
  const totalPrice = pricePerMonth * months;
  const subscriptionType = 'half_year';

  try {
    // Создаем уникальный ID платежа
    const paymentId = randomUUID();

    // Создаем запись о платеже в БД
    await axios.post(`${databaseServiceUrl}/payments`, {
      chatId,
      paymentId,
      subscriptionType,
      months,
      amount: totalPrice
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Ошибка создания записи о платеже:', err));

    // Создаем платеж в ЮKassa
    const payment = await createPayment({
      amount: totalPrice,
      description: `Подписка на ${months} месяцев (скидка 10%)`,
      paymentId,
      metadata: {
        chatId: chatId.toString(),
        subscriptionType,
        months: months.toString()
      }
    });

    // Обновляем запись о платеже с ID из ЮKassa
    await axios.put(`${databaseServiceUrl}/payments/${paymentId}`, {
      status: 'pending',
      yookassaPaymentId: payment.id
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Ошибка обновления платежа:', err));

    await ctx.reply(
      `💳 **Оплата подписки**\n\n` +
      `📅 Период: ${months} месяцев\n` +
      `💰 Сумма: ${totalPrice}₽ (${pricePerMonth}₽/месяц, скидка 10%)\n\n` +
      `Нажмите на кнопку ниже, чтобы перейти к оплате:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Оплатить", url: payment.confirmationUrl }],
            [{ text: "◀️ Вернуться на главную", callback_data: "back_to_main" }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Ошибка создания платежа:', error);
    await ctx.reply("❌ Ошибка при создании платежа. Попробуйте позже.");
  }
});

// Обработчик покупки подписки на год
bot.action("subscribe_year", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const chatId = ctx.chat.id;
  const pricePerMonth = 240; // 300 - 20%
  const months = 12;
  const totalPrice = pricePerMonth * months;
  const subscriptionType = 'year';

  try {
    // Создаем уникальный ID платежа
    const paymentId = randomUUID();

    // Создаем запись о платеже в БД
    await axios.post(`${databaseServiceUrl}/payments`, {
      chatId,
      paymentId,
      subscriptionType,
      months,
      amount: totalPrice
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Ошибка создания записи о платеже:', err));

    // Создаем платеж в ЮKassa
    const payment = await createPayment({
      amount: totalPrice,
      description: `Подписка на ${months} месяцев (скидка 20%)`,
      paymentId,
      metadata: {
        chatId: chatId.toString(),
        subscriptionType,
        months: months.toString()
      }
    });

    // Обновляем запись о платеже с ID из ЮKassa
    await axios.put(`${databaseServiceUrl}/payments/${paymentId}`, {
      status: 'pending',
      yookassaPaymentId: payment.id
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Ошибка обновления платежа:', err));

    await ctx.reply(
      `💳 **Оплата подписки**\n\n` +
      `📅 Период: ${months} месяцев\n` +
      `💰 Сумма: ${totalPrice}₽ (${pricePerMonth}₽/месяц, скидка 20%)\n\n` +
      `Нажмите на кнопку ниже, чтобы перейти к оплате:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Оплатить", url: payment.confirmationUrl }],
            [{ text: "◀️ Вернуться на главную", callback_data: "back_to_main" }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Ошибка создания платежа:', error);
    await ctx.reply("❌ Ошибка при создании платежа. Попробуйте позже.");
  }
});

// Функция для отправки уведомлений о скором окончании подписки
const sendSubscriptionExpiryNotifications = async () => {
  try {
    const expiringSubscriptions = await getExpiringSubscriptions(3); // За 3 дня до окончания

    for (const subscription of expiringSubscriptions) {
      const endDate = new Date(subscription.end_date);
      const daysLeft = Math.ceil((endDate - new Date()) / (1000 * 60 * 60 * 24));

      let message = `⏰ **Уведомление о подписке**\n\n`;
      message += `Ваша подписка заканчивается через ${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}!\n\n`;
      message += `📅 Дата окончания: ${endDate.toLocaleDateString('ru-RU')}\n\n`;
      message += `💳 Продлите подписку, чтобы продолжить пользоваться ботом без ограничений!`;

      try {
        await bot.telegram.sendMessage(subscription.chat_id, message, {
          parse_mode: 'Markdown',
          reply_markup: getSubscriptionKeyboard().reply_markup
        });
        console.log(`✅ Уведомление отправлено пользователю ${subscription.chat_id}`);
      } catch (error) {
        console.error(`❌ Ошибка отправки уведомления пользователю ${subscription.chat_id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Ошибка отправки уведомлений о подписке:', error);
  }
};

// Запускаем периодическую проверку истекающих подписок (каждый час)
setInterval(() => {
  sendSubscriptionExpiryNotifications().catch(console.error);
}, 60 * 60 * 1000); // Каждый час

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

