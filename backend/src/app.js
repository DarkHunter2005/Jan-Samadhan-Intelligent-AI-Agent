import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import complaintRoutes from './routes/complaints.js';
import adminRoutes from './routes/admin.js';
import * as mlClient from './services/mlClient.js';

export function createApp({ logging = true } = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) =>
      // Allow same-origin/curl (no Origin header) and configured frontends.
      (!origin || config.corsOrigins.includes(origin)) ? cb(null, true) : cb(new Error('CORS blocked')),
    credentials: true,
  }));
  app.use(express.json({ limit: '256kb' }));
  if (logging) app.use(morgan('dev'));

  // Submission is the abuse-prone endpoint: cap it per IP.
  const { submitPerWindow, readPerWindow, authPerWindow, windowMs } = config.rateLimit;
  app.use('/api/complaints', rateLimit({
    windowMs,
    max: (req) => (req.method === 'POST' ? submitPerWindow : readPerWindow),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests, please try again later' },
  }));
  app.use('/api/auth', rateLimit({ windowMs, max: authPerWindow, standardHeaders: true }));

  app.get('/api/health', async (req, res) => {
    res.json({ status: 'ok', env: config.env, ml: await mlClient.health() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/complaints', complaintRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((req, res) => res.status(404).json({ error: `no route for ${req.method} ${req.path}` }));

  // Central error handler: never leak stack traces to clients.
  app.use((err, req, res, _next) => {
    console.error('[error]', err.message);
    if (err.message === 'CORS blocked') return res.status(403).json({ error: 'origin not allowed' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    res.status(err.status || 500).json({
      error: config.env === 'production' ? 'internal server error' : err.message,
    });
  });

  return app;
}
