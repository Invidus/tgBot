import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Указываем явный путь к .env файлу
dotenv.config({ path: join(__dirname, '.env') });

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