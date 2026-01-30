import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Пробуем несколько вариантов путей для .env
const envPaths = [
  join(__dirname, '../../.env'),
  join(__dirname, '../../../.env'),
  '/app/.env',
  '.env'
];

let envPath = null;
for (const path of envPaths) {
  if (existsSync(path)) {
    envPath = path;
    break;
  }
}

if (envPath) {
  dotenv.config({ path: envPath, quiet: true });
} else {
  dotenv.config({ quiet: true });
}

export const config = {
  telegramToken: process.env.TELEGRAM_TOKEN,
  botUsername: process.env.BOT_USERNAME || '', // для реферальной ссылки (без @)
  foodUrl: process.env.FOOD_URL || "https://1000.menu/catalog/na-zavtrak",
  dinnerUrl: process.env.DINNER_URL || "https://1000.menu/catalog/pp-obed",
  lunchUrl: process.env.LUNCH_URL || "https://1000.menu/catalog/zvanji-uzhin",
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined
  },
  database: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "tgbot_db",
    user: process.env.DB_USER || "tgbot_user",
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
  },
  services: {
    recipeParser: process.env.RECIPE_PARSER_URL || "http://localhost:3001",
    database: process.env.DATABASE_SERVICE_URL || "http://localhost:3002",
    foodRecognition: process.env.FOOD_RECOGNITION_URL || "http://localhost:3004",
    diary: process.env.DIARY_SERVICE_URL || "http://localhost:3005"
  },
  telegramPayment: {
    providerToken: process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN
  }
};

