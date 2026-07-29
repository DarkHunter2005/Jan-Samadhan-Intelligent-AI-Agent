import { createApp } from './app.js';
import { config } from './config.js';
import { runEscalationSweep } from './services/routing.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[backend] listening on http://localhost:${config.port} (${config.env})`);
  console.log(`[backend] ML service: ${config.ml.baseUrl}`);
});

// Background SLA sweeper: escalates overdue complaints up the authority ladder.
let timer = null;
if (config.escalationIntervalMs > 0) {
  timer = setInterval(() => {
    try {
      const escalated = runEscalationSweep();
      if (escalated.length) {
        console.log(`[escalation] escalated ${escalated.length} overdue complaint(s)`);
      }
    } catch (err) {
      console.error('[escalation] sweep failed:', err.message);
    }
  }, config.escalationIntervalMs);
  timer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[backend] ${signal} received, shutting down`);
    if (timer) clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
