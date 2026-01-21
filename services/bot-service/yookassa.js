import axios from 'axios';
import { config } from '../shared/config.js';
import { randomUUID } from 'node:crypto';

const { shopId, secretKey, isTestMode, returnUrl } = config.yookassa;

if (!shopId || !secretKey) {
  console.warn('⚠️ YooKassa credentials not configured. Payment features will be disabled.');
}

// Базовый URL API YooKassa
const YOOKASSA_API_URL = isTestMode
  ? 'https://api.yookassa.ru/v3'
  : 'https://api.yookassa.ru/v3';

// Функция для создания базовой авторизации
const getAuthHeader = () => {
  const credentials = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
  return `Basic ${credentials}`;
};

/**
 * Создание платежа через ЮKassa
 * @param {Object} params - Параметры платежа
 * @param {number} params.amount - Сумма платежа в рублях
 * @param {string} params.description - Описание платежа
 * @param {string} params.paymentId - Уникальный ID платежа в нашей системе
 * @param {Object} params.metadata - Дополнительные данные (chatId, subscriptionType, months)
 * @returns {Promise<Object>} - Данные платежа с confirmation_url
 */
export async function createPayment({ amount, description, paymentId, metadata }) {
  if (!shopId || !secretKey) {
    throw new Error('YooKassa не настроен');
  }

  try {
    const idempotenceKey = randomUUID();
    const response = await axios.post(
      `${YOOKASSA_API_URL}/payments`,
      {
        amount: {
          value: amount.toFixed(2),
          currency: 'RUB'
        },
        confirmation: {
          type: 'redirect',
          return_url: returnUrl
        },
        capture: true,
        description: description,
        metadata: {
          paymentId,
          ...metadata
        }
      },
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const payment = response.data;

    return {
      id: payment.id,
      status: payment.status,
      confirmationUrl: payment.confirmation?.confirmation_url,
      amount: payment.amount.value,
      description: payment.description
    };
  } catch (error) {
    console.error('Ошибка создания платежа в YooKassa:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Получение информации о платеже
 * @param {string} paymentId - ID платежа в ЮKassa
 * @returns {Promise<Object>} - Данные платежа
 */
export async function getPayment(paymentId) {
  if (!shopId || !secretKey) {
    throw new Error('YooKassa не настроен');
  }

  try {
    const response = await axios.get(
      `${YOOKASSA_API_URL}/payments/${paymentId}`,
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const payment = response.data;

    return {
      id: payment.id,
      status: payment.status,
      amount: payment.amount.value,
      description: payment.description,
      metadata: payment.metadata,
      paid: payment.paid,
      captured_at: payment.captured_at
    };
  } catch (error) {
    console.error('Ошибка получения платежа из YooKassa:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Проверка webhook от ЮKassa
 * @param {Object} event - Событие от ЮKassa
 * @returns {Object|null} - Данные платежа или null
 */
export function parseWebhookEvent(event) {
  if (!event || !event.type) {
    return null;
  }

  // Обрабатываем только события о платежах
  if (event.type === 'payment.succeeded' || event.type === 'payment.canceled') {
    const payment = event.object;
    return {
      id: payment.id,
      status: payment.status,
      amount: parseFloat(payment.amount.value),
      description: payment.description,
      metadata: payment.metadata,
      paid: payment.paid,
      captured_at: payment.captured_at
    };
  }

  return null;
}

// Экспорт для проверки тестового режима (переиспользуем уже объявленную переменную)
export { isTestMode };

