import axios from 'axios';

// Админ username (можно указать несколько через запятую)
// Например: 'DmitriyBuyanov' или 'DmitriyBuyanov, admin2, admin3'
const ADMIN_USERNAMES_STRING = 'DmitriyBuyanov';

/**
 * Получает список администраторов из строки
 */
const getAdminUsernames = () => {
  return ADMIN_USERNAMES_STRING
    .split(',')
    .map(name => name.trim().replace('@', '').toLowerCase())
    .filter(name => name.length > 0);
};

/**
 * Проверяет, является ли пользователь администратором
 */
export const isAdmin = (username) => {
  if (!username) return false;
  const cleanUsername = username.replace('@', '').toLowerCase();
  const adminUsernames = getAdminUsernames();
  return adminUsernames.includes(cleanUsername);
};

/**
 * Получает клавиатуру главного меню админ-панели
 */
export const getAdminMainKeyboard = () => {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Информация о пользователе', callback_data: 'admin_get_user_info' }],
        [{ text: '🎁 Выдать бесплатные запросы', callback_data: 'admin_set_free_requests' }],
        [{ text: '💳 Выдать подписку', callback_data: 'admin_set_subscription' }],
        [{ text: '❌ Закрыть админ-панель', callback_data: 'admin_close' }]
      ]
    }
  };
};

/**
 * Получает информацию о пользователе через API
 */
const getUserInfoFromAPI = async (databaseServiceUrl, username) => {
  try {
    const response = await axios.get(`${databaseServiceUrl}/users/username/${username}/info`, {
      timeout: 10000
    });
    return response.data.userInfo || null;
  } catch (error) {
    console.error('Ошибка получения информации о пользователе:', error.message);
    return null;
  }
};

/**
 * Форматирует информацию о пользователе для отправки
 */
export const formatUserInfo = (userInfo) => {
  if (!userInfo) {
    return '❌ Пользователь не найден.';
  }

  let message = `📊 **Информация о пользователе**\n\n`;
  message += `👤 Username: @${userInfo.username || 'не указан'}\n`;
  message += `🆔 Chat ID: ${userInfo.chatId}\n`;
  message += `🎁 Бесплатных запросов: ${userInfo.freeRequests}\n\n`;

  if (userInfo.hasSubscription) {
    message += `✅ **Подписка активна**\n`;
    message += `📅 Дней до окончания: ${userInfo.daysLeft}\n`;
    if (userInfo.subscriptionEndDate) {
      const endDate = new Date(userInfo.subscriptionEndDate);
      message += `📆 Дата окончания: ${endDate.toLocaleDateString('ru-RU')}\n`;
    }
  } else {
    message += `❌ **Подписка отсутствует**\n`;
  }

  message += `\n📅 Дата регистрации: ${new Date(userInfo.createdAt).toLocaleDateString('ru-RU')}`;

  return message;
};

/**
 * Обработчик команды получения информации о пользователе
 */
export const handleGetUserInfo = async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📝 Введите username пользователя (например: @username или username):',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Отмена', callback_data: 'admin_cancel' }]
        ]
      }
    }
  );

  return 'admin_awaiting_username_info';
};

/**
 * Обработчик команды выдачи бесплатных запросов
 */
export const handleSetFreeRequests = async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📝 Введите username пользователя и количество запросов через пробел:\n' +
    'Например: @username 10',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Отмена', callback_data: 'admin_cancel' }]
        ]
      }
    }
  );

  return 'admin_awaiting_free_requests';
};

/**
 * Обработчик команды выдачи подписки
 */
export const handleSetSubscription = async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📝 Введите username пользователя и количество дней подписки через пробел:\n' +
    'Например: @username 30',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Отмена', callback_data: 'admin_cancel' }]
        ]
      }
    }
  );

  return 'admin_awaiting_subscription';
};

/**
 * Обрабатывает ввод username для получения информации
 */
export const processGetUserInfo = async (ctx, text, databaseServiceUrl) => {
  const username = text.trim().replace('@', '');

  if (!username) {
    await ctx.reply('❌ Username не может быть пустым. Попробуйте снова.');
    return;
  }

  try {
    const userInfo = await getUserInfoFromAPI(databaseServiceUrl, username);

    if (!userInfo) {
      await ctx.reply(`❌ Пользователь @${username} не найден в базе данных.`);
      return;
    }

    const message = formatUserInfo(userInfo);
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: getAdminMainKeyboard().reply_markup
    });
  } catch (error) {
    console.error('Ошибка при получении информации о пользователе:', error);
    await ctx.reply('❌ Произошла ошибка при получении информации о пользователе.');
  }
};

/**
 * Обрабатывает ввод для выдачи бесплатных запросов
 */
export const processSetFreeRequests = async (ctx, text, databaseServiceUrl) => {
  const parts = text.trim().split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply('❌ Неверный формат. Используйте: @username количество\nНапример: @username 10');
    return;
  }

  const username = parts[0].replace('@', '');
  const count = parseInt(parts[1], 10);

  if (isNaN(count) || count < 0) {
    await ctx.reply('❌ Количество запросов должно быть положительным числом.');
    return;
  }

  try {
    const response = await axios.put(
      `${databaseServiceUrl}/users/username/${username}/free-requests`,
      { count },
      { timeout: 10000 }
    );

    const user = response.data.user;
    if (!user) {
      await ctx.reply(`❌ Пользователь @${username} не найден в базе данных.`);
      return;
    }

    await ctx.reply(
      `✅ Успешно установлено ${count} бесплатных запросов для пользователя @${username}`,
      { reply_markup: getAdminMainKeyboard().reply_markup }
    );
  } catch (error) {
    if (error.response?.status === 404) {
      await ctx.reply(`❌ Пользователь @${username} не найден в базе данных.`);
    } else {
      console.error('Ошибка при установке бесплатных запросов:', error);
      await ctx.reply('❌ Произошла ошибка при установке бесплатных запросов.');
    }
  }
};

/**
 * Обрабатывает ввод для выдачи подписки
 */
export const processSetSubscription = async (ctx, text, databaseServiceUrl) => {
  const parts = text.trim().split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply('❌ Неверный формат. Используйте: @username количество_дней\nНапример: @username 30');
    return;
  }

  const username = parts[0].replace('@', '');
  const days = parseInt(parts[1], 10);

  if (isNaN(days) || days <= 0) {
    await ctx.reply('❌ Количество дней должно быть положительным числом.');
    return;
  }

  try {
    const response = await axios.put(
      `${databaseServiceUrl}/users/username/${username}/subscription`,
      { days },
      { timeout: 10000 }
    );

    const user = response.data.user;
    if (!user) {
      await ctx.reply(`❌ Пользователь @${username} не найден в базе данных.`);
      return;
    }

    const endDate = new Date(user.subscription_end_date);
    await ctx.reply(
      `✅ Успешно выдана подписка на ${days} дней для пользователя @${username}\n` +
      `📅 Подписка действительна до: ${endDate.toLocaleDateString('ru-RU')}`,
      { reply_markup: getAdminMainKeyboard().reply_markup }
    );
  } catch (error) {
    if (error.response?.status === 404) {
      await ctx.reply(`❌ Пользователь @${username} не найден в базе данных.`);
    } else {
      console.error('Ошибка при выдаче подписки:', error);
      await ctx.reply('❌ Произошла ошибка при выдаче подписки.');
    }
  }
};

export { ADMIN_USERNAMES_STRING };
