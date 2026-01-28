import express from 'express';
import { Pool } from 'pg';
import { config } from '../shared/config.js';
import cron from 'node-cron';
import axios from 'axios';

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

// ==================== ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ====================

const initTables = async () => {
  try {
    // Таблица профилей пользователей
    console.log('🔄 Создание таблицы user_profiles...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL UNIQUE NOT NULL,
        gender VARCHAR(10) CHECK (gender IN ('male', 'female')),
        age INTEGER CHECK (age > 0 AND age < 150),
        height INTEGER CHECK (height > 0 AND height < 300),
        weight DECIMAL(5, 2) CHECK (weight > 0 AND weight < 500),
        activity_level VARCHAR(20) CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id)
      )
    `);
    console.log('✅ Таблица user_profiles создана или уже существует');

    // Таблица дневника питания (блюда за день)
    console.log('🔄 Создание таблицы diary_entries...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diary_entries (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        dish_name TEXT NOT NULL,
        calories DECIMAL(8, 2) DEFAULT 0,
        protein DECIMAL(8, 2) DEFAULT 0,
        carbs DECIMAL(8, 2) DEFAULT 0,
        fats DECIMAL(8, 2) DEFAULT 0,
        quantity DECIMAL(8, 2) DEFAULT 1,
        unit VARCHAR(20) DEFAULT 'portion',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, entry_date, dish_name, created_at)
      )
    `);
    console.log('✅ Таблица diary_entries создана или уже существует');

    // Таблица воды
    console.log('🔄 Создание таблицы water_intake...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS water_intake (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        intake_date DATE NOT NULL DEFAULT CURRENT_DATE,
        amount_ml INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, intake_date)
      )
    `);
    console.log('✅ Таблица water_intake создана или уже существует');

    // Таблица избранного (перенесено из database-service)
    console.log('🔄 Создание таблицы diary_favorites...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS diary_favorites (
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
    `).catch(() => {}); // Игнорируем если таблица уже существует
    console.log('✅ Таблица diary_favorites создана или уже существует');

    // Создаем индексы
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_profiles_chat_id
      ON user_profiles(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_diary_entries_chat_id_date
      ON diary_entries(chat_id, entry_date DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_water_intake_chat_id_date
      ON water_intake(chat_id, intake_date DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_diary_favorites_chat_id
      ON diary_favorites(chat_id)
    `);
    console.log('✅ Индексы созданы');
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц:', error);
    throw error;
  }
};

// ==================== РАСЧЕТ КАЛОРИЙ ====================

/**
 * Расчет базового метаболизма (BMR) по формуле Миффлина-Сан Жеора
 */
function calculateBMR(gender, age, height, weight) {
  // BMR = 10 × вес(кг) + 6.25 × рост(см) - 5 × возраст(лет) + s
  // s = +5 для мужчин, -161 для женщин
  const s = gender === 'male' ? 5 : -161;
  const bmr = 10 * weight + 6.25 * height - 5 * age + s;
  return Math.round(bmr);
}

/**
 * Коэффициенты активности:
 * - sedentary: 1.2 (малоподвижный образ жизни)
 * - light: 1.375 (легкая активность, тренировки 1-3 раза в неделю)
 * - moderate: 1.55 (умеренная активность, тренировки 3-5 раз в неделю)
 * - active: 1.725 (высокая активность, тренировки 6-7 раз в неделю)
 * - very_active: 1.9 (очень высокая активность, физическая работа)
 */
function getActivityMultiplier(activityLevel) {
  const multipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9
  };
  return multipliers[activityLevel] || 1.2;
}

/**
 * Расчет суточной нормы калорий (TDEE - Total Daily Energy Expenditure)
 */
function calculateTDEE(gender, age, height, weight, activityLevel) {
  const bmr = calculateBMR(gender, age, height, weight);
  const multiplier = getActivityMultiplier(activityLevel);
  return Math.round(bmr * multiplier);
}

/**
 * Расчет калорий для разных целей:
 * - weight_loss: TDEE - 500 ккал (дефицит для похудения)
 * - weight_maintenance: TDEE (поддержание веса)
 * - muscle_gain: TDEE + 300 ккал (профицит для набора массы)
 */
function calculateCalorieGoals(tdee) {
  return {
    weight_loss: Math.max(1200, tdee - 500), // Минимум 1200 ккал
    weight_maintenance: tdee,
    muscle_gain: tdee + 300
  };
}

// ==================== ПРОВЕРКА ПОДПИСКИ ====================

async function checkSubscription(chatId) {
  try {
    // Проверяем подписку через database-service
    const response = await axios.get(`${config.services.database}/subscriptions/${chatId}`, {
      timeout: 5000,
      validateStatus: (status) => status < 500 // Разрешаем 404
    });

    if (response.status === 200 && response.data && response.data.subscription) {
      const endDate = new Date(response.data.subscription.end_date);
      const isActive = endDate > new Date() && response.data.subscription.is_active;
      if (isActive) {
        return true;
      }
    }

    // Если нет подписки в subscriptions, проверяем users
    const userResponse = await axios.get(`${config.services.database}/users/chat/${chatId}`, {
      timeout: 5000,
      validateStatus: (status) => status < 500
    });

    if (userResponse.status === 200 && userResponse.data && userResponse.data.user) {
      const user = userResponse.data.user;
      if (user && user.subscription_end_date) {
        const endDate = new Date(user.subscription_end_date);
        if (endDate > new Date()) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    // Если database-service недоступен, логируем, но не блокируем доступ
    // (можно изменить логику в зависимости от требований)
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      console.error(`⚠️ Database-service недоступен для проверки подписки chatId=${chatId}:`, error.message);
    } else {
      console.error(`Ошибка проверки подписки для chatId=${chatId}:`, error.message);
    }
    return false;
  }
}

// ==================== API ENDPOINTS ====================

// Проверка подписки перед доступом к дневнику
const requireSubscription = async (req, res, next) => {
  const chatId = req.params.chatId || req.body.chatId;
  if (!chatId) {
    return res.status(400).json({ error: 'chatId обязателен' });
  }

  const hasSubscription = await checkSubscription(chatId);
  if (!hasSubscription) {
    return res.status(403).json({
      error: 'Дневник питания доступен только для подписчиков',
      requiresSubscription: true
    });
  }

  next();
};

// Получение или создание профиля пользователя
app.get('/profiles/:chatId', requireSubscription, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_profiles WHERE chat_id = $1',
      [req.params.chatId]
    );

    if (result.rows.length === 0) {
      return res.json({ profile: null });
    }

    const profile = result.rows[0];

    // Рассчитываем калории если есть все данные
    let calorieGoals = null;
    if (profile.gender && profile.age && profile.height && profile.weight && profile.activity_level) {
      const tdee = calculateTDEE(
        profile.gender,
        profile.age,
        profile.height,
        profile.weight,
        profile.activity_level
      );
      calorieGoals = calculateCalorieGoals(tdee);
    }

    res.json({
      profile: {
        ...profile,
        calorieGoals
      }
    });
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Создание или обновление профиля пользователя
app.post('/profiles/:chatId', requireSubscription, async (req, res) => {
  const { gender, age, height, weight, activityLevel } = req.body;

  if (!gender || !age || !height || !weight || !activityLevel) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO user_profiles (chat_id, gender, age, height, weight, activity_level, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (chat_id)
       DO UPDATE SET
         gender = EXCLUDED.gender,
         age = EXCLUDED.age,
         height = EXCLUDED.height,
         weight = EXCLUDED.weight,
         activity_level = EXCLUDED.activity_level,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [req.params.chatId, gender, age, height, weight, activityLevel]
    );

    const profile = result.rows[0];
    const tdee = calculateTDEE(gender, age, height, weight, activityLevel);
    const calorieGoals = calculateCalorieGoals(tdee);

    res.json({
      profile: {
        ...profile,
        calorieGoals
      }
    });
  } catch (error) {
    console.error('Ошибка создания/обновления профиля:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Добавление блюда в дневник
app.post('/diary/:chatId/entries', requireSubscription, async (req, res) => {
  const { dishName, calories, protein, carbs, fats, quantity, unit, entryDate } = req.body;
  const chatId = req.params.chatId;

  if (!dishName || calories === undefined) {
    return res.status(400).json({ error: 'dishName и calories обязательны' });
  }

  try {
    const date = entryDate || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `INSERT INTO diary_entries (chat_id, entry_date, dish_name, calories, protein, carbs, fats, quantity, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [chatId, date, dishName, calories || 0, protein || 0, carbs || 0, fats || 0, quantity || 1, unit || 'portion']
    );

    res.json({ entry: result.rows[0] });
  } catch (error) {
    console.error('Ошибка добавления записи в дневник:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение записей дневника за день
app.get('/diary/:chatId/entries', requireSubscription, async (req, res) => {
  const { date } = req.query;
  const chatId = req.params.chatId;
  const entryDate = date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(
      `SELECT * FROM diary_entries
       WHERE chat_id = $1 AND entry_date = $2
       ORDER BY created_at ASC`,
      [chatId, entryDate]
    );

    // Подсчитываем итоги за день
    const totals = result.rows.reduce((acc, entry) => {
      acc.calories += parseFloat(entry.calories) || 0;
      acc.protein += parseFloat(entry.protein) || 0;
      acc.carbs += parseFloat(entry.carbs) || 0;
      acc.fats += parseFloat(entry.fats) || 0;
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fats: 0 });

    res.json({
      entries: result.rows,
      totals: {
        calories: Math.round(totals.calories * 100) / 100,
        protein: Math.round(totals.protein * 100) / 100,
        carbs: Math.round(totals.carbs * 100) / 100,
        fats: Math.round(totals.fats * 100) / 100
      },
      date: entryDate
    });
  } catch (error) {
    console.error('Ошибка получения записей дневника:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Удаление записи из дневника
app.delete('/diary/:chatId/entries/:id', requireSubscription, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM diary_entries WHERE id = $1 AND chat_id = $2',
      [req.params.id, req.params.chatId]
    );

    res.json({ removed: result.rowCount > 0 });
  } catch (error) {
    console.error('Ошибка удаления записи:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Добавление/обновление воды
app.post('/diary/:chatId/water', requireSubscription, async (req, res) => {
  const { amountMl, date } = req.body;
  const chatId = req.params.chatId;

  if (!amountMl || amountMl < 0) {
    return res.status(400).json({ error: 'amountMl обязателен и должен быть >= 0' });
  }

  try {
    const intakeDate = date || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `INSERT INTO water_intake (chat_id, intake_date, amount_ml, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (chat_id, intake_date)
       DO UPDATE SET
         amount_ml = EXCLUDED.amount_ml,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [chatId, intakeDate, amountMl]
    );

    res.json({ water: result.rows[0] });
  } catch (error) {
    console.error('Ошибка добавления воды:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение воды за день
app.get('/diary/:chatId/water', requireSubscription, async (req, res) => {
  const { date } = req.query;
  const chatId = req.params.chatId;
  const intakeDate = date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(
      'SELECT * FROM water_intake WHERE chat_id = $1 AND intake_date = $2',
      [chatId, intakeDate]
    );

    res.json({
      water: result.rows[0] || { amount_ml: 0, intake_date: intakeDate },
      date: intakeDate
    });
  } catch (error) {
    console.error('Ошибка получения воды:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ==================== ИЗБРАННОЕ ====================

// Получение избранного
app.get('/favorites/:chatId', requireSubscription, async (req, res) => {
  const { page = 0, pageSize = 50 } = req.query;

  try {
    const result = await pool.query(
      `SELECT * FROM diary_favorites
       WHERE chat_id = $1
       ORDER BY added_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.chatId, parseInt(pageSize), parseInt(page) * parseInt(pageSize)]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Добавление в избранное
app.post('/favorites/:chatId', requireSubscription, async (req, res) => {
  const { url, title, text, dishType, hasPhoto, photoFileId } = req.body;

  if (!url || !title) {
    return res.status(400).json({ error: 'url и title обязательны' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO diary_favorites (chat_id, recipe_url, recipe_title, recipe_text, dish_type, has_photo, photo_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chat_id, recipe_url) DO NOTHING
       RETURNING id`,
      [req.params.chatId, url, title, text, dishType, hasPhoto || false, photoFileId]
    );

    res.json({ added: result.rows.length > 0 });
  } catch (error) {
    console.error('Ошибка добавления в избранное:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Удаление из избранного
app.delete('/favorites/:chatId/:id', requireSubscription, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM diary_favorites WHERE id = $1 AND chat_id = $2',
      [req.params.id, req.params.chatId]
    );

    res.json({ removed: result.rowCount > 0 });
  } catch (error) {
    console.error('Ошибка удаления из избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Получение количества избранного
app.get('/favorites/:chatId/count', requireSubscription, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM diary_favorites WHERE chat_id = $1',
      [req.params.chatId]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Ошибка получения количества избранного:', error);
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// ==================== ОБНУЛЕНИЕ ДАННЫХ В 01:00 ====================

async function resetDailyData() {
  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`🔄 Ежедневное обнуление данных (${today})...`);

    // Данные не нужно физически удалять - они хранятся по датам
    // Новые записи автоматически создаются с текущей датой
    // Старые записи остаются для истории

    // Очистка старых записей (старше 30 дней) для экономии места
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split('T')[0];

    // Удаляем старые записи дневника (опционально)
    const deletedEntries = await pool.query(
      'DELETE FROM diary_entries WHERE entry_date < $1',
      [cutoffDate]
    );

    // Удаляем старые записи воды (опционально)
    const deletedWater = await pool.query(
      'DELETE FROM water_intake WHERE intake_date < $1',
      [cutoffDate]
    );

    console.log(`✅ Обнуление данных завершено. Удалено старых записей: ${deletedEntries.rowCount} дневника, ${deletedWater.rowCount} воды`);
  } catch (error) {
    console.error('❌ Ошибка при обнулении данных:', error);
  }
}

// Запускаем обнуление каждый день в 01:00
cron.schedule('0 1 * * *', () => {
  console.log('⏰ Запуск ежедневного обнуления данных...');
  resetDailyData();
});

// ==================== HEALTH CHECK ====================

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'diary-service' });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// ==================== ЗАПУСК СЕРВИСА ====================

const PORT = process.env.PORT || 3005;

initTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Diary Service запущен на порту ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ Ошибка инициализации Diary Service:', error);
    app.listen(PORT, () => {
      console.log(`⚠️ Diary Service запущен на порту ${PORT} (таблицы не инициализированы)`);
    });
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Закрытие Diary Service...');
  await pool.end();
  process.exit(0);
});
