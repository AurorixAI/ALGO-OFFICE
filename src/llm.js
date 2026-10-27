// Клиент модели: OpenRouter или Azure — оба говорят на OpenAI-совместимом chat/completions с tool calling.
import { config } from './config.js';
import { store, save } from './store.js';

// Учёт расхода: всего, по дням и по агентам
function recordUsage(u, agent) {
  const s = store.stats;
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });
  const add = (o) => {
    o.calls = (o.calls || 0) + 1;
    o.prompt = (o.prompt || 0) + (u.prompt_tokens || 0);
    o.completion = (o.completion || 0) + (u.completion_tokens || 0);
    o.tokens = (o.tokens || 0) + (u.total_tokens || 0);
    o.cost = (o.cost || 0) + (u.cost || 0);
  };
  s.tokens += u.total_tokens || 0;
  s.cost += u.cost || 0;
  s.prompt = (s.prompt || 0) + (u.prompt_tokens || 0);
  s.completion = (s.completion || 0) + (u.completion_tokens || 0);
  add(((s.daily ||= {})[day] ||= {}));
  if (agent) add(((s.byAgent ||= {})[agent] ||= {}));
  const days = Object.keys(s.daily).sort();
  for (const d of days.slice(0, -60)) delete s.daily[d];
  save();
}

// Адрес, заголовки и особые поля запроса для выбранного провайдера
function target() {
  if (config.llmProvider === 'azure') {
    if (!config.azureEndpoint || !config.azureKey || !config.model) throw new Error('Azure не настроен: впиши в .env AZURE_ENDPOINT, AZURE_API_KEY и MODEL (имя деплоя) и перезапусти офис');
    // принимаем и полный Target URI из портала, и просто адрес ресурса
    let url = config.azureEndpoint.replace(/\/+$/, '');
    if (!/\/chat\/completions(\?|$)/.test(url)) url += '/chat/completions';
    if (!/[?&]api-version=/.test(url)) {
      const version = config.azureApiVersion || (url.includes('/openai/deployments/') ? '2024-10-21' : /\/models\//.test(url) ? '2024-05-01-preview' : '');
      if (version) url += (url.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(version);
    }
    return { url, headers: { 'api-key': config.azureKey }, extra: {} };
  }
  if (!config.openrouterKey) throw new Error('Не подключён ключ OpenRouter: впиши OPENROUTER_API_KEY в файл .env и перезапусти офис');
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: `Bearer ${config.openrouterKey}`, 'HTTP-Referer': config.publicUrl, 'X-Title': 'Algo Office' },
    // та же модель, но у самого дешёвого провайдера; если он недоступен, OpenRouter возьмёт следующий по цене
    extra: { provider: { sort: 'price' } },
  };
}

const hasImages = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

// Модель не видит картинки (например, DeepSeek) — убираем их прямо из истории задачи, чтобы не отправлять их на каждом шаге
function dropImages(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    m.content = `${text}\n[Картинки не переданы: эта модель не видит изображения. Текст с картинки можно прочитать через read_document (OCR), а что на ней нарисовано — спроси владельца.]`;
  }
}

export async function chat({ messages, tools, temperature = 0.4, maxTokens = 4000, agent }) {
  const { url, headers, extra } = target();
  if (!config.vision && hasImages(messages)) dropImages(messages);
  const body = { messages, temperature, max_tokens: maxTokens, ...extra };
  if (config.model) body.model = config.model;
  if (tools?.length) body.tools = tools;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 && hasImages(messages)) { dropImages(messages); continue; }
      if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
      if (data.usage) recordUsage(data.usage, agent);
      return Object.assign(data.choices[0].message, { _usage: data.usage });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}
