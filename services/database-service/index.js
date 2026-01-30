import express from 'express';
import { Pool } from 'pg';
import { config } from '../shared/config.js';

const app = express();
app.use(express.json());

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  ssl: config.database.ssl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error('❌ Неожиданная ошибка на неактивном клиенте PostgreSQL', err);
});

// Инициализация таблиц
const initTables = async () => {
  try {
    console.log('🔄 Создание таблицы favorites...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        recipe_url TEXT NOT NULL,
        recipe_title TEXT NOT NULL,
        recipe_text TEXT,
        dish_type VARCHAR(20),
        has_photo BOOLEAN DEFAULT FALSE,
        photo_file_id TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, recipe_url)
      )
    `);
    console.log('✅ Таблица favorites создана или уже существует');

    // Создаем индексы для favorites
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_chat_id
      ON favorites(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_added_at
      ON favorites(added_at DESC)
    `);
    console.log('✅ Индексы для favorites созданы');

    // Создаем таблицу подписок
    console.log('🔄 Создание таблицы subscriptions...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL UNIQUE,
        subscription_type VARCHAR(20) NOT NULL,
        start_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        end_date TIMESTAMP NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Таблица subscriptions создана или уже существует');

    // Создаем индексы для subscriptions
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_chat_id
      ON subscriptions(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_end_date
      ON subscriptions(end_date)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_is_active
      ON subscriptions(is_active)
    `);
    console.log('✅ Индексы для subscriptions созданы');

    // Создаем таблицу счетчика запросов (без ежедневного сброса)
    console.log('🔄 Создание таблицы request_counts...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS request_counts (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL UNIQUE,
        request_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Таблица request_counts создана или уже существует');

    // Создаем индексы для request_counts
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_request_counts_chat_id
      ON request_counts(chat_id)
    `);
    console.log('✅ Индексы для request_counts созданы');

    // Создаем таблицу платежей
    console.log('🔄 Создание таблицы payments...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        payment_id VARCHAR(255) NOT NULL UNIQUE,
        subscription_type VARCHAR(20) NOT NULL,
        months INT NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        yookassa_payment_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Таблица payments создана или уже существует');

    // Создаем индексы для payments
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_chat_id
      ON payments(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_payment_id
      ON payments(payment_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_yookassa_payment_id
      ON payments(yookassa_payment_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_status
      ON payments(status)
    `);
    console.log('✅ Индексы для payments созданы');

    // Создаем таблицу пользователей
    console.log('🔄 Создание таблицы users...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL UNIQUE,
        username VARCHAR(255),
        free_requests INTEGER DEFAULT 0,
        ai_requests INTEGER DEFAULT 0,
        subscription_end_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Таблица users создана или уже существует');

    // Добавляем колонку ai_requests если её нет
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='users' AND column_name='ai_requests'
        ) THEN
          ALTER TABLE users ADD COLUMN ai_requests INTEGER DEFAULT 0;
        END IF;
      END $$;
    `).catch(() => {}); // Игнорируем ошибку если колонка уже есть

    // Добавляем колонку referrer_chat_id для реферальной системы
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='users' AND column_name='referrer_chat_id'
        ) THEN
          ALTER TABLE users ADD COLUMN referrer_chat_id BIGINT NULL;
        END IF;
      END $$;
    `).catch(() => {});

    // Создаем таблицу для истории ИИ запросов (для дневных лимитов)
    console.log('🔄 Создание таблицы ai_requests_history...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_requests_history (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        request_date DATE NOT NULL DEFAULT CURRENT_DATE,
        request_count INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, request_date)
      )
    `);
    console.log('✅ Таблица ai_requests_history создана или уже существует');

    // Создаем индексы для ai_requests_history
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_requests_history_chat_id
      ON ai_requests_history(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_requests_history_date
      ON ai_requests_history(request_date)
    `);
    console.log('✅ Индексы для ai_requests_history созданы');

    // Создаем индексы для users
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_chat_id
      ON users(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username
      ON users(username)
    `);
    console.log('✅ Индексы для users созданы');
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц:', error);
    throw error;
  }
};

// Получение количества избранного
app.get('/favorites/count/:chatId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM favorites WHERE chat_id = $1',
      [req.params.chatId]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Ошибка получения количества избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Проверка, находится ли рецепт в избранном
app.get('/favorites/check/:chatId', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.json({ isInFavorites: false });
    }

    const result = await pool.query(
      'SELECT id FROM favorites WHERE chat_id = $1 AND recipe_url = $2',
      [req.params.chatId, url]
    );

    res.json({ isInFavorites: result.rows.length > 0 });
  } catch (error) {
    console.error('Ошибка проверки избранного:', error);
    res.json({ isInFavorites: false });
  }
});

// Добавление в избранное
app.post('/favorites/add', async (req, res) => {
  const { chatId, url, title, text, dishType, hasPhoto, photoFileId } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO favorites (chat_id, recipe_url, recipe_title, recipe_text, dish_type, has_photo, photo_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chat_id, recipe_url) DO NOTHING
       RETURNING id`,
      [chatId, url, title, text, dishType, hasPhoto || false, photoFileId]
    );

    res.json({ added: result.rows.length > 0 });
  } catch (error) {
    console.error('Ошибка добавления в избранное:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ВАЖНО: Более специфичные маршруты должны быть ПЕРЕД общими!
// Получение рецепта из избранного по ID и chatId
app.get('/favorites/:chatId/:id', async (req, res) => {
  const { chatId, id } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM favorites WHERE id = $1 AND chat_id = $2',
      [id, chatId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Рецепт не найден' });
    }

    res.json({ favorite: result.rows[0] });
  } catch (error) {
    console.error('Ошибка получения рецепта:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Удаление из избранного по ID (специфичный маршрут)
app.delete('/favorites/:chatId/:id', async (req, res) => {
  const { chatId, id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM favorites WHERE id = $1 AND chat_id = $2',
      [id, chatId]
    );

    res.json({ removed: result.rowCount > 0 });
  } catch (error) {
    console.error('Ошибка удаления из избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение списка избранного (общий маршрут - после специфичных)
app.get('/favorites/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { page = 0, pageSize = 50 } = req.query;

  try {
    const result = await pool.query(
      `SELECT * FROM favorites
       WHERE chat_id = $1
       ORDER BY added_at DESC
       LIMIT $2 OFFSET $3`,
      [chatId, parseInt(pageSize), parseInt(page) * parseInt(pageSize)]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Удаление из избранного (общий маршрут - после специфичных)
app.delete('/favorites/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const { url, id } = req.query;

  try {
    let result;
    if (id) {
      result = await pool.query(
        'DELETE FROM favorites WHERE id = $1 AND chat_id = $2',
        [id, chatId]
      );
    } else if (url) {
      result = await pool.query(
        'DELETE FROM favorites WHERE chat_id = $1 AND recipe_url = $2',
        [chatId, url]
      );
    } else {
      return res.status(400).json({ error: 'Не указан url или id' });
    }

    res.json({ removed: result.rowCount > 0 });
  } catch (error) {
    console.error('Ошибка удаления из избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение рецепта по ID
app.get('/favorites/item/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM favorites WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Рецепт не найден' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка получения рецепта:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ==================== ПОДПИСКИ ====================

// Получение информации о подписке пользователя
app.get('/subscriptions/:chatId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM subscriptions
       WHERE chat_id = $1 AND is_active = TRUE
       ORDER BY end_date DESC
       LIMIT 1`,
      [req.params.chatId]
    );

    if (result.rows.length === 0) {
      return res.json({ subscription: null });
    }

    const subscription = result.rows[0];
    const now = new Date();
    const endDate = new Date(subscription.end_date);

    // Проверяем, не истекла ли подписка
    if (endDate < now) {
      // Обновляем статус подписки
      await pool.query(
        'UPDATE subscriptions SET is_active = FALSE WHERE id = $1',
        [subscription.id]
      );
      return res.json({ subscription: null });
    }

    res.json({ subscription });
  } catch (error) {
    console.error('Ошибка получения подписки:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Создание или обновление подписки
app.post('/subscriptions', async (req, res) => {
  const { chatId, subscriptionType, months } = req.body;

  if (!chatId || !subscriptionType || !months) {
    return res.status(400).json({ error: 'Не указаны обязательные параметры' });
  }

  try {
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + months);

    const result = await pool.query(
      `INSERT INTO subscriptions (chat_id, subscription_type, start_date, end_date, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (chat_id)
       DO UPDATE SET
         subscription_type = EXCLUDED.subscription_type,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         is_active = TRUE,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [chatId, subscriptionType, startDate, endDate]
    );

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('Ошибка создания подписки:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение подписок, которые скоро истекают (для уведомлений)
app.get('/subscriptions/expiring-soon', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 3; // По умолчанию 3 дня
    const date = new Date();
    date.setDate(date.getDate() + days);

    const result = await pool.query(
      `SELECT * FROM subscriptions
       WHERE is_active = TRUE
       AND end_date <= $1
       AND end_date > CURRENT_TIMESTAMP
       ORDER BY end_date ASC`,
      [date]
    );

    res.json({ subscriptions: result.rows });
  } catch (error) {
    console.error('Ошибка получения истекающих подписок:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ==================== СЧЕТЧИК ЗАПРОСОВ ====================

// Получение счетчика запросов пользователя (без ежедневного сброса)
app.get('/request-counts/:chatId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM request_counts WHERE chat_id = $1',
      [req.params.chatId]
    );

    if (result.rows.length === 0) {
      // Создаем новую запись
      const newResult = await pool.query(
        `INSERT INTO request_counts (chat_id, request_count)
         VALUES ($1, 0)
         RETURNING *`,
        [req.params.chatId]
      );
      return res.json({ requestCount: newResult.rows[0] });
    }

    res.json({ requestCount: result.rows[0] });
  } catch (error) {
    console.error('Ошибка получения счетчика запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Увеличение счетчика запросов (без ежедневного сброса)
app.post('/request-counts/:chatId/increment', async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO request_counts (chat_id, request_count)
       VALUES ($1, 1)
       ON CONFLICT (chat_id)
       DO UPDATE SET
         request_count = request_counts.request_count + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [req.params.chatId]
    );

    res.json({ requestCount: result.rows[0] });
  } catch (error) {
    console.error('Ошибка увеличения счетчика запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ==================== ПЛАТЕЖИ ====================

// Создание записи о платеже
app.post('/payments', async (req, res) => {
  const { chatId, paymentId, subscriptionType, months, amount, yookassaPaymentId } = req.body;

  if (!chatId || !paymentId || !subscriptionType || !months || !amount) {
    return res.status(400).json({ error: 'Не указаны обязательные параметры' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO payments (chat_id, payment_id, subscription_type, months, amount, yookassa_payment_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [chatId, paymentId, subscriptionType, months, amount, yookassaPaymentId || null]
    );

    res.json({ payment: result.rows[0] });
  } catch (error) {
    console.error('Ошибка создания платежа:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Обновление статуса платежа
app.put('/payments/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const { status, yookassaPaymentId } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Не указан статус' });
  }

  try {
    const updateFields = ['status = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [status];
    let paramIndex = 2;

    if (yookassaPaymentId) {
      updateFields.push(`yookassa_payment_id = $${paramIndex}`);
      values.push(yookassaPaymentId);
      paramIndex++;
    }

    const result = await pool.query(
      `UPDATE payments
       SET ${updateFields.join(', ')}
       WHERE payment_id = $${paramIndex}
       RETURNING *`,
      [...values, paymentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Платеж не найден' });
    }

    res.json({ payment: result.rows[0] });
  } catch (error) {
    console.error('Ошибка обновления платежа:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение платежа по ID
app.get('/payments/:paymentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE payment_id = $1',
      [req.params.paymentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Платеж не найден' });
    }

    res.json({ payment: result.rows[0] });
  } catch (error) {
    console.error('Ошибка получения платежа:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение платежа по YooKassa payment ID
app.get('/payments/yookassa/:yookassaPaymentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE yookassa_payment_id = $1',
      [req.params.yookassaPaymentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Платеж не найден' });
    }

    res.json({ payment: result.rows[0] });
  } catch (error) {
    console.error('Ошибка получения платежа:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение платежей пользователя (с фильтрацией по статусу)
app.get('/payments', async (req, res) => {
  try {
    const { chatId, status } = req.query;

    if (!chatId) {
      return res.status(400).json({ error: 'Не указан chatId' });
    }

    let query = 'SELECT * FROM payments WHERE chat_id = $1';
    const values = [chatId];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      values.push(status);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, values);
    res.json({ payments: result.rows });
  } catch (error) {
    console.error('Ошибка получения платежей:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ==================== ПОЛЬЗОВАТЕЛИ (для админ-панели) ====================

// Получение или создание пользователя
app.post('/users', async (req, res) => {
  const { chatId, username, referrer_chat_id: referrerChatId } = req.body;

  if (!chatId) {
    return res.status(400).json({ error: 'Не указан chatId' });
  }

  try {
    // Проверяем, существует ли пользователь
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE chat_id = $1',
      [chatId]
    );

    if (existingUser.rows.length > 0) {
      // Обновляем username, если он изменился (referrer не меняем)
      if (username && existingUser.rows[0].username !== username) {
        const updated = await pool.query(
          'UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2 RETURNING *',
          [username, chatId]
        );
        return res.json({ user: updated.rows[0] });
      }
      return res.json({ user: existingUser.rows[0] });
    }

    // Создаем нового пользователя (referrer только при первом создании)
    const result = await pool.query(
      `INSERT INTO users (chat_id, username, free_requests, referrer_chat_id)
       VALUES ($1, $2, 0, $3)
       RETURNING *`,
      [chatId, username || null, referrerChatId || null]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Ошибка получения/создания пользователя:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение пользователя по chat_id
app.get('/users/chat/:chatId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE chat_id = $1',
      [req.params.chatId]
    );
    res.json({ user: result.rows[0] || null });
  } catch (error) {
    console.error('Ошибка получения пользователя:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Реферальная статистика и скидки для оплаты
// Скидка приглашающего: 1 пригл. = 5%, 2 = 10%, 3 = 20%, 4 = 30%, 5+ = 50%
// Приглашённый: 10% на первую покупку (месяц/полгода/год)
app.get('/users/chat/:chatId/referral-stats', async (req, res) => {
  const chatId = req.params.chatId;
  try {
    const userResult = await pool.query(
      'SELECT referrer_chat_id FROM users WHERE chat_id = $1',
      [chatId]
    );
    const user = userResult.rows[0] || null;

    const referredCountResult = await pool.query(
      'SELECT COUNT(*) AS count FROM users WHERE referrer_chat_id = $1',
      [chatId]
    );
    const referredCount = parseInt(referredCountResult.rows[0].count, 10) || 0;

    let referrerDiscountPercent = 0;
    if (referredCount >= 5) referrerDiscountPercent = 50;
    else if (referredCount >= 4) referrerDiscountPercent = 30;
    else if (referredCount >= 3) referrerDiscountPercent = 20;
    else if (referredCount >= 2) referrerDiscountPercent = 10;
    else if (referredCount >= 1) referrerDiscountPercent = 5;

    const paidCountResult = await pool.query(
      "SELECT COUNT(*) AS count FROM payments WHERE chat_id = $1 AND status = 'succeeded'",
      [chatId]
    );
    const hasEverPaid = parseInt(paidCountResult.rows[0].count, 10) > 0;
    const isReferredFirstPurchase = user && user.referrer_chat_id != null && !hasEverPaid;
    const referredDiscountPercent = isReferredFirstPurchase ? 10 : 0;

    const finalDiscountPercent = Math.max(referrerDiscountPercent, referredDiscountPercent);

    res.json({
      referredCount,
      referrerDiscountPercent,
      isReferredFirstPurchase,
      referredDiscountPercent,
      finalDiscountPercent
    });
  } catch (error) {
    console.error('Ошибка получения реферальной статистики:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение пользователя по username
app.get('/users/username/:username', async (req, res) => {
  try {
    const cleanUsername = req.params.username.replace('@', '');
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [cleanUsername]
    );
    res.json({ user: result.rows[0] || null });
  } catch (error) {
    console.error('Ошибка получения пользователя по username:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Установка количества бесплатных запросов
app.put('/users/:chatId/free-requests', async (req, res) => {
  const { chatId } = req.params;
  const { count } = req.body;

  if (typeof count !== 'number' || count < 0) {
    return res.status(400).json({ error: 'Неверное количество запросов' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET free_requests = $1, updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $2
       RETURNING *`,
      [count, chatId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Ошибка установки бесплатных запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Установка бесплатных запросов по username
app.put('/users/username/:username/free-requests', async (req, res) => {
  const { username } = req.params;
  const { count } = req.body;

  if (typeof count !== 'number' || count < 0) {
    return res.status(400).json({ error: 'Неверное количество запросов' });
  }

  try {
    const cleanUsername = username.replace('@', '');
    const result = await pool.query(
      `UPDATE users
       SET free_requests = $1, updated_at = CURRENT_TIMESTAMP
       WHERE LOWER(username) = LOWER($2)
       RETURNING *`,
      [count, cleanUsername]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Ошибка установки бесплатных запросов по username:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Уменьшение счетчика бесплатных запросов
app.post('/users/:chatId/free-requests/decrement', async (req, res) => {
  const { chatId } = req.params;

  try {
    const result = await pool.query(
      `UPDATE users
       SET free_requests = GREATEST(0, free_requests - 1), updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $1
       RETURNING *`,
      [chatId]
    );

    if (result.rows.length === 0) {
      // Создаем пользователя если его нет
      const newUser = await pool.query(
        `INSERT INTO users (chat_id, free_requests)
         VALUES ($1, 0)
         RETURNING *`,
        [chatId]
      );
      return res.json({ user: newUser.rows[0] });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Ошибка уменьшения счетчика запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Установка подписки для пользователя (дни)
app.put('/users/:chatId/subscription', async (req, res) => {
  const { chatId } = req.params;
  const { days } = req.body;

  if (typeof days !== 'number' || days <= 0) {
    return res.status(400).json({ error: 'Неверное количество дней' });
  }

  try {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    const result = await pool.query(
      `UPDATE users
       SET subscription_end_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = $2
       RETURNING *`,
      [endDate, chatId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Ошибка установки подписки:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Установка подписки для пользователя по username
app.put('/users/username/:username/subscription', async (req, res) => {
  const { username } = req.params;
  const { days } = req.body;

  if (typeof days !== 'number' || days <= 0) {
    return res.status(400).json({ error: 'Неверное количество дней' });
  }

  try {
    const cleanUsername = username.replace('@', '');
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    const result = await pool.query(
      `UPDATE users
       SET subscription_end_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE LOWER(username) = LOWER($2)
       RETURNING *`,
      [endDate, cleanUsername]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Ошибка установки подписки по username:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение информации о пользователе для админ-панели
app.get('/users/username/:username/info', async (req, res) => {
  try {
    const cleanUsername = req.params.username.replace('@', '');
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [cleanUsername]
    );

    if (result.rows.length === 0) {
      return res.json({ userInfo: null });
    }

    const user = result.rows[0];
    const now = new Date();
    const hasSubscription = user.subscription_end_date && new Date(user.subscription_end_date) > now;
    const daysLeft = hasSubscription
      ? Math.ceil((new Date(user.subscription_end_date) - now) / (1000 * 60 * 60 * 24))
      : 0;

    // Получаем информацию о ИИ запросах
    const today = new Date().toISOString().split('T')[0];
    const aiRequestsResult = await pool.query(
      'SELECT request_count FROM ai_requests_history WHERE chat_id = $1 AND request_date = $2',
      [user.chat_id, today]
    );
    const todayAiRequests = aiRequestsResult.rows[0]?.request_count || 0;
    const aiRequestsRemaining = Math.max(0, 5 - todayAiRequests); // Лимит 5 запросов в день

    res.json({
      userInfo: {
        chatId: user.chat_id,
        username: user.username,
        freeRequests: user.free_requests || 0,
        aiRequests: user.ai_requests || 0,
        aiRequestsRemaining,
        aiRequestsToday: todayAiRequests,
        hasSubscription,
        subscriptionEndDate: user.subscription_end_date,
        daysLeft,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('Ошибка получения информации о пользователе:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Проверка доступных ИИ запросов (с учетом дневного лимита)
app.get('/users/:chatId/ai-requests/check', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const today = new Date().toISOString().split('T')[0];

    // Проверяем подписку и общий счетчик ИИ запросов из таблицы users
    const userResult = await pool.query(
      'SELECT subscription_end_date, ai_requests FROM users WHERE chat_id = $1',
      [chatId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const user = userResult.rows[0];
    const aiRequestsTotal = user.ai_requests || 0;
    let hasSubscription = user.subscription_end_date && new Date(user.subscription_end_date) > new Date();

    // Если нет подписки в users, проверяем таблицу subscriptions
    if (!hasSubscription) {
      const subscriptionResult = await pool.query(
        `SELECT * FROM subscriptions
         WHERE chat_id = $1 AND is_active = TRUE
         ORDER BY end_date DESC
         LIMIT 1`,
        [chatId]
      );

      if (subscriptionResult.rows.length > 0) {
        const subscription = subscriptionResult.rows[0];
        const now = new Date();
        const endDate = new Date(subscription.end_date);
        hasSubscription = endDate > now && subscription.is_active;
      }
    }

    if (!hasSubscription) {
      return res.json({
        allowed: false,
        reason: 'no_subscription',
        message: 'ИИ распознавание доступно только для подписчиков'
      });
    }

    // Если есть общие ИИ запросы (добавленные через админ-панель), разрешаем использование
    if (aiRequestsTotal > 0) {
      const historyResult = await pool.query(
        'SELECT request_count FROM ai_requests_history WHERE chat_id = $1 AND request_date = $2',
        [chatId, today]
      );
      const todayRequests = historyResult.rows[0]?.request_count || 0;
      
      return res.json({
        allowed: true,
        remaining: aiRequestsTotal, // Используем общий счетчик
        usedToday: todayRequests,
        maxDaily: 5,
        aiRequestsTotal: aiRequestsTotal,
        usingTotal: true // Флаг, что используем общий счетчик
      });
    }

    // Если общих запросов нет, проверяем дневной лимит
    const historyResult = await pool.query(
      'SELECT request_count FROM ai_requests_history WHERE chat_id = $1 AND request_date = $2',
      [chatId, today]
    );

    const todayRequests = historyResult.rows[0]?.request_count || 0;
    const maxDailyRequests = 5;

    if (todayRequests >= maxDailyRequests) {
      return res.json({
        allowed: false,
        reason: 'daily_limit',
        message: `Дневной лимит ИИ запросов исчерпан (${maxDailyRequests}/день)`,
        remaining: 0,
        usedToday: todayRequests
      });
    }

    res.json({
      allowed: true,
      remaining: maxDailyRequests - todayRequests,
      usedToday: todayRequests,
      maxDaily: maxDailyRequests,
      aiRequestsTotal: 0,
      usingTotal: false
    });
  } catch (error) {
    console.error('Ошибка проверки ИИ запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Уменьшение ИИ запросов (после использования)
app.post('/users/:chatId/ai-requests/decrement', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const today = new Date().toISOString().split('T')[0];

    // Получаем текущее количество общих ИИ запросов
    const userResult = await pool.query(
      'SELECT ai_requests FROM users WHERE chat_id = $1',
      [chatId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const aiRequestsTotal = userResult.rows[0].ai_requests || 0;
    let shouldDecrementTotal = false;

    // Если есть общие запросы, уменьшаем их, иначе только дневной лимит
    if (aiRequestsTotal > 0) {
      shouldDecrementTotal = true;
      // Уменьшаем общий счетчик ИИ запросов
      await pool.query(`
        UPDATE users
        SET ai_requests = GREATEST(0, ai_requests - 1), updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = $1
      `, [chatId]);
    } else {
      // Если общих запросов нет, увеличиваем счетчик в истории (дневной лимит)
      await pool.query(`
        INSERT INTO ai_requests_history (chat_id, request_date, request_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (chat_id, request_date)
        DO UPDATE SET request_count = ai_requests_history.request_count + 1
      `, [chatId, today]);
    }

    // Получаем обновленную информацию
    const updatedUserResult = await pool.query(
      'SELECT ai_requests FROM users WHERE chat_id = $1',
      [chatId]
    );
    const updatedAiRequestsTotal = updatedUserResult.rows[0]?.ai_requests || 0;

    const historyResult = await pool.query(
      'SELECT request_count FROM ai_requests_history WHERE chat_id = $1 AND request_date = $2',
      [chatId, today]
    );
    const todayRequests = historyResult.rows[0]?.request_count || 0;

    // Определяем оставшиеся запросы
    let remaining;
    if (updatedAiRequestsTotal > 0) {
      remaining = updatedAiRequestsTotal; // Используем общий счетчик
    } else {
      remaining = Math.max(0, 5 - todayRequests); // Используем дневной лимит
    }

    res.json({
      success: true,
      remaining: remaining,
      usedToday: todayRequests,
      aiRequestsTotal: updatedAiRequestsTotal,
      usingTotal: updatedAiRequestsTotal > 0
    });
  } catch (error) {
    console.error('Ошибка уменьшения ИИ запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Увеличение ИИ запросов (для админа)
app.put('/users/:chatId/ai-requests', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'Неверное количество запросов' });
    }

    const result = await pool.query(`
      UPDATE users
      SET ai_requests = ai_requests + $1, updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = $2
      RETURNING ai_requests
    `, [amount, chatId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({
      success: true,
      aiRequests: result.rows[0].ai_requests
    });
  } catch (error) {
    console.error('Ошибка увеличения ИИ запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Увеличение ИИ запросов по username (для админа)
app.put('/users/username/:username/ai-requests', async (req, res) => {
  try {
    const username = req.params.username.replace('@', '');
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'Неверное количество запросов' });
    }

    const result = await pool.query(`
      UPDATE users
      SET ai_requests = ai_requests + $1, updated_at = CURRENT_TIMESTAMP
      WHERE LOWER(username) = LOWER($2)
      RETURNING ai_requests, chat_id
    `, [amount, username]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({
      success: true,
      aiRequests: result.rows[0].ai_requests,
      chatId: result.rows[0].chat_id
    });
  } catch (error) {
    console.error('Ошибка увеличения ИИ запросов по username:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение информации об ИИ запросах пользователя
app.get('/users/:chatId/ai-requests/info', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const today = new Date().toISOString().split('T')[0];

    const userResult = await pool.query(
      'SELECT ai_requests, subscription_end_date FROM users WHERE chat_id = $1',
      [chatId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const user = userResult.rows[0];
    let hasSubscription = user.subscription_end_date && new Date(user.subscription_end_date) > new Date();

    // Если нет подписки в users, проверяем таблицу subscriptions
    if (!hasSubscription) {
      const subscriptionResult = await pool.query(
        `SELECT * FROM subscriptions
         WHERE chat_id = $1 AND is_active = TRUE
         ORDER BY end_date DESC
         LIMIT 1`,
        [chatId]
      );

      if (subscriptionResult.rows.length > 0) {
        const subscription = subscriptionResult.rows[0];
        const now = new Date();
        const endDate = new Date(subscription.end_date);
        hasSubscription = endDate > now && subscription.is_active;
      }
    }

    const historyResult = await pool.query(
      'SELECT request_count FROM ai_requests_history WHERE chat_id = $1 AND request_date = $2',
      [chatId, today]
    );

    const todayRequests = historyResult.rows[0]?.request_count || 0;
    const maxDailyRequests = 5;
    const aiRequestsTotal = user.ai_requests || 0;
    
    // Если есть общие запросы, используем их, иначе дневной лимит
    let remaining;
    if (aiRequestsTotal > 0) {
      remaining = aiRequestsTotal; // Используем общий счетчик
    } else {
      remaining = Math.max(0, maxDailyRequests - todayRequests); // Используем дневной лимит
    }

    res.json({
      hasSubscription,
      aiRequestsTotal: aiRequestsTotal,
      aiRequestsToday: todayRequests,
      aiRequestsRemaining: remaining,
      maxDailyRequests,
      usingTotal: aiRequestsTotal > 0 // Флаг, что используем общий счетчик
    });
  } catch (error) {
    console.error('Ошибка получения информации об ИИ запросах:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Сброс ИИ запросов для конкретного пользователя (при оформлении подписки)
app.post('/users/:chatId/ai-requests/reset', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const today = new Date().toISOString().split('T')[0];

    // Удаляем запись за сегодня из истории (если есть)
    await pool.query(
      'DELETE FROM ai_requests_history WHERE chat_id = $1 AND request_date = $2',
      [chatId, today]
    );

    res.json({
      success: true,
      message: 'ИИ запросы сброшены'
    });
  } catch (error) {
    console.error('Ошибка сброса ИИ запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Ежедневный сброс ИИ запросов для всех пользователей с активной подпиской
app.post('/ai-requests/reset-daily', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Получаем всех пользователей с активной подпиской
    const usersResult = await pool.query(
      `SELECT DISTINCT chat_id FROM users
       WHERE subscription_end_date IS NOT NULL
       AND subscription_end_date > CURRENT_TIMESTAMP`
    );

    let resetCount = 0;

    // Удаляем записи за вчерашний день для всех пользователей с активной подпиской
    // (это не обязательно, так как счетчик работает по дате, но можно очистить старые записи)
    for (const user of usersResult.rows) {
      // Удаляем старые записи (старше 7 дней) для экономии места
      await pool.query(
        'DELETE FROM ai_requests_history WHERE chat_id = $1 AND request_date < CURRENT_DATE - INTERVAL \'7 days\'',
        [user.chat_id]
      );
      resetCount++;
    }

    // Также удаляем старые записи для всех пользователей (старше 30 дней)
    await pool.query(
      'DELETE FROM ai_requests_history WHERE request_date < CURRENT_DATE - INTERVAL \'30 days\''
    );

    res.json({
      success: true,
      resetCount: resetCount,
      message: `Ежедневный сброс выполнен для ${resetCount} пользователей`
    });
  } catch (error) {
    console.error('Ошибка ежедневного сброса ИИ запросов:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

const PORT = process.env.PORT || 3002;

// Инициализация и запуск
initTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Database Service запущен на порту ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ Ошибка инициализации Database Service:', error);
    // Запускаем сервис в любом случае, но таблица может не работать
    app.listen(PORT, () => {
      console.log(`⚠️ Database Service запущен на порту ${PORT} (таблицы не инициализированы)`);
    });
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Закрытие Database Service...');
  await pool.end();
  process.exit(0);
});

