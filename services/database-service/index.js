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

