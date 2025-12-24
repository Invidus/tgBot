import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config.js';

// Создание пула подключений
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  ssl: config.database.ssl,
  max: 20, // Максимум подключений в пуле
  idleTimeoutMillis: 30000, // Закрывать неиспользуемые подключения через 30 секунд
  connectionTimeoutMillis: 2000, // Таймаут подключения 2 секунды
});

// Обработка ошибок пула
pool.on('error', (err) => {
  console.error('❌ Неожиданная ошибка на неактивном клиенте PostgreSQL', err);
  process.exit(-1);
});

// Функция для проверки подключения
export const testConnection = async () => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('✅ Подключение к PostgreSQL успешно:', result.rows[0].now);
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Ошибка подключения к PostgreSQL:', error);
    return false;
  }
};

// Функция для выполнения запросов
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('📊 Выполнен запрос', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('❌ Ошибка выполнения запроса:', error);
    throw error;
  }
};

// Функция для получения клиента из пула (для транзакций)
export const getClient = async () => {
  const client = await pool.connect();
  const query = client.query;
  const release = client.release;

  // Устанавливаем таймаут для освобождения клиента
  const timeout = setTimeout(() => {
    console.error('⚠️ Клиент был в использовании более 10 секунд');
  }, 10000);

  // Переопределяем release для очистки таймаута
  client.release = () => {
    clearTimeout(timeout);
    release.apply(client);
  };

  return client;
};

// Закрытие пула при завершении приложения
export const closePool = async () => {
  await pool.end();
  console.log('✅ Пул подключений PostgreSQL закрыт');
};

// Инициализация таблиц (вызывается один раз при старте)
export const initTables = async () => {
  try {
    // Проверяем подключение
    const connected = await testConnection();
    if (!connected) {
      return false;
    }

    // Создаем таблицу избранного (если не существует)
    await query(`
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

    // Создаем индексы (если не существуют)
    await query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_chat_id
      ON favorites(chat_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_added_at
      ON favorites(added_at DESC)
    `);

    console.log('✅ Таблицы БД инициализированы');
    return true;
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц:', error);
    return false;
  }
};

export default pool;
