import express from 'express';
import axios from 'axios';
import { HfInference } from '@huggingface/inference';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3004;

// ==================== КОНФИГУРАЦИЯ ПРОВАЙДЕРОВ ====================

// Выбор провайдера (openai, google, yandex, huggingface)
const AI_PROVIDER = process.env.AI_PROVIDER || 'yandex';

// OpenAI Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

// Google Vision API Configuration
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
const GOOGLE_VISION_PROJECT_ID = process.env.GOOGLE_VISION_PROJECT_ID;

// Yandex Vision API Configuration (бесплатно для России!)
const YANDEX_VISION_API_KEY = process.env.YANDEX_VISION_API_KEY;
const YANDEX_VISION_FOLDER_ID = process.env.YANDEX_VISION_FOLDER_ID;

// Hugging Face Configuration
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_API_TOKEN;
const FOOD_MODEL = process.env.FOOD_MODEL || 'google/vit-base-patch16-224';
const ALTERNATIVE_MODELS = [
  'google/vit-base-patch16-224',
  'microsoft/resnet-50',
  'facebook/deit-base-distilled-patch16-224'
];

// Инициализация провайдеров
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const hf = HUGGINGFACE_TOKEN 
  ? new HfInference(HUGGINGFACE_TOKEN) 
  : new HfInference();

// Логирование конфигурации
console.log(`🔧 Конфигурация AI провайдеров:`);
console.log(`   - Основной провайдер: ${AI_PROVIDER}`);
console.log(`   - OpenAI: ${openai ? '✅ настроен' : '❌ не настроен (нужен OPENAI_API_KEY)'}`);
console.log(`   - Google Vision: ${GOOGLE_VISION_API_KEY ? '✅ настроен' : '❌ не настроен (нужен GOOGLE_VISION_API_KEY)'}`);
console.log(`   - Yandex Vision: ${YANDEX_VISION_API_KEY ? '✅ настроен' : '❌ не настроен (нужен YANDEX_VISION_API_KEY)'}`);
console.log(`   - Hugging Face: ${HUGGINGFACE_TOKEN ? '✅ настроен' : '⚠️ без токена'}`);

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

// ==================== OPENAI GPT-4 VISION ====================

async function recognizeWithOpenAI(imageBuffer, imageUrl) {
  if (!openai) {
    throw new Error('OpenAI API не настроен. Укажите OPENAI_API_KEY в переменных окружения.');
  }

  try {
    console.log(`🤖 Использование OpenAI ${OPENAI_MODEL} для распознавания...`);
    
    // Конвертируем изображение в base64
    const base64Image = imageBuffer.toString('base64');
    
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Определи, какое блюдо изображено на этой фотографии. Ответь ТОЛЬКО названием блюда на русском языке, без дополнительных объяснений. Если это не еда, ответь "не еда".`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 50,
      temperature: 0.3
    });

    const dishName = response.choices[0]?.message?.content?.trim();
    
    if (!dishName || dishName.toLowerCase().includes('не еда')) {
      throw new Error('На изображении не распознано блюдо');
    }

    console.log(`✅ OpenAI распознал: ${dishName}`);
    
    return {
      dishName: dishName,
      confidence: 0.95, // OpenAI обычно очень точный
      provider: 'OpenAI',
      alternatives: []
    };
  } catch (error) {
    console.error(`❌ Ошибка OpenAI: ${error.message}`);
    throw error;
  }
}

// ==================== GOOGLE VISION API ====================

async function recognizeWithGoogleVision(imageBuffer, imageUrl) {
  if (!GOOGLE_VISION_API_KEY) {
    throw new Error('Google Vision API не настроен. Укажите GOOGLE_VISION_API_KEY в переменных окружения.');
  }

  try {
    console.log(`🤖 Использование Google Vision API для распознавания...`);
    
    const base64Image = imageBuffer.toString('base64');
    
    // Используем Google Vision API для определения объектов и текста
    const apiUrl = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;
    
    const requestBody = {
      requests: [
        {
          image: {
            content: base64Image
          },
          features: [
            {
              type: 'LABEL_DETECTION',
              maxResults: 10
            },
            {
              type: 'OBJECT_LOCALIZATION',
              maxResults: 10
            }
          ]
        }
      ]
    };

    const response = await axios.post(apiUrl, requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.data?.responses?.[0]) {
      throw new Error('Пустой ответ от Google Vision API');
    }

    const result = response.data.responses[0];
    const labels = result.labelAnnotations || [];
    const objects = result.localizedObjectAnnotations || [];

    // Ищем еду среди меток
    const foodLabels = labels.filter(label => {
      const desc = label.description?.toLowerCase() || '';
      return desc.includes('food') || desc.includes('dish') || desc.includes('meal') || 
             desc.includes('cuisine') || desc.includes('recipe') || desc.includes('cooking');
    });

    // Ищем объекты, связанные с едой
    const foodObjects = objects.filter(obj => {
      const name = obj.name?.toLowerCase() || '';
      return name.includes('food') || name.includes('dish') || name.includes('meal');
    });

    // Берем наиболее релевантную метку
    let dishName = null;
    let confidence = 0.7;

    if (foodLabels.length > 0) {
      dishName = foodLabels[0].description;
      confidence = foodLabels[0].score || 0.7;
    } else if (labels.length > 0) {
      // Если нет явных меток еды, берем первую метку
      dishName = labels[0].description;
      confidence = labels[0].score || 0.6;
    } else if (foodObjects.length > 0) {
      dishName = foodObjects[0].name;
      confidence = 0.7;
    }

    if (!dishName) {
      throw new Error('Не удалось определить блюдо через Google Vision API');
    }

    // Переводим на русский, если нужно (упрощенная версия)
    const dishNameRu = translateToRussian(dishName);

    console.log(`✅ Google Vision распознал: ${dishNameRu} (уверенность: ${Math.round(confidence * 100)}%)`);
    
    return {
      dishName: dishNameRu,
      confidence: confidence,
      provider: 'Google Vision',
      alternatives: labels.slice(1, 4).map(l => ({
        name: translateToRussian(l.description),
        confidence: l.score || 0.5
      }))
    };
  } catch (error) {
    console.error(`❌ Ошибка Google Vision: ${error.message}`);
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
    'dish': 'блюдо'
  };

  const lower = englishName.toLowerCase();
  for (const [en, ru] of Object.entries(translations)) {
    if (lower.includes(en)) {
      return ru;
    }
  }
  
  return englishName; // Возвращаем оригинал, если нет перевода
}

// ==================== YANDEX VISION API ====================

async function recognizeWithYandexVision(imageBuffer, imageUrl) {
  if (!YANDEX_VISION_API_KEY || !YANDEX_VISION_FOLDER_ID) {
    throw new Error('Yandex Vision API не настроен. Укажите YANDEX_VISION_API_KEY и YANDEX_VISION_FOLDER_ID в переменных окружения.');
  }

  try {
    console.log(`🤖 Использование Yandex Vision API для распознавания...`);
    
    const base64Image = imageBuffer.toString('base64');
    
    // Получаем IAM токен для аутентификации
    let iamToken = process.env.YANDEX_IAM_TOKEN;
    
    // Если IAM токен не указан, получаем его через API ключ сервисного аккаунта
    if (!iamToken) {
      try {
        // Пробуем получить IAM токен через API ключ сервисного аккаунта
        const iamResponse = await axios.post('https://iam.api.cloud.yandex.net/iam/v1/tokens', {
          yandexPassportOauthToken: YANDEX_VISION_API_KEY
        }, {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });
        iamToken = iamResponse.data.iamToken;
        console.log(`✅ IAM токен получен через OAuth токен`);
      } catch (iamError) {
        // Если это API ключ сервисного аккаунта, используем его напрямую
        // API ключ сервисного аккаунта начинается с "AQVN..."
        if (YANDEX_VISION_API_KEY.startsWith('AQVN')) {
          iamToken = YANDEX_VISION_API_KEY;
          console.log(`✅ Используется API ключ сервисного аккаунта`);
        } else {
          throw new Error(`Не удалось получить IAM токен: ${iamError.message}`);
        }
      }
    }
    
    // Используем Yandex Vision API
    const apiUrl = `https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze`;
    
    const requestBody = {
      folderId: YANDEX_VISION_FOLDER_ID,
      analyzeSpecs: [
        {
          content: base64Image,
          features: [
            {
              type: 'CLASSIFICATION',
              classificationConfig: {
                model: 'food' // Специальная модель для еды
              }
            },
            {
              type: 'TEXT_DETECTION'
            }
          ]
        }
      ]
    };

    const response = await axios.post(apiUrl, requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${iamToken}`
      }
    });

    if (!response.data?.results?.[0]) {
      throw new Error('Пустой ответ от Yandex Vision API');
    }

    const result = response.data.results[0];
    const classifications = result.classification?.properties || [];
    const textBlocks = result.textDetection?.blocks || [];

    // Ищем еду среди классификаций
    let dishName = null;
    let confidence = 0.7;

    if (classifications.length > 0) {
      // Берем наиболее вероятную классификацию
      const topClassification = classifications
        .sort((a, b) => (b.probability || 0) - (a.probability || 0))[0];
      
      if (topClassification && topClassification.name) {
        dishName = topClassification.name;
        confidence = topClassification.probability || 0.7;
      }
    }

    // Если не нашли через классификацию, пробуем извлечь из текста
    if (!dishName && textBlocks.length > 0) {
      const text = textBlocks
        .map(block => block.lines?.map(line => line.words?.map(w => w.text).join(' ')).join(' ') || '')
        .join(' ')
        .toLowerCase();
      
      // Ищем ключевые слова о еде
      const foodKeywords = ['пицца', 'бургер', 'салат', 'суп', 'паста', 'рис', 'курица', 'рыба', 'хлеб', 'торт'];
      for (const keyword of foodKeywords) {
        if (text.includes(keyword)) {
          dishName = keyword;
          confidence = 0.6;
          break;
        }
      }
    }

    if (!dishName) {
      throw new Error('Не удалось определить блюдо через Yandex Vision API');
    }

    console.log(`✅ Yandex Vision распознал: ${dishName} (уверенность: ${Math.round(confidence * 100)}%)`);
    
    return {
      dishName: dishName,
      confidence: confidence,
      provider: 'Yandex Vision',
      alternatives: classifications.slice(1, 4).map(c => ({
        name: c.name || 'неизвестно',
        confidence: c.probability || 0.5
      }))
    };
  } catch (error) {
    console.error(`❌ Ошибка Yandex Vision: ${error.message}`);
    if (error.response?.data) {
      console.error(`   Детали ошибки:`, JSON.stringify(error.response.data));
    }
    throw error;
  }
}

// ==================== HUGGING FACE ====================

async function recognizeWithHuggingFace(imageBuffer, imageUrl) {
  try {
    console.log(`🤖 Использование Hugging Face для распознавания...`);
    
    // Пробуем использовать новый router endpoint
    const apiUrl = `https://router.huggingface.co/models/${FOOD_MODEL}`;
    const headers = {
      'Content-Type': 'image/jpeg',
      'Accept': 'application/json'
    };

    if (HUGGINGFACE_TOKEN) {
      headers['Authorization'] = `Bearer ${HUGGINGFACE_TOKEN}`;
    }

    let result;
    let lastError;

    // Пробуем основную модель
    for (const model of [FOOD_MODEL, ...ALTERNATIVE_MODELS]) {
      if (model === FOOD_MODEL && ALTERNATIVE_MODELS.includes(model)) continue;
      
      try {
        console.log(`📤 Попытка с моделью: ${model}`);
        const modelUrl = `https://router.huggingface.co/models/${model}`;
        
        const response = await axios.post(modelUrl, imageBuffer, {
          headers: headers,
          timeout: 60000,
          responseType: 'json',
          validateStatus: (status) => (status >= 200 && status < 300) || status === 503
        });

        if (response.status === 503) {
          const waitTime = response.data?.estimated_time 
            ? Math.ceil(response.data.estimated_time) * 1000 
            : 20000;
          console.log(`⏳ Модель загружается, ждем ${waitTime/1000} секунд...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          const retryResponse = await axios.post(modelUrl, imageBuffer, {
            headers: headers,
            timeout: 60000,
            responseType: 'json',
            validateStatus: (status) => status >= 200 && status < 300
          });
          
          if (retryResponse.data && Array.isArray(retryResponse.data)) {
            result = retryResponse.data;
            break;
          }
        } else if (response.data && Array.isArray(response.data)) {
          result = response.data;
          break;
        }
      } catch (error) {
        lastError = error;
        console.log(`⚠️ Модель ${model} не работает: ${error.message}`);
        continue;
      }
    }

    // Если HTTP не сработал, пробуем SDK
    if (!result) {
      try {
        console.log(`🔄 Пробуем через Hugging Face SDK...`);
        result = await hf.imageClassification({
          model: FOOD_MODEL,
          data: imageBuffer
        });
      } catch (sdkError) {
        console.error(`❌ Hugging Face SDK тоже не сработал: ${sdkError.message}`);
        throw lastError || sdkError;
      }
    }

    if (!result || !Array.isArray(result) || result.length === 0) {
      throw new Error('Hugging Face не вернул результатов');
    }

    // Сортируем по уверенности и берем топ результаты
    const topResults = result
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3);

    if (!topResults[0] || !topResults[0].label) {
      throw new Error('Не удалось определить блюдо из результатов Hugging Face');
    }

    console.log(`✅ Hugging Face распознал: ${topResults[0].label} (уверенность: ${Math.round((topResults[0].score || 0) * 100)}%)`);

    return {
      dishName: topResults[0].label,
      confidence: topResults[0].score || 0.7,
      provider: 'Hugging Face',
      alternatives: topResults.slice(1).map(r => ({
        name: r.label,
        confidence: r.score || 0.5
      }))
    };
  } catch (error) {
    console.error(`❌ Ошибка Hugging Face: ${error.message}`);
    throw error;
  }
}

// ==================== ОСНОВНАЯ ФУНКЦИЯ РАСПОЗНАВАНИЯ ====================

async function recognizeFood(imageUrl) {
  const imageBuffer = await loadImage(imageUrl);
  
  const providers = [];
  
  // Добавляем все доступные провайдеры
  if (openai) {
    providers.push({ name: 'OpenAI', fn: recognizeWithOpenAI });
  }
  if (YANDEX_VISION_API_KEY && YANDEX_VISION_FOLDER_ID) {
    providers.push({ name: 'Yandex Vision', fn: recognizeWithYandexVision });
  }
  if (GOOGLE_VISION_API_KEY) {
    providers.push({ name: 'Google Vision', fn: recognizeWithGoogleVision });
  }
  providers.push({ name: 'Hugging Face', fn: recognizeWithHuggingFace });

  // Переставляем основной провайдер в начало
  const primaryProviderIndex = providers.findIndex(p => {
    if (AI_PROVIDER === 'openai') return p.name === 'OpenAI';
    if (AI_PROVIDER === 'yandex') return p.name === 'Yandex Vision';
    if (AI_PROVIDER === 'google') return p.name === 'Google Vision';
    if (AI_PROVIDER === 'huggingface') return p.name === 'Hugging Face';
    return false;
  });

  if (primaryProviderIndex > 0) {
    const primary = providers.splice(primaryProviderIndex, 1)[0];
    providers.unshift(primary);
  }

  console.log(`🔄 Порядок провайдеров: ${providers.map(p => p.name).join(' → ')}`);

  // Пробуем провайдеры по очереди
  let lastError;
  for (const provider of providers) {
    try {
      console.log(`\n🔍 Попытка распознавания через ${provider.name}...`);
      const result = await provider.fn(imageBuffer, imageUrl);
      console.log(`✅ Успешно распознано через ${provider.name}: ${result.dishName}`);
      return result;
    } catch (error) {
      console.error(`❌ ${provider.name} не сработал: ${error.message}`);
      lastError = error;
      continue; // Пробуем следующий провайдер
    }
  }

  // Если все провайдеры не сработали
  throw new Error(`Все провайдеры не сработали. Последняя ошибка: ${lastError?.message || 'неизвестная ошибка'}`);
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
    provider: AI_PROVIDER,
    providers: {
      openai: !!openai,
      yandex: !!(YANDEX_VISION_API_KEY && YANDEX_VISION_FOLDER_ID),
      google: !!GOOGLE_VISION_API_KEY,
      huggingface: !!HUGGINGFACE_TOKEN
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Food Recognition Service запущен на порту ${PORT}`);
  console.log(`📋 Используется провайдер: ${AI_PROVIDER}`);
});
