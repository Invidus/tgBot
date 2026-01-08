import { query } from './dataBase.js';

/**
 * Получает или создает пользователя в базе данных
 */
export const getOrCreateUser = async (chatId, username = null) => {
  try {
    // Проверяем, существует ли пользователь
    const existingUser = await query(
      'SELECT * FROM users WHERE chat_id = $1',
      [chatId]
    );

    if (existingUser.rows.length > 0) {
      // Обновляем username, если он изменился
      if (username && existingUser.rows[0].username !== username) {
        await query(
          'UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2',
          [username, chatId]
        );
        existingUser.rows[0].username = username;
      }
      return existingUser.rows[0];
    }

    // Создаем нового пользователя
    const newUser = await query(
      `INSERT INTO users (chat_id, username, free_requests)
       VALUES ($1, $2, 0)
       RETURNING *`,
      [chatId, username]
    );

    return newUser.rows[0];
  } catch (error) {
    console.error('Ошибка при получении/создании пользователя:', error);
    throw error;
  }
};

/**
 * Получает информацию о пользователе по chat_id
 */
export const getUserByChatId = async (chatId) => {
  try {
    const result = await query(
      'SELECT * FROM users WHERE chat_id = $1',
      [chatId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Ошибка при получении пользователя:', error);
    return null;
  }
};

/**
 * Получает информацию о пользователе по username
 */
export const getUserByUsername = async (username) => {
  try {
    // Убираем @ если есть
    const cleanUsername = username.replace('@', '');
    const result = await query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [cleanUsername]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Ошибка при получении пользователя по username:', error);
    return null;
  }
};

/**
 * Устанавливает количество бесплатных запросов для пользователя
 */
export const setFreeRequests = async (chatId, count) => {
  try {
    const result = await query(
      `UPDATE users
       SET free_requests = $1, updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $2
       RETURNING *`,
      [count, chatId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Ошибка при установке бесплатных запросов:', error);
    throw error;
  }
};

/**
 * Устанавливает количество бесплатных запросов для пользователя по username
 */
export const setFreeRequestsByUsername = async (username, count) => {
  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return null;
    }
    return await setFreeRequests(user.chat_id, count);
  } catch (error) {
    console.error('Ошибка при установке бесплатных запросов по username:', error);
    throw error;
  }
};

/**
 * Увеличивает счетчик бесплатных запросов на 1
 */
export const incrementFreeRequests = async (chatId) => {
  try {
    // Сначала создаем пользователя, если его нет
    await getOrCreateUser(chatId);

    const result = await query(
      `UPDATE users
       SET free_requests = free_requests + 1, updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $1
       RETURNING *`,
      [chatId]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Ошибка при увеличении счетчика запросов:', error);
    throw error;
  }
};

/**
 * Уменьшает счетчик бесплатных запросов на 1
 */
export const decrementFreeRequests = async (chatId) => {
  try {
    const result = await query(
      `UPDATE users
       SET free_requests = GREATEST(0, free_requests - 1), updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $1
       RETURNING *`,
      [chatId]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Ошибка при уменьшении счетчика запросов:', error);
    throw error;
  }
};

/**
 * Устанавливает подписку для пользователя (дни)
 */
export const setSubscription = async (chatId, days) => {
  try {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    const result = await query(
      `UPDATE users
       SET subscription_end_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $2
       RETURNING *`,
      [endDate, chatId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('Ошибка при установке подписки:', error);
    throw error;
  }
};

/**
 * Устанавливает подписку для пользователя по username
 */
export const setSubscriptionByUsername = async (username, days) => {
  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return null;
    }
    return await setSubscription(user.chat_id, days);
  } catch (error) {
    console.error('Ошибка при установке подписки по username:', error);
    throw error;
  }
};

/**
 * Проверяет, есть ли у пользователя активная подписка
 */
export const hasActiveSubscription = async (chatId) => {
  try {
    const user = await getUserByChatId(chatId);
    if (!user || !user.subscription_end_date) {
      return false;
    }
    const endDate = new Date(user.subscription_end_date);
    return endDate > new Date();
  } catch (error) {
    console.error('Ошибка при проверке подписки:', error);
    return false;
  }
};

/**
 * Получает количество дней до окончания подписки
 */
export const getSubscriptionDaysLeft = async (chatId) => {
  try {
    const user = await getUserByChatId(chatId);
    if (!user || !user.subscription_end_date) {
      return 0;
    }
    const endDate = new Date(user.subscription_end_date);
    const now = new Date();
    if (endDate <= now) {
      return 0;
    }
    const diffTime = endDate - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  } catch (error) {
    console.error('Ошибка при получении дней подписки:', error);
    return 0;
  }
};

/**
 * Получает информацию о пользователе для админ-панели
 */
export const getUserInfo = async (username) => {
  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return null;
    }

    const hasSubscription = await hasActiveSubscription(user.chat_id);
    const daysLeft = hasSubscription ? await getSubscriptionDaysLeft(user.chat_id) : 0;

    return {
      chatId: user.chat_id,
      username: user.username,
      freeRequests: user.free_requests || 0,
      hasSubscription,
      subscriptionEndDate: user.subscription_end_date,
      daysLeft,
      createdAt: user.created_at
    };
  } catch (error) {
    console.error('Ошибка при получении информации о пользователе:', error);
    return null;
  }
};
