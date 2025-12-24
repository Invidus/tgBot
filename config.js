import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Пробуем несколько вариантов путей
const envPaths = [
  join(__dirname, '.env'),  // Относительный путь
  '/app/.env',              // Абсолютный путь в Docker
  '.env'                    // Текущая директория
];

let envPath = null;
for (const path of envPaths) {
  if (existsSync(path)) {
    envPath = path;
    break;
  }
}

if (envPath) {
  // Загружаем .env с подавлением предупреждений
  const result = dotenv.config({ path: envPath, quiet: true });

  if (result.error) {
    console.error('❌ Ошибка загрузки .env:', result.error);
  }
} else {
  // Если файл не найден, пробуем загрузить из текущей директории
  dotenv.config({ quiet: true });
}

if (!process.env.TELEGRAM_TOKEN) {
  console.error('❌ ОШИБКА: TELEGRAM_TOKEN не установлен в переменных окружения!');
  console.error('Создайте файл .env на основе .env.example и укажите ваш токен бота.');
  process.exit(1);
}

export const config = {
  "telegramToken": process.env.TELEGRAM_TOKEN,
  "foodUrl": process.env.FOOD_URL || "https://1000.menu/catalog/na-zavtrak",
  "dinnerUrl": process.env.DINNER_URL || "https://1000.menu/catalog/pp-obed",
  "lunchUrl": process.env.LUNCH_URL || "https://1000.menu/catalog/zvanji-uzhin",
  "database": {
    "host": process.env.DB_HOST || "localhost",
    "port": process.env.DB_PORT || 5432,
    "database": process.env.DB_NAME || "tgbot_db",
    "user": process.env.DB_USER || "tgbot_user",
    "password": process.env.DB_PASSWORD,
    "ssl": process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
  }
}