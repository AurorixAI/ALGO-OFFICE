import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

export const config = {
  openrouterKey: env.OPENROUTER_API_KEY || '',
  model: env.MODEL || 'z-ai/glm-5.3-flash',
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
if (!config.openrouterKey) console.warn('[config] OPENROUTER_API_KEY не задан — агенты не смогут думать');
