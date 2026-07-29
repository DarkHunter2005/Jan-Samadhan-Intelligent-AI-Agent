import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 4000),
  env: process.env.NODE_ENV || 'development',

  // JWT. In production this MUST come from the environment.
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  jwtExpiry: process.env.JWT_EXPIRY || '12h',

  // SQLite keeps the whole stack runnable with zero external services.
  // The repository layer (src/db/index.js) is the only place that touches SQL,
  // so swapping in Postgres/Mongo means reimplementing that one module.
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'grievance.db'),

  ml: {
    baseUrl: process.env.ML_URL || 'http://127.0.0.1:8000',
    timeoutMs: Number(process.env.ML_TIMEOUT_MS || 6000),
    retries: Number(process.env.ML_RETRIES || 2),
    // How many recent open complaints in the same locality get sent to the ML
    // service as duplicate candidates.
    duplicateCandidateLimit: Number(process.env.DUP_CANDIDATES || 40),
  },

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),

  // Escalation sweeper interval (ms). 0 disables the background job (used in tests).
  escalationIntervalMs: Number(process.env.ESCALATION_INTERVAL_MS || 60_000),

  // Rate limits. Submission is deliberately tight in production to deter spam;
  // raise SUBMIT_RATE_LIMIT when running the end-to-end suite or load tests.
  rateLimit: {
    submitPerWindow: Number(process.env.SUBMIT_RATE_LIMIT || 20),
    readPerWindow: Number(process.env.READ_RATE_LIMIT || 300),
    authPerWindow: Number(process.env.AUTH_RATE_LIMIT || 50),
    windowMs: Number(process.env.RATE_WINDOW_MS || 15 * 60 * 1000),
  },
};

if (config.env === 'production' && config.jwtSecret.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
