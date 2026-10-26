import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

// Откуда берём модель: OpenRouter (по умолчанию) или Azure (AI Foundry / Azure OpenAI)
const llmProvider = (env.LLM_PROVIDER || (env.AZURE_API_KEY && !env.OPENROUTER_API_KEY ? 'azure' : 'openrouter')).trim().toLowerCase();

export const config = {
  llmProvider,
  openrouterKey: env.OPENROUTER_API_KEY || '',
  // Azure: адрес из портала (Target URI или endpoint ресурса), ключ и имя деплоя модели в MODEL
  azureEndpoint: (env.AZURE_ENDPOINT || '').trim(),
  azureKey: env.AZURE_API_KEY || '',
  azureApiVersion: env.AZURE_API_VERSION || '',
  model: env.MODEL || (llmProvider === 'azure' ? '' : 'z-ai/glm-5.3-flash'),
  // без ADMIN_PASSWORD пароль генерируется при каждом запуске и печатается в лог
  adminPassword: env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url'),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, ''),
  port: Number(env.PORT || 8080),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // Прямой канал с Саней (личный ассистент владельца, отдельное приложение): общий токен и его адрес
  linkToken: env.AGENT_LINK_TOKEN || '',
  sanyaUrl: (env.SANYA_URL || '').replace(/\/$/, ''),
};

config.workspaceDir = path.join(config.dataDir, 'workspace');

if (!env.ADMIN_PASSWORD) console.warn(`[config] ADMIN_PASSWORD не задан — пароль от офиса на этот запуск: ${config.adminPassword}`);
if (llmProvider === 'azure') {
  const miss = [!config.azureEndpoint && 'AZURE_ENDPOINT', !config.azureKey && 'AZURE_API_KEY', !config.model && 'MODEL (имя деплоя)'].filter(Boolean);
  if (miss.length) console.warn(`[config] Azure: не задано ${miss.join(', ')} — агенты не смогут думать`);
  else console.log(`[config] модель: ${config.model} через Azure`);
} else if (!config.openrouterKey) console.warn('[config] OPENROUTER_API_KEY не задан — агенты не смогут думать');
