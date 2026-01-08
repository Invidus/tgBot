import express from 'express';
import axios from 'axios';
import { config } from '../shared/config.js';

// Функция для парсинга webhook события от ЮKassa
function parseWebhookEvent(event) {
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

const app = express();
const PORT = process.env.PORT || 3003;
const databaseServiceUrl = config.services.database;

app.use(express.json());

// Middleware для логирования запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

/**
 * Webhook для обработки уведомлений от ЮKassa
 * POST /webhook/yookassa
 */
app.post('/webhook/yookassa', async (req, res) => {
  try {
    console.log('Получен webhook от YooKassa:', JSON.stringify(req.body, null, 2));

    // Парсим событие от ЮKassa
    const paymentData = parseWebhookEvent(req.body);

    if (!paymentData) {
      console.log('Событие не связано с платежом, игнорируем');
      return res.status(200).json({ received: true });
    }

    const { id: yookassaPaymentId, status, metadata } = paymentData;

    // Находим платеж в нашей БД по ID из ЮKassa
    let payment;
    try {
      const response = await axios.get(`${databaseServiceUrl}/payments/yookassa/${yookassaPaymentId}`, {
        timeout: 10000
      });
      payment = response.data.payment;
    } catch (error) {
      console.error('Платеж не найден в БД:', error.message);
      return res.status(200).json({ received: true, error: 'Payment not found' });
    }

    // Обновляем статус платежа в БД
    await axios.put(`${databaseServiceUrl}/payments/${payment.payment_id}`, {
      status: status === 'succeeded' ? 'succeeded' : status === 'canceled' ? 'canceled' : 'pending',
      yookassaPaymentId
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    // Если платеж успешен, активируем подписку
    if (status === 'succeeded' && payment.status !== 'succeeded') {
      const chatId = parseInt(metadata?.chatId || payment.chat_id);
      const subscriptionType = metadata?.subscriptionType || payment.subscription_type;
      const months = parseInt(metadata?.months || payment.months);

      console.log(`Активация подписки для пользователя ${chatId}: ${subscriptionType}, ${months} месяцев`);

      try {
        // Создаем подписку
        await axios.post(`${databaseServiceUrl}/subscriptions`, {
          chatId,
          subscriptionType,
          months
        }, {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });

        console.log(`✅ Подписка успешно активирована для пользователя ${chatId}`);

        // Отправляем уведомление пользователю через Telegram Bot API
        // Для этого нужно получить bot instance, но так как это отдельный сервис,
        // мы можем использовать Telegram Bot API напрямую
        const telegramToken = config.telegramToken;
        if (telegramToken) {
          try {
            await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
              chat_id: chatId,
              text: `✅ **Подписка активирована!**\n\n` +
                    `📅 Срок действия: ${months} ${months === 1 ? 'месяц' : months < 5 ? 'месяца' : 'месяцев'}\n` +
                    `💰 Сумма: ${payment.amount}₽\n\n` +
                    `🎉 Теперь у вас неограниченный доступ к рецептам!`,
              parse_mode: 'Markdown'
            }, {
              timeout: 10000
            });
          } catch (error) {
            console.error('Ошибка отправки уведомления пользователю:', error.message);
          }
        }
      } catch (error) {
        console.error('Ошибка активации подписки:', error.message);
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Ошибка обработки webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Payment Webhook Service запущен на порту ${PORT}`);
});

