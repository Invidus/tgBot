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
    console.log('🔄 Начало инициализации таблиц...');

    // Проверяем подключение
    const connected = await testConnection();
    if (!connected) {
      console.error('❌ Не удалось подключиться к БД, таблицы не будут созданы');
      return false;
    }

    console.log('🔄 Создание таблицы favorites...');

    // Создаем таблицу избранного (если не существует)
    const createTableResult = await query(`
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
    console.log('✅ Команда CREATE TABLE favorites выполнена');

    console.log('🔄 Создание таблицы users...');

    // Создаем таблицу пользователей (если не существует)
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL UNIQUE,
        username VARCHAR(255),
        free_requests INTEGER DEFAULT 0,
        subscription_end_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Команда CREATE TABLE users выполнена');

    // Создаем индексы (если не существуют)
    console.log('🔄 Создание индексов...');
    await query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_chat_id
      ON favorites(chat_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_added_at
      ON favorites(added_at DESC)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_chat_id
      ON users(chat_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_username
      ON users(username)
    `);

    console.log('✅ Таблицы БД инициализированы');

    // Проверяем, что таблица действительно создана
    const exists = await checkTableExists('favorites');
    if (!exists) {
      console.error('⚠️ ВНИМАНИЕ: Таблица favorites не была создана, несмотря на успешное выполнение команды');
    }

    return true;
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц:', error);
    console.error('❌ Детали ошибки:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      hint: error.hint,
      stack: error.stack
    });
    return false;
  }
};

// Функция для проверки существования таблицы
export const checkTableExists = async (tableName = 'favorites') => {
  try {
    const result = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = $1
      )
    `, [tableName]);

    const exists = result.rows[0].exists;
    if (exists) {
      console.log(`✅ Таблица "${tableName}" существует`);
      // Получаем информацию о таблице
      const tableInfo = await query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);
      console.log(`📋 Структура таблицы "${tableName}":`);
      tableInfo.rows.forEach(col => {
        console.log(`   - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
      });
    } else {
      console.log(`❌ Таблица "${tableName}" не существует`);
    }
    return exists;
  } catch (error) {
    console.error(`❌ Ошибка проверки таблицы "${tableName}":`, error);
    return false;
  }
};

export default pool;
