import dotenv from 'dotenv';

dotenv.config();

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