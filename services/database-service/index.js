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

// Инициализация таблицы favorites
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

    // Создаем индексы
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_chat_id
      ON favorites(chat_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_added_at
      ON favorites(added_at DESC)
    `);
    console.log('✅ Индексы созданы');
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

// Получение списка избранного
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

// Удаление из избранного
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

