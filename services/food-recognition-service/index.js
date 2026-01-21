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
    console.log(`🔍 Начало распознавания блюда: ${imageUrl}`);

    // Загружаем изображение
    let imageResponse;
    try {
      console.log(`📥 Загрузка изображения из URL...`);
      imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024, // 10MB максимум
        validateStatus: (status) => status === 200
      });
      console.log(`✅ Изображение загружено, размер: ${imageResponse.data.length} байт`);
    } catch (downloadError) {
      console.error('❌ Ошибка загрузки изображения:', {
        message: downloadError.message,
        code: downloadError.code,
        status: downloadError.response?.status
      });
      throw new Error(`Не удалось загрузить изображение: ${downloadError.message}`);
    }

    if (!imageResponse.data || imageResponse.data.length === 0) {
      throw new Error('Изображение пустое или не загружено');
    }

    const imageBuffer = Buffer.from(imageResponse.data);
    console.log(`📦 Буфер изображения создан, размер: ${imageBuffer.length} байт`);

    // Используем Hugging Face для распознавания
    // Пробуем несколько способов передачи данных
    let result;

    // Способ 1: Используем base64 (самый надежный способ для Node.js)
    try {
      console.log(`🤖 Отправка запроса в Hugging Face, модель: ${FOOD_MODEL}`);
      console.log(`📤 Способ 1: Используем base64...`);

      const base64Image = imageBuffer.toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64Image}`;

      result = await hf.imageClassification({
        model: FOOD_MODEL,
        data: dataUrl
      });

      console.log(`✅ Результат от Hugging Face получен (через base64), количество результатов: ${result?.length || 0}`);
    } catch (base64Error) {
      console.log(`⚠️ Способ 1 (base64) не удался: ${base64Error.message}`);
      console.log(`🔄 Пробуем способ 2: прямой HTTP запрос...`);

      // Способ 2: Прямой HTTP запрос к Hugging Face API (отправляем бинарные данные)
      try {
        const apiUrl = `https://api-inference.huggingface.co/models/${FOOD_MODEL}`;
        const headers = {
          'Content-Type': 'image/jpeg'
        };

        if (process.env.HUGGINGFACE_API_TOKEN) {
          headers['Authorization'] = `Bearer ${process.env.HUGGINGFACE_API_TOKEN}`;
        }

        console.log(`📤 Отправка HTTP запроса к ${apiUrl} (бинарные данные)`);

        const httpResponse = await axios.post(apiUrl, imageBuffer, {
          headers: headers,
          timeout: 30000,
          responseType: 'json'
        });

        if (!httpResponse.data || !Array.isArray(httpResponse.data)) {
          throw new Error('Неверный формат ответа от API');
        }

        result = httpResponse.data;
        console.log(`✅ Результат от Hugging Face получен (через HTTP), количество результатов: ${result?.length || 0}`);
      } catch (httpError) {
        console.log(`⚠️ Способ 2 (HTTP) не удался: ${httpError.message}`);
        console.log(`🔄 Пробуем способ 3: через Buffer напрямую...`);

        // Способ 3: Используем Buffer напрямую (последняя попытка)
        try {
          result = await hf.imageClassification({
            model: FOOD_MODEL,
            data: imageBuffer
          });

          console.log(`✅ Результат от Hugging Face получен (через Buffer), количество результатов: ${result?.length || 0}`);
        } catch (bufferError) {
          console.error('❌ Все способы передачи данных не удались:', {
            base64Error: base64Error.message,
            httpError: httpError.message,
            bufferError: bufferError.message
          });
          throw new Error(`Ошибка API распознавания: не удалось передать изображение. Последняя ошибка: ${bufferError.message}`);
        }
      }
    }

    if (!result || !Array.isArray(result) || result.length === 0) {
      console.error('❌ Пустой результат от Hugging Face:', result);
      throw new Error('API не вернул результатов распознавания');
    }

    console.log('📊 Результат распознавания:', JSON.stringify(result.slice(0, 3), null, 2));

    // Берем топ-3 наиболее вероятных блюда
    const topResults = result
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (!topResults[0] || !topResults[0].label) {
      throw new Error('Не удалось определить блюдо из результатов');
    }

    return {
      dishName: topResults[0].label,
      confidence: topResults[0].score,
      alternatives: topResults.slice(1).map(r => ({
        name: r.label,
        confidence: r.score
      }))
    };
  } catch (error) {
    console.error('❌ Ошибка распознавания блюда:', {
      message: error.message,
      stack: error.stack,
      imageUrl: imageUrl
    });
    throw error; // Пробрасываем ошибку дальше с оригинальным сообщением
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

    console.log(`📸 Получен запрос на распознавание от пользователя ${chatId}`);
    console.log(`📋 Параметры запроса:`, { imageUrl: imageUrl ? 'указан' : 'отсутствует', chatId });

    if (!imageUrl) {
      console.error('❌ Отсутствует imageUrl в запросе');
      return res.status(400).json({
        success: false,
        error: 'imageUrl обязателен'
      });
    }

    // Распознаем блюдо
    let recognitionResult;
    try {
      recognitionResult = await recognizeFood(imageUrl);
      console.log(`✅ Блюдо распознано: ${recognitionResult.dishName} (уверенность: ${Math.round(recognitionResult.confidence * 100)}%)`);
    } catch (recognitionError) {
      console.error('❌ Ошибка на этапе распознавания:', recognitionError);
      return res.status(500).json({
        success: false,
        error: recognitionError.message || 'Ошибка распознавания блюда'
      });
    }

    // Получаем калории
    let nutritionInfo;
    try {
      nutritionInfo = await getCalories(recognitionResult.dishName);
      console.log(`✅ Калории получены: ${nutritionInfo.calories} ккал (источник: ${nutritionInfo.source})`);
    } catch (caloriesError) {
      console.error('❌ Ошибка получения калорий, используем примерные значения:', caloriesError);
      // Используем примерные значения в случае ошибки
      nutritionInfo = getEstimatedCalories(recognitionResult.dishName);
    }

    const result = {
      success: true,
      dishName: recognitionResult.dishName,
      confidence: Math.round(recognitionResult.confidence * 100),
      calories: nutritionInfo.calories,
      protein: nutritionInfo.protein,
      carbs: nutritionInfo.carbs,
      fats: nutritionInfo.fats,
      source: nutritionInfo.source,
      alternatives: recognitionResult.alternatives || []
    };

    console.log(`✅ Распознавание завершено успешно: ${result.dishName} (${result.calories} ккал)`);

    res.json(result);
  } catch (error) {
    console.error('❌ Критическая ошибка обработки запроса:', {
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Неожиданная ошибка при распознавании блюда'
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
