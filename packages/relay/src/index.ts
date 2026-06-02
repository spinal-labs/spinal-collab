import { parseArgs } from 'node:util';
import { start } from './server.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: process.env.PORT ?? '8787' },
    host: { type: 'string', default: '0.0.0.0' },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`invalid port: ${values.port}`);
  process.exit(1);
}

start(port, values.host);
