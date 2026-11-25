import * as usb from '../usb.js';
import { config } from '../config.js';

export default async function usbApi(app) {
  // Drives, the copy queue, and (with ?drive=) which games are on that drive already.
  app.get('/usb', async (req) => {
    const drives = await usb.listDrives();
    const drive = req.query.drive ? String(req.query.drive) : null;
    return {
      root: config.usbRoot,
      mapped: usb.usbRootMapped(),
      drives,
      jobs: usb.status(),
      present: drive ? await usb.presentOn(drive) : []
    };
  });

  app.post('/usb/copy', async (req, reply) => {
    const drive = String(req.body?.drive || '');
    const ids = Array.isArray(req.body?.gameIds) ? req.body.gameIds.map(Number).filter(Boolean).slice(0, 2000) : [];
    if (!drive || !ids.length) return reply.code(400).send({ error: 'drive and gameIds are required' });
    try {
      return await usb.copyGames(drive, ids);
    } catch (err) {
      return reply.code(409).send({ error: err.message });
    }
  });

  app.post('/usb/jobs/:id/cancel', async (req, reply) => {
    if (!usb.cancel(req.params.id)) return reply.code(404).send({ error: 'Nothing to cancel' });
    return { ok: true };
  });

  app.delete('/usb/jobs/:id', async (req, reply) => {
    if (!usb.remove(req.params.id)) return reply.code(400).send({ error: 'Only finished copies can be removed' });
    return { ok: true };
  });

  app.post('/usb/jobs/clear', async () => ({ removed: usb.clearFinished() }));
}
