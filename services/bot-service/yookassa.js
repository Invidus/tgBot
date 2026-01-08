import { Client } from '@yookassa/sdk';
import { config } from '../shared/config.js';
import { randomUUID } from 'node:crypto';

const { shopId, secretKey, isTestMode } = config.yookassa;

if (!shopId || !secretKey) {
  console.warn('⚠️ YooKassa credentials not configured. Payment features will be disabled.');
}

// Инициализация SDK ЮKassa
let yookassaClient = null;

if (shopId && secretKey) {
  try {
    yookassaClient = new Client({
      shopId,
      secretKey
    });
  } catch (error) {
    console.error('Ошибка инициализации YooKassa:', error);
  }
}

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
  if (!yookassaClient) {
    throw new Error('YooKassa не настроен');
  }

  try {
    const payment = await yookassaClient.createPayment({
      amount: {
        value: amount.toFixed(2),
        currency: 'RUB'
      },
      confirmation: {
        type: 'redirect',
        return_url: `https://t.me/your_bot` // URL для возврата после оплаты (будет обновлен в обработчике)
      },
      capture: true,
      description: description,
      metadata: {
        paymentId,
        ...metadata
      }
    }, randomUUID());

    return {
      id: payment.id,
      status: payment.status,
      confirmationUrl: payment.confirmation?.confirmation_url,
      amount: payment.amount.value,
      description: payment.description
    };
  } catch (error) {
    console.error('Ошибка создания платежа в YooKassa:', error);
    throw error;
  }
}

/**
 * Получение информации о платеже
 * @param {string} paymentId - ID платежа в ЮKassa
 * @returns {Promise<Object>} - Данные платежа
 */
export async function getPayment(paymentId) {
  if (!yookassaClient) {
    throw new Error('YooKassa не настроен');
  }

  try {
    const payment = await yookassaClient.getPayment(paymentId);
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
    console.error('Ошибка получения платежа из YooKassa:', error);
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

export { isTestMode };

