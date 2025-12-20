// Rate limiter для ограничения запросов от одного пользователя
const userRequests = new Map();
const MAX_REQUESTS_PER_MINUTE = 10; // Максимум 10 запросов в минуту на пользователя
const CLEANUP_INTERVAL = 60 * 1000; // Очистка каждую минуту

/**
 * Проверяет, не превышен ли лимит запросов для пользователя
 */
export const checkRateLimit = (chatId) => {
  const now = Date.now();
  const userData = userRequests.get(chatId) || { requests: [], lastCleanup: now };

  // Удаляем запросы старше минуты
  userData.requests = userData.requests.filter(timestamp => now - timestamp < 60000);

  // Проверяем лимит
  if (userData.requests.length >= MAX_REQUESTS_PER_MINUTE) {
    return false; // Лимит превышен
  }

  // Добавляем текущий запрос
  userData.requests.push(now);
  userRequests.set(chatId, userData);

  return true; // Лимит не превышен
};

/**
 * Очищает старые данные
 */
const cleanup = () => {
  const now = Date.now();
  for (const [chatId, userData] of userRequests.entries()) {
    // Удаляем пользователей без активности более 5 минут
    if (now - userData.lastCleanup > 5 * 60 * 1000) {
      userRequests.delete(chatId);
    } else {
      userData.lastCleanup = now;
    }
  }
};

// Очистка каждую минуту
setInterval(cleanup, CLEANUP_INTERVAL);

