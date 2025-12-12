import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

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

// Отладочная информация
console.log('🔍 Ищем .env файл...');
console.log('📁 __dirname:', __dirname);
console.log('📁 process.cwd():', process.cwd());
console.log('📄 Найден .env по пути:', envPath || 'НЕ НАЙДЕН');

if (envPath) {
  // Проверяем содержимое файла
  try {
    const envContent = readFileSync(envPath, 'utf8');
    const lines = envContent.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
    console.log('📝 Строк в .env:', lines.length);
    console.log('📝 Первые строки:', lines.slice(0, 3).join(', '));
  } catch (err) {
    console.error('❌ Ошибка чтения .env:', err.message);
  }

  const result = dotenv.config({ path: envPath });

  if (result.error) {
    console.error('❌ Ошибка dotenv:', result.error);
  } else {
    console.log('✅ dotenv загружен успешно');
    console.log('🔑 Найдено переменных:', Object.keys(result.parsed || {}).length);
  }
} else {
  console.warn('⚠️ Файл .env не найден, используем переменные окружения системы');
  dotenv.config(); // Пробуем загрузить из текущей директории
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
}