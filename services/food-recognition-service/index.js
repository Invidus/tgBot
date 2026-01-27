import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3004;

// ==================== КОНФИГУРАЦИЯ CLARIFAI ====================

const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY;

if (!CLARIFAI_API_KEY) {
  console.error('❌ CLARIFAI_API_KEY не указан в переменных окружения!');
  console.error('   Получите токен на https://clarifai.com/settings/security');
}

// Логирование конфигурации
console.log(`🔧 Конфигурация AI провайдера:`);
console.log(`   - Clarifai: ${CLARIFAI_API_KEY ? '✅ настроен' : '❌ не настроен (нужен CLARIFAI_API_KEY)'}`);

// ==================== ЗАГРУЗКА ИЗОБРАЖЕНИЯ ====================

async function loadImage(imageUrl) {
  try {
    console.log(`📥 Загрузка изображения из URL...`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // 10MB максимум
      validateStatus: (status) => status === 200
    });
    
    if (!imageResponse.data || imageResponse.data.length === 0) {
      throw new Error('Изображение пустое или не загружено');
    }
    
    console.log(`✅ Изображение загружено, размер: ${imageResponse.data.length} байт`);
    return Buffer.from(imageResponse.data);
  } catch (error) {
    console.error('❌ Ошибка загрузки изображения:', error.message);
    throw new Error(`Не удалось загрузить изображение: ${error.message}`);
  }
}

// ==================== CLARIFAI API ====================

async function recognizeWithClarifai(imageBuffer, imageUrl) {
  if (!CLARIFAI_API_KEY) {
    throw new Error('Clarifai API не настроен. Укажите CLARIFAI_API_KEY в переменных окружения.');
  }

  try {
    console.log(`🤖 Использование Clarifai для распознавания...`);
    
    // Конвертируем изображение в base64
    const base64Image = imageBuffer.toString('base64');
    
    // Используем публичную модель Clarifai для распознавания еды
    // food-item-recognition - распознает более 1000 видов еды
    const apiUrl = 'https://api.clarifai.com/v2/users/clarifai/apps/main/models/food-item-recognition/outputs';
    
    const requestBody = {
      inputs: [
        {
          data: {
            image: {
              base64: base64Image
            }
          }
        }
      ]
    };

    const response = await axios.post(apiUrl, requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${CLARIFAI_API_KEY}`
      }
    });

    if (!response.data?.outputs?.[0]?.data?.concepts) {
      throw new Error('Пустой ответ от Clarifai API');
    }

    const concepts = response.data.outputs[0].data.concepts;
    
    // Сортируем по уверенности и берем топ результаты
    const topConcepts = concepts
      .sort((a, b) => (b.value || 0) - (a.value || 0))
      .slice(0, 5);

    if (!topConcepts[0] || !topConcepts[0].name) {
      throw new Error('Не удалось определить блюдо через Clarifai API');
    }

    // Берем наиболее вероятное блюдо
    const dishName = topConcepts[0].name;
    const confidence = topConcepts[0].value || 0.7;

    // Переводим на русский, если нужно
    const dishNameRu = translateToRussian(dishName);

    console.log(`✅ Clarifai распознал: ${dishNameRu} (уверенность: ${Math.round(confidence * 100)}%)`);
    
    return {
      dishName: dishNameRu,
      confidence: confidence,
      provider: 'Clarifai',
      alternatives: topConcepts.slice(1, 4).map(c => ({
        name: translateToRussian(c.name),
        confidence: c.value || 0.5
      }))
    };
  } catch (error) {
    console.error(`❌ Ошибка Clarifai: ${error.message}`);
    if (error.response?.status === 401) {
      console.error(`💡 Ошибка 401: Неверный API ключ. Проверьте CLARIFAI_API_KEY`);
    } else if (error.response?.status === 403) {
      console.error(`💡 Ошибка 403: Недостаточно прав. Убедитесь, что токен имеет scope "Model: Predict"`);
    } else if (error.response?.data) {
      console.error(`   Детали ошибки:`, JSON.stringify(error.response.data));
    }
    throw error;
  }
}

// Простая функция перевода (можно улучшить)
function translateToRussian(englishName) {
  const translations = {
    'pizza': 'пицца',
    'burger': 'бургер',
    'pasta': 'паста',
    'salad': 'салат',
    'soup': 'суп',
    'rice': 'рис',
    'chicken': 'курица',
    'fish': 'рыба',
    'bread': 'хлеб',
    'cake': 'торт',
    'sandwich': 'сэндвич',
    'sushi': 'суши',
    'steak': 'стейк',
    'pasta dish': 'паста',
    'food': 'еда',
    'dish': 'блюдо',
    'apple': 'яблоко',
    'banana': 'банан',
    'orange': 'апельсин',
    'coffee': 'кофе',
    'tea': 'чай',
    'milk': 'молоко',
    'egg': 'яйцо',
    'cheese': 'сыр',
    'meat': 'мясо',
    'vegetable': 'овощ',
    'fruit': 'фрукт'
  };

  const lower = englishName.toLowerCase();
  for (const [en, ru] of Object.entries(translations)) {
    if (lower.includes(en)) {
      return ru;
    }
  }
  
  return englishName; // Возвращаем оригинал, если нет перевода
}

// ==================== ОСНОВНАЯ ФУНКЦИЯ РАСПОЗНАВАНИЯ ====================

async function recognizeFood(imageUrl) {
  const imageBuffer = await loadImage(imageUrl);
  return await recognizeWithClarifai(imageBuffer, imageUrl);
}

// ==================== ПОЛУЧЕНИЕ КАЛОРИЙ ====================

async function getCalories(dishName) {
  try {
    // Пробуем найти продукт в базе Open Food Facts
    const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(dishName)}&search_simple=1&action=process&json=1&page_size=5`;

    const response = await axios.get(searchUrl, {
      timeout: 10000
    });

    if (response.data && response.data.products && response.data.products.length > 0) {
      const product = response.data.products[0];
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

    return getEstimatedCalories(dishName);
  } catch (error) {
    console.error('❌ Ошибка получения калорий:', error);
    return getEstimatedCalories(dishName);
  }
}

function getEstimatedCalories(dishName) {
  const dishNameLower = dishName.toLowerCase();

  const calorieDatabase = {
    'пицца': { calories: 266, protein: 11, carbs: 33, fats: 10 },
    'pizza': { calories: 266, protein: 11, carbs: 33, fats: 10 },
    'бургер': { calories: 295, protein: 15, carbs: 30, fats: 14 },
    'burger': { calories: 295, protein: 15, carbs: 30, fats: 14 },
    'паста': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'pasta': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'салат': { calories: 20, protein: 1, carbs: 4, fats: 0 },
    'salad': { calories: 20, protein: 1, carbs: 4, fats: 0 },
    'суп': { calories: 50, protein: 2, carbs: 8, fats: 1 },
    'soup': { calories: 50, protein: 2, carbs: 8, fats: 1 },
    'рис': { calories: 130, protein: 2.7, carbs: 28, fats: 0.3 },
    'rice': { calories: 130, protein: 2.7, carbs: 28, fats: 0.3 },
    'курица': { calories: 239, protein: 27, carbs: 0, fats: 14 },
    'chicken': { calories: 239, protein: 27, carbs: 0, fats: 14 },
    'рыба': { calories: 206, protein: 22, carbs: 0, fats: 12 },
    'fish': { calories: 206, protein: 22, carbs: 0, fats: 12 },
    'хлеб': { calories: 265, protein: 9, carbs: 49, fats: 3 },
    'bread': { calories: 265, protein: 9, carbs: 49, fats: 3 },
    'торт': { calories: 367, protein: 5, carbs: 53, fats: 15 },
    'cake': { calories: 367, protein: 5, carbs: 53, fats: 15 },
    'суши': { calories: 150, protein: 5, carbs: 30, fats: 1 },
    'sushi': { calories: 150, protein: 5, carbs: 30, fats: 1 }
  };

  for (const [key, value] of Object.entries(calorieDatabase)) {
    if (dishNameLower.includes(key)) {
      return {
        ...value,
        source: 'Примерные значения',
        productName: dishName
      };
    }
  }

  return {
    calories: 200,
    protein: 10,
    carbs: 25,
    fats: 8,
    source: 'Примерные значения',
    productName: dishName
  };
}

// ==================== API ENDPOINTS ====================

app.post('/recognize', async (req, res) => {
  try {
    const { imageUrl, chatId } = req.body;

    console.log(`\n📸 Получен запрос на распознавание от пользователя ${chatId}`);
    console.log(`📋 Параметры запроса:`, { imageUrl: imageUrl ? 'указан' : 'отсутствует', chatId });

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'imageUrl обязателен'
      });
    }

    // Распознаем блюдо
    let recognitionResult;
    try {
      recognitionResult = await recognizeFood(imageUrl);
      console.log(`✅ Блюдо распознано: ${recognitionResult.dishName} (уверенность: ${Math.round(recognitionResult.confidence * 100)}%, провайдер: ${recognitionResult.provider})`);
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
      provider: recognitionResult.provider,
      alternatives: recognitionResult.alternatives || []
    };

    console.log(`✅ Распознавание завершено успешно: ${result.dishName} (${result.calories} ккал, провайдер: ${result.provider})\n`);

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

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'food-recognition-service',
    provider: 'clarifai',
    clarifai: !!CLARIFAI_API_KEY
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Food Recognition Service запущен на порту ${PORT}`);
  console.log(`📋 Используется провайдер: Clarifai`);
});
