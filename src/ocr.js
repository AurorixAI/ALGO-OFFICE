// Распознавание текста на картинках и сканах (Mistral Document AI / OCR в Azure).
// Нужен, когда основная модель не видит изображения (DeepSeek): текст с фото или скана передаём ей словами.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif', '.pdf': 'application/pdf' };
const MAX_BYTES = 30 * 1048576;

export const ocrEnabled = () => !!(config.ocrEndpoint && config.ocrKey);
export const canOcr = (file) => !!MIME[path.extname(file).toLowerCase()];

export async function ocrFile(full) {
  if (!ocrEnabled()) throw new Error('OCR не настроен (AZURE_OCR_ENDPOINT в .env)');
  const mime = MIME[path.extname(full).toLowerCase()];
  if (!mime) throw new Error('OCR читает только картинки и PDF');
  const buf = await fs.readFile(full);
  if (buf.length > MAX_BYTES) throw new Error('Файл больше 30 МБ — для OCR слишком большой');
  const url = `data:${mime};base64,${buf.toString('base64')}`;
  const document = mime === 'application/pdf' ? { type: 'document_url', document_url: url } : { type: 'image_url', image_url: url };
  const res = await fetch(config.ocrEndpoint, {
    method: 'POST',
    headers: { 'api-key': config.ocrKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ocrModel, document, include_image_base64: false }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('OCR: ' + (data.error?.message || `HTTP ${res.status}`));
  const pages = (data.pages || []).map((p) => String(p.markdown || '').trim());
  const text = pages.length > 1 ? pages.map((t, i) => `--- стр. ${i + 1} ---\n${t}`).join('\n\n') : pages[0] || '';
  return text.trim() || '(текста не найдено)';
}
