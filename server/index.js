import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { db } from './db.js';
import { runScan, scheduleScans, syncEnvLibraries } from './jobs.js';
import { badgesDir, defaultBadgesDir, mediaRoot } from './media.js';
import api from './routes/api.js';
import convertApi from './routes/convert.js';
import { startConversionService, stopConversionService } from './convert/service.js';

const app = Fastify({ logger: { level: process.env.GV_LOG_LEVEL || 'info' } });

fs.mkdirSync(mediaRoot, { recursive: true });
fs.mkdirSync(badgesDir, { recursive: true });

// Lets the future PS5 app (and other tools on your network) call the API.
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  reply.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  reply.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return reply.code(204).send();
});

await app.register(api, { prefix: '/api/v1' });
await app.register(convertApi, { prefix: '/api/v1' });

await app.register(fastifyStatic, {
  root: mediaRoot,
  prefix: '/media/',
  decorateReply: false,
  maxAge: '30d'
});

await app.register(fastifyStatic, {
  root: defaultBadgesDir,
  prefix: '/badges/default/',
  decorateReply: false,
  maxAge: '7d'
});

await app.register(fastifyStatic, {
  root: badgesDir,
  prefix: '/badges/',
  decorateReply: false,
  maxAge: '1d'
});

const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'));
if (hasWeb) {
  await app.register(fastifyStatic, { root: config.webDir, prefix: '/', wildcard: false });
}

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/media/') || req.url.startsWith('/badges/') || !hasWeb) {
    return reply.code(404).send({ error: 'Not found' });
  }
  return reply.sendFile('index.html', config.webDir);
});

const librariesMoved = syncEnvLibraries();
scheduleScans();

await app.listen({ port: config.port, host: config.host });

// First run with an empty catalogue: scan straight away.
const count = db.prepare('SELECT COUNT(*) AS n FROM games').get().n;
if ((count === 0 || librariesMoved) && db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n > 0) runScan();
startConversionService();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await stopConversionService();
    await app.close();
    db.close();
    process.exit(0);
  });
}
