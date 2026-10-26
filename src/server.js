// HTTP + WebSocket для игрового офиса. Это единственный интерфейс: чат, задания, файлы, доступы, память.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { store } from './store.js';
import { bus, log, recentLogs } from './bus.js';
import * as memdb from './memdb.js';
import { AGENT_LIST, DEPARTMENTS } from './agents/registry.js';
import { agentState, createTask, runTask, cancelTask, pauseTask, resumeTask, talkToArslan } from './agents/runtime.js';
import { wsPath } from './tools/files.js';
import { usageReport, watchBalance } from './billing.js';
import { setSecret, deleteSecret, secretNames } from './secrets.js';

const SESSION = crypto.createHash('sha256').update('algo:' + config.adminPassword).digest('hex');
const authed = (token) => typeof token === 'string' && token.length === SESSION.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(SESSION));

const PANEL_CHAT = 'panel'; // память диалога веб-чата
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

const publicTask = (t) => ({ ...t, steps: t.steps.slice(-40) });

function snapshot() {
  return {
    departments: DEPARTMENTS,
    agents: AGENT_LIST.map(({ prompt, tools, ...a }) => ({ ...a, tools, state: agentState[a.id] })),
    tasks: store.tasks.slice(-60).map(publicTask),
    logs: recentLogs(),
    stats: store.stats,
    model: config.model,
  };
}

// Прикреплённые файлы: текст для модели + картинки, которые модель увидит сама
async function withFiles(text, files) {
  const list = (Array.isArray(files) ? files : []).map(String).filter(Boolean).slice(0, 10);
  for (const f of list) await fs.access(wsPath(f));
  if (!list.length) return { text };
  const full = `${text || 'Посмотри, что в файлах, и скажи, что с ними сделать.'}\n\n[Владелец прикрепил файлы: ${list.join(', ')}]`;
  const images = list.filter((f) => IMAGE.test(f)).slice(0, 4);
  if (!images.length) return { text: full, files: list };
  const parts = [{ type: 'text', text: full }];
  for (const f of images) {
    const b64 = (await fs.readFile(wsPath(f))).toString('base64');
    parts.push({ type: 'image_url', image_url: { url: `data:${MIME[f.split('.').pop().toLowerCase()]};base64,${b64}` } });
  }
  return { text: full, files: list, content: parts };
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // no-cache: браузер каждый раз сверяется с сервером, и обновления интерфейса видны сразу
  app.use(express.static(path.resolve('public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

  app.get('/health', (_, res) => res.send('ok'));

  app.post('/api/login', (req, res) => {
    if (req.body?.password === config.adminPassword) return res.json({ token: SESSION });
    res.status(401).json({ error: 'Неверный пароль' });
  });

  // Канал с Саней: отдельный токен, админская сессия ему не нужна.
  const linkAuthed = (req) => {
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    const want = Buffer.from(config.linkToken);
    return !!config.linkToken && got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  // Саня передаёт доступы (например, логин/пароль e-class при /eclass_login). Значения в LLM не попадают:
  // агенты вводят их в формы через browser_fill_secret по имени.
  app.post('/link/secrets', (req, res) => {
    if (!linkAuthed(req)) return res.status(401).json({ error: 'auth' });
    const secrets = req.body?.secrets || {};
    const names = Object.keys(secrets).filter((k) => /^[a-z0-9_]{1,40}$/.test(k) && typeof secrets[k] === 'string' && secrets[k]);
    if (!names.length) return res.status(400).json({ error: 'нет секретов' });
    for (const k of names) setSecret(k, secrets[k]);
    const from = String(req.body?.from || 'Саня').slice(0, 40);
    log('arslan', `🔐 ${from} передал доступ: ${names.join(', ')}. Гермес сможет заходить на сайт сам.`, 'alert');
    res.json({ ok: true, saved: names });
  });

  // Саня присылает задания Арслану — они видны в чате офиса как обычные задачи
  app.post('/link/ask', async (req, res) => {
    if (!linkAuthed(req)) return res.status(401).json({ error: 'auth' });
    const text = String(req.body?.text || '').trim();
    const from = String(req.body?.from || 'Саня').slice(0, 40);
    if (!text) return res.status(400).json({ error: 'Пустое задание' });
    const job = talkToArslan('sanya', { text: `[${from}]: ${text}`, source: 'sanya' }, { fromSanya: true });
    // держим запрос до 50 с; дольше — Арслан доделает, а результат будет в чате офиса
    const late = Symbol('late');
    try {
      const r = await Promise.race([job, new Promise((ok) => setTimeout(() => ok(late), 50_000))]);
      if (r !== late) return res.json({ reply: r.result });
      res.json({ pending: true });
      job.catch(() => {});
    } catch (e) {
      res.status(503).json({ error: e.message });
    }
  });

  // токен — в заголовке, а для ссылок на файлы (<img>, <video>, скачивание) — в ?t=
  app.use('/api', (req, res, next) => (authed(req.headers['x-token'] || req.query.t) ? next() : res.status(401).json({ error: 'auth' })));

  app.get('/api/state', (_, res) => res.json(snapshot()));

  app.post('/api/tasks', async (req, res) => {
    const { text = '', agent = 'arslan', files } = req.body || {};
    if (!String(text).trim() && !files?.length) return res.status(400).json({ error: 'Пустое задание' });
    if (!AGENT_LIST.some((a) => a.id === agent)) return res.status(400).json({ error: 'Нет такого агента' });
    let input;
    try { input = await withFiles(String(text).trim(), files); } catch (e) { return res.status(400).json({ error: 'Файл не найден: ' + e.message }); }
    // Арслану — с памятью диалога офиса, сотрудникам — напрямую
    if (agent === 'arslan') {
      let created;
      talkToArslan(PANEL_CHAT, { text: input.text, content: input.content, source: 'panel', onTask: (t) => { t.files = input.files; created = t; } }).catch(() => {});
      return res.json({ task: publicTask(created) });
    }
    const task = createTask({ text: input.text, agent, source: 'panel' });
    task.files = input.files;
    runTask(task, {}, { input: input.content }).catch(() => {});
    res.json({ task: publicTask(task) });
  });

  // Загрузка файла из чата: тело запроса — сам файл, имя — в заголовке x-filename
  app.post('/api/upload', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
    const raw = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
    const name = path.basename(raw).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').slice(-120) || 'file';
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Пустой файл' });
    let rel = path.join('inbox', name);
    try { await fs.access(wsPath(rel)); rel = path.join('inbox', `${Date.now().toString(36)}_${name}`); } catch {}
    await fs.mkdir(path.dirname(wsPath(rel)), { recursive: true });
    await fs.writeFile(wsPath(rel), req.body);
    res.json({ path: rel, name: path.basename(rel), size: req.body.length });
  });

  // Файлы рабочей папки: показать в чате или скачать (?download=1)
  app.get('/api/files', async (req, res) => {
    try {
      const full = wsPath(String(req.query.path || ''));
      if (!(await fs.stat(full)).isFile()) throw new Error('Это не файл');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
      if (req.query.download) return res.download(full, path.basename(full), { dotfiles: 'allow' });
      res.sendFile(full, { dotfiles: 'allow' });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // Доступы (логины/пароли для сайтов): значения сюда только приходят, обратно не отдаются
  app.get('/api/secrets', (_, res) => res.json({ names: secretNames() }));
  app.post('/api/secrets', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const value = String(req.body?.value ?? '');
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(name)) return res.status(400).json({ error: 'Имя — латиница, цифры и _, до 40 символов' });
    if (!value) return res.status(400).json({ error: 'Пустое значение' });
    setSecret(name, value);
    res.json({ ok: true, names: secretNames() });
  });
  app.post('/api/secrets/:name/delete', (req, res) => {
    deleteSecret(req.params.name);
    res.json({ ok: true, names: secretNames() });
  });

  // Долгая память Арслана и сброс текущего диалога
  app.get('/api/memory', (_, res) => res.json({ facts: memdb.listFacts(200) }));
  app.post('/api/memory/:id/delete', (req, res) => res.json({ ok: memdb.deleteFact(Number(req.params.id)) }));
  app.post('/api/memory/clear', (_, res) => { memdb.clearFacts(); res.json({ ok: true }); });
  app.post('/api/chat/reset', (_, res) => { memdb.resetChat(PANEL_CHAT); res.json({ ok: true }); });

  app.get('/api/usage', async (_, res) => res.json(await usageReport()));

  app.post('/api/tasks/:id/cancel', (req, res) => res.json({ ok: cancelTask(req.params.id) }));
  app.post('/api/tasks/:id/pause', (req, res) => res.json({ ok: pauseTask(req.params.id) }));
  app.post('/api/tasks/:id/resume', (req, res) => res.json({ ok: resumeTask(req.params.id) }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    if (!authed(token)) return ws.close(4001, 'auth');
    ws.send(JSON.stringify({ type: 'init', ...snapshot() }));
  });
  bus.on('event', (e) => {
    const msg = JSON.stringify(e.type === 'task' ? { ...e, task: publicTask(e.task) } : e);
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  });

  watchBalance(async (text) => log('arslan', text, 'alert'));

  server.listen(config.port, () => console.log(`[office] http://localhost:${config.port}`));
}
