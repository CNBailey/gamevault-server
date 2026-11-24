import * as conv from '../convert/service.js';
import { applyRenames, previewRenames } from '../convert/tidy.js';

export default async function convertApi(app) {
  app.get('/conversions', async () => conv.status());

  app.put('/conversions/settings', async (req, reply) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') {
      try { await conv.setEnabled(b.enabled); } catch (err) { return reply.code(409).send({ error: err.message }); }
    }
    if (b.settleSeconds != null) conv.setSettleSeconds(b.settleSeconds);
    return conv.status();
  });

  app.post('/conversions/check', async () => {
    await conv.poll();
    return conv.status();
  });

  app.post('/conversions/:id/cancel', async (req, reply) => {
    if (!conv.cancel(Number(req.params.id))) return reply.code(404).send({ error: 'Nothing to cancel' });
    return { ok: true };
  });

  app.post('/conversions/:id/retry', async (req, reply) => {
    if (!conv.retry(Number(req.params.id))) return reply.code(400).send({ error: 'Only a failed job whose file is still in the incoming folder can be retried' });
    return { ok: true };
  });

  app.delete('/conversions/:id', async (req, reply) => {
    if (!conv.remove(Number(req.params.id))) return reply.code(400).send({ error: 'Only finished or failed jobs can be removed' });
    return { ok: true };
  });

  app.post('/conversions/clear-history', async () => ({ removed: conv.clearHistory() }));

  app.post('/conversions/empty-done', async (req, reply) => {
    if (req.body?.confirm !== true) return reply.code(400).send({ error: 'Confirmation required' });
    return { removed: await conv.emptyDoneFolder() };
  });

  // Tidy file names
  app.get('/maintenance/rename-preview', async (req, reply) => {
    const platform = String(req.query.platform || '').toUpperCase();
    if (!['PS4', 'PS5'].includes(platform)) return reply.code(400).send({ error: 'platform must be PS4 or PS5' });
    return previewRenames(platform);
  });

  app.post('/maintenance/rename', async (req, reply) => {
    const platform = String(req.body?.platform || '').toUpperCase();
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 5000) : [];
    if (!['PS4', 'PS5'].includes(platform) || !paths.length) return reply.code(400).send({ error: 'platform and paths are required' });
    return applyRenames(platform, paths);
  });
}
