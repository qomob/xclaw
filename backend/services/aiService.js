import dotenv from 'dotenv';
import cacheService from './cacheService.js';
import logger from './loggerService.js';
import CircuitBreaker from 'opossum';
import crypto from 'crypto';

dotenv.config();

const AI_CONFIG = {
  apiKey: process.env.AI_API_KEY,
  baseUrl: process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: process.env.AI_MODEL || 'gemini-2.5-flash',
  embeddingModel: process.env.AI_EMBEDDING_MODEL || 'gemini-embedding-001',
  embeddingApiKey: process.env.AI_EMBEDDING_API_KEY || process.env.AI_API_KEY,
  embeddingBaseUrl: process.env.AI_EMBEDDING_BASE_URL || process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
};

const breakerOptions = {
  timeout: 30000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000
};

let aiBreaker = null;

async function callLLM(prompt, options = {}) {
  const body = {
    model: options.model || AI_CONFIG.model,
    messages: [
      { role: 'user', content: prompt }
    ],
    temperature: options.temperature ?? 0.1,
  };

  if (options.responseSchema) {
    body.response_format = { type: 'json_object' };
  }

  const url = `${AI_CONFIG.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`LLM API request failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callEmbedding(text) {
  const body = {
    model: AI_CONFIG.embeddingModel,
    input: text
  };

  const url = `${AI_CONFIG.embeddingBaseUrl.replace(/\/+$/, '')}/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.embeddingApiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Embedding API request failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

function initBreaker() {
  aiBreaker = new CircuitBreaker(callLLM, breakerOptions);
  aiBreaker.fallback(() => '{"error": "AI service temporarily unavailable", "valid": false}');
  aiBreaker.on('open', () => logger.warn('AI Circuit Breaker OPENED'));
  aiBreaker.on('halfOpen', () => logger.info('AI Circuit Breaker HALF_OPEN'));
  aiBreaker.on('close', () => logger.info('AI Circuit Breaker CLOSED'));
}

initBreaker();

export async function generateText(prompt, options = {}) {
  try {
    const promptHash = crypto.createHash('sha256').update(String(prompt)).digest('hex');
    const cacheKey = `generate:${promptHash}:${options.model || AI_CONFIG.model}`;

    const cachedResult = await cacheService.get(cacheKey);
    if (cachedResult) {
      logger.debug('Generate cache hit', { cacheKey });
      return cachedResult;
    }

    if (!AI_CONFIG.apiKey) {
      logger.warn('AI_API_KEY not set, returning empty string');
      return '';
    }

    const text = await aiBreaker.fire(prompt, options);

    await cacheService.set(cacheKey, text);
    return text;
  } catch (error) {
    logger.error('Failed to generate text', { error: error.message, stack: error.stack });
    return '';
  }
}

export async function generateEmbedding(text) {
  try {
    const textHash = crypto.createHash('sha256').update(String(text).trim()).digest('hex');
    const cacheKey = `embedding:${textHash}:${AI_CONFIG.embeddingModel}`;

    const cachedResult = await cacheService.get(cacheKey);
    if (cachedResult) {
      logger.debug('Embedding cache hit', { cacheKey });
      return cachedResult;
    }

    if (!AI_CONFIG.embeddingApiKey) {
      throw new Error('AI_EMBEDDING_API_KEY not configured, cannot generate embedding');
    }

    const embedding = await callEmbedding(text);

    await cacheService.set(cacheKey, embedding);
    return embedding;
  } catch (error) {
    logger.error('Failed to generate embedding', { error: error.message, stack: error.stack });
    throw error;
  }
}

export function getAIConfig() {
  return { ...AI_CONFIG };
}

export async function reinitAIClient(config) {
  Object.assign(AI_CONFIG, config);
  initBreaker();
  logger.info('AI client reinitialized', { model: AI_CONFIG.model });
}
