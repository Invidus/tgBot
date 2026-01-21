import express from 'express';
import axios from 'axios';
import { HfInference } from '@huggingface/inference';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3004;

// Инициализация Hugging Face (можно использовать без токена для бесплатного использования)
const hf = process.env.HUGGINGFACE_API_TOKEN
  ? new HfInference(process.env.HUGGINGFACE_API_TOKEN)
  : new HfInference();

// Модель для распознавания еды (бесплатная)
const FOOD_MODEL = process.env.FOOD_MODEL || 'nateraw/food-image-classification';

/**
 * Распознавание блюда по фото через Hugging Face
 */
async function recognizeFood(imageUrl) {
  try {
    console.log(`🔍 Распознавание блюда: ${imageUrl}`);

    // Загружаем изображение
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const imageBuffer = Buffer.from(imageResponse.data);

    // Используем Hugging Face для распознавания
    const result = await hf.imageClassification({
      model: FOOD_MODEL,
      data: imageBuffer
    });

    console.log('📊 Результат распознавания:', result);

    // Берем топ-3 наиболее вероятных блюда
    const topResults = result
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return {
      dishName: topResults[0].label,
      confidence: topResults[0].score,
      alternatives: topResults.slice(1).map(r => ({
        name: r.label,
        confidence: r.score
      }))
    };
  } catch (error) {
    console.error('❌ Ошибка распознавания блюда:', error);
    throw new Error(`Ошибка распознавания: ${error.message}`);
  }
}

/**
 * Получение калорий из Open Food Facts API
 */
async function getCalories(dishName) {
  try {
    // Пробуем найти продукт в базе Open Food Facts
    const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(dishName)}&search_simple=1&action=process&json=1&page_size=5`;

    const response = await axios.get(searchUrl, {
      timeout: 10000
    });

    if (response.data && response.data.products && response.data.products.length > 0) {
      const product = response.data.products[0];

      // Извлекаем данные о питательности
      const nutriments = product.nutriments || {};

      return {
        calories: Math.round(nutriments['energy-kcal_100g'] || nutriments['energy-kcal'] || 0),
        protein: Math.round((nutriments['proteins_100g'] || nutriments.proteins || 0) * 10) / 10,
        carbs: Math.round((nutriments['carbohydrates_100g'] || nutriments.carbohydrates || 0) * 10) / 10,
        fats: Math.round((nutriments['fat_100g'] || nutriments.fat || 0) * 10) / 10,
        source: 'Open Food Facts',
        productName: product.product_name || dishName
      };
    }

    // Если не найдено, используем примерные значения на основе названия блюда
    return getEstimatedCalories(dishName);
  } catch (error) {
    console.error('❌ Ошибка получения калорий:', error);
    // В случае ошибки используем примерные значения
    return getEstimatedCalories(dishName);
  }
}

/**
 * Примерные калории на основе названия блюда (fallback)
 */
function getEstimatedCalories(dishName) {
  const dishNameLower = dishName.toLowerCase();

  // Примерная база данных калорий (на 100г)
  const calorieDatabase = {
    'pizza': { calories: 266, protein: 11, carbs: 33, fats: 10 },
    'burger': { calories: 295, protein: 15, carbs: 30, fats: 14 },
    'pasta': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'salad': { calories: 20, protein: 1, carbs: 4, fats: 0 },
    'soup': { calories: 50, protein: 2, carbs: 8, fats: 1 },
    'rice': { calories: 130, protein: 2.7, carbs: 28, fats: 0.3 },
    'chicken': { calories: 239, protein: 27, carbs: 0, fats: 14 },
    'fish': { calories: 206, protein: 22, carbs: 0, fats: 12 },
    'bread': { calories: 265, protein: 9, carbs: 49, fats: 3 },
    'cake': { calories: 367, protein: 5, carbs: 53, fats: 15 }
  };

  // Ищем совпадение
  for (const [key, value] of Object.entries(calorieDatabase)) {
    if (dishNameLower.includes(key)) {
      return {
        ...value,
        source: 'Примерные значения',
        productName: dishName
      };
    }
  }

  // Если не найдено, возвращаем средние значения
  return {
    calories: 200,
    protein: 10,
    carbs: 25,
    fats: 8,
    source: 'Примерные значения',
    productName: dishName
  };
}

/**
 * Основной endpoint для распознавания блюда
 */
app.post('/recognize', async (req, res) => {
  try {
    const { imageUrl, chatId } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl обязателен' });
    }

    console.log(`📸 Получен запрос на распознавание от пользователя ${chatId}`);

    // Распознаем блюдо
    const recognitionResult = await recognizeFood(imageUrl);

    // Получаем калории
    const nutritionInfo = await getCalories(recognitionResult.dishName);

    const result = {
      success: true,
      dishName: recognitionResult.dishName,
      confidence: Math.round(recognitionResult.confidence * 100),
      calories: nutritionInfo.calories,
      protein: nutritionInfo.protein,
      carbs: nutritionInfo.carbs,
      fats: nutritionInfo.fats,
      source: nutritionInfo.source,
      alternatives: recognitionResult.alternatives
    };

    console.log(`✅ Распознавание завершено: ${result.dishName} (${result.calories} ккал)`);

    res.json(result);
  } catch (error) {
    console.error('❌ Ошибка обработки запроса:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Ошибка распознавания блюда'
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'food-recognition-service' });
});

app.listen(PORT, () => {
  console.log(`🚀 Food Recognition Service запущен на порту ${PORT}`);
});
