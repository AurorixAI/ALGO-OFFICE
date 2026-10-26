import './sandbox.js'; // первым: права на /data и изоляция кода агентов
import { startServer } from './server.js';

startServer();

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
