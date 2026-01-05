/**
 * Утилиты для работы с сообщениями Telegram
 */

const MAX_MESSAGE_LENGTH = 4096; // Максимальная длина сообщения в Telegram

/**
 * Проверяет длину сообщения и обрезает его при необходимости
 * @param {string} message - Сообщение для проверки
 * @param {number} maxLength - Максимальная длина (по умолчанию 4096)
 * @returns {string} - Обрезанное сообщение с предупреждением, если было обрезано
 */
export function validateAndTruncateMessage(message, maxLength = MAX_MESSAGE_LENGTH) {
  if (typeof message !== 'string') {
    return 'Ошибка: сообщение должно быть строкой';
  }

  if (message.length <= maxLength) {
    return message;
  }

  // Обрезаем сообщение и добавляем предупреждение
  const truncationWarning = '\n\n⚠️ Сообщение было обрезано из-за ограничений Telegram.';
  const truncatedLength = maxLength - truncationWarning.length;
  return message.substring(0, truncatedLength) + truncationWarning;
}

/**
 * Проверяет, не превышает ли сообщение максимальную длину
 * @param {string} message - Сообщение для проверки
 * @param {number} maxLength - Максимальная длина (по умолчанию 4096)
 * @returns {boolean} - true, если сообщение не превышает лимит
 */
export function isMessageValid(message, maxLength = MAX_MESSAGE_LENGTH) {
  return typeof message === 'string' && message.length <= maxLength;
}

