/**
 * Test-only helper: bring the relay up on an ephemeral port, expose `mint`
 * (POST /sessions) and `stop`. Kept out of the test file so the test stays
 * focused on assertions.
 */
import type { AddressInfo } from 'node:net';
import { relayHttpServer } from './server.js';

export interface TestServer {
  port: number;
  base: string;
  mint: () => Promise<{ sessionId: string; joinCode: string; hostToken: string }>;
  stop: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  await new Promise<void>((resolve) => relayHttpServer.listen(0, '127.0.0.1', resolve));
  const { port } = relayHttpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    mint: async () => {
      const res = await fetch(`${base}/sessions`, { method: 'POST' });
      return res.json() as Promise<{ sessionId: string; joinCode: string; hostToken: string }>;
    },
    stop: () => new Promise<void>((resolve) => relayHttpServer.close(() => resolve())),
  };
}
