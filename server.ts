import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import {
  filterProxyHeaders,
  parseExerciseMediaPath,
  resolveApiRuntimeEnv,
} from './server-utils';
import { handleAiRoutineRequest } from './server-ai-routine';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, 'frontend');
const FRONTEND_DIST = path.resolve(FRONTEND_DIR, 'dist');
const API_DIR = path.resolve(__dirname, 'api');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), 'opengym-data'));
const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'opengym-media-cache');
const VITE_CACHE_DIR = path.join(os.tmpdir(), 'opengym-vite-cache');
const LOCAL_MEDIA_DIR = path.resolve(__dirname, 'catalogue/media');

const PORT = Number(process.env.PORT || 3000);
const API_PORT = Number(process.env.OPENGYM_API_PORT || 3001);
const IS_PROD = process.env.NODE_ENV === 'production';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(MEDIA_CACHE_DIR, 'still'), { recursive: true });
fs.mkdirSync(path.join(MEDIA_CACHE_DIR, 'clip'), { recursive: true });

let apiChild: ChildProcess | null = null;
let apiReadyPromise: Promise<void> | null = null;
const inflightMedia = new Map<string, Promise<string | null>>();

function startApiProcess(): ChildProcess {
  const runtime = resolveApiRuntimeEnv(process.env);
  const child = spawn(process.execPath, [path.join(API_DIR, 'server.js')], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DATA_DIR,
      ORIGIN: runtime.origin,
      RP_ID: runtime.rpId,
      RP_NAME: process.env.RP_NAME || 'openGym',
      ALLOW_GUEST: process.env.ALLOW_GUEST || 'on',
      PASSWORD_LOGIN: process.env.PASSWORD_LOGIN || 'on',
      FIRST_USER_ADMIN: process.env.FIRST_USER_ADMIN || '1',
      TRUST_PROXY: process.env.TRUST_PROXY || '1',
      SESSION_SAMESITE: runtime.sameSite,
    },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[api] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[api] ${chunk.toString()}`);
  });
  child.on('exit', (code, signal) => {
    if (apiChild === child) {
      apiChild = null;
      apiReadyPromise = null;
    }
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`[api] exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  return child;
}

function waitForApiReady(timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(
        { hostname: '127.0.0.1', port: API_PORT, path: '/api/health', timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve();
          } else {
            retry();
          }
        },
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('openGym API failed to become ready in time'));
        return;
      }
      setTimeout(probe, 150);
    };

    probe();
  });
}

function ensureApiRunning(): Promise<void> {
  if (!apiChild) {
    apiChild = startApiProcess();
    apiReadyPromise = waitForApiReady();
  }
  return apiReadyPromise || Promise.resolve();
}

function proxyToApi(req: Request, res: Response): void {
  ensureApiRunning()
    .then(() => {
      const headers = filterProxyHeaders(req.headers);
      headers.host = `127.0.0.1:${API_PORT}`;
      if (!headers['x-forwarded-for'] && req.socket.remoteAddress) {
        headers['x-forwarded-for'] = req.socket.remoteAddress;
      }

      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: API_PORT,
          method: req.method,
          path: req.originalUrl,
          headers,
        },
        (upstreamRes) => {
          const responseHeaders = filterProxyHeaders(upstreamRes.headers);
          res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
          upstreamRes.pipe(res);
        },
      );

      upstream.on('error', (err) => {
        console.error('[proxy] upstream error:', err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: 'API unavailable' });
        }
      });

      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream);
    })
    .catch((err) => {
      console.error('[proxy] API startup failed:', err);
      if (!res.headersSent) {
        res.status(503).json({ error: 'API starting up' });
      }
    });
}

async function fetchMediaToCache(cacheKey: string, cacheFile: string, upstreamUrl: string): Promise<string | null> {
  if (fs.existsSync(cacheFile)) return cacheFile;
  const existing = inflightMedia.get(cacheKey);
  if (existing) return existing;

  const job = (async () => {
    try {
      const response = await fetch(upstreamUrl);
      if (!response.ok) return null;
      const buf = Buffer.from(await response.arrayBuffer());
      const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, cacheFile);
      return cacheFile;
    } catch (err) {
      console.warn(`[media] fetch failed for ${upstreamUrl}:`, err);
      return null;
    } finally {
      inflightMedia.delete(cacheKey);
    }
  })();

  inflightMedia.set(cacheKey, job);
  return job;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');

  // Start the real openGym Node.js backend immediately
  ensureApiRunning().catch((err) => console.error('[api] initial start failed:', err));

  // Personalized AI routine generation (server-side Gemini API)
  app.post('/api/ai/routine', express.json({ limit: '512kb' }), handleAiRoutineRequest);

  // Proxy all remaining /api routes directly to api/server.js
  app.use('/api', proxyToApi);

  // Serve exercise stills (.webp) and demo clips (.mp4) with local disk cache + GitHub raw fallback
  app.get('/exercise-media/:dir/:file', async (req, res) => {
    const spec = parseExerciseMediaPath(req.originalUrl, process.env.MEDIA_BASE_URL);
    if (!spec) {
      res.status(404).end();
      return;
    }

    const localFile = path.join(LOCAL_MEDIA_DIR, spec.dir, spec.fileName);
    if (fs.existsSync(localFile)) {
      res.setHeader('Content-Type', spec.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(localFile);
      return;
    }

    const cacheFile = path.join(MEDIA_CACHE_DIR, spec.dir, spec.fileName);
    const resolved = await fetchMediaToCache(`${spec.dir}/${spec.fileName}`, cacheFile, spec.upstreamUrl);
    if (!resolved) {
      res.status(404).end();
      return;
    }

    res.setHeader('Content-Type', spec.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(resolved);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: FRONTEND_DIR,
      cacheDir: VITE_CACHE_DIR,
      configFile: path.join(FRONTEND_DIR, 'vite.config.js'),
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(FRONTEND_DIST, { index: 'index.html' }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`openGym server listening on http://0.0.0.0:${PORT} (mode=${IS_PROD ? 'production' : 'dev'})`);
  });

  const shutdown = () => {
    server.close();
    if (apiChild) {
      apiChild.kill('SIGTERM');
      apiChild = null;
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start openGym server:', err);
  process.exit(1);
});
