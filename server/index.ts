import 'dotenv/config';
import express from 'express';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AstraHttpError, fetchAstraTraffic } from './astra.ts';
import type { TrafficResponse } from './types.ts';

const app = express();
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST?.trim() || '0.0.0.0';
const configuredOrigins = process.env.CORS_ALLOWED_ORIGINS?.trim() || '*';
const allowedOrigins = configuredOrigins === '*'
  ? '*'
  : new Set(configuredOrigins.split(',').map((origin) => origin.trim()).filter(Boolean));
const configuredCacheSeconds = Number(process.env.ASTRA_CACHE_TTL_SECONDS);
const cacheTtlMs = Math.max(
  30,
  Number.isFinite(configuredCacheSeconds) ? configuredCacheSeconds : 180,
) * 1000;
let cache: { data: TrafficResponse; fetchedAt: number } | null = null;
let inFlight: Promise<TrafficResponse> | null = null;
let lastAttempt: { credentialId: string; attemptedAt: number } | null = null;

app.disable('x-powered-by');

app.use((request, response, next) => {
  const origin = request.get('Origin');
  const originAllowed = allowedOrigins === '*' || (origin ? allowedOrigins.has(origin) : false);

  if (origin && originAllowed) {
    response.set('Access-Control-Allow-Origin', allowedOrigins === '*' ? '*' : origin);
    response.set('Vary', 'Origin');
  }

  if (request.method === 'OPTIONS') {
    if (origin && !originAllowed) {
      response.sendStatus(403);
      return;
    }
    response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.set('Access-Control-Allow-Headers', 'Content-Type, X-OpenTransportData-Api-Key');
    response.set('Access-Control-Max-Age', '86400');
    response.sendStatus(204);
    return;
  }

  next();
});

app.get('/api/config', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ hasServerApiKey: Boolean(process.env.opentransportdata_api_key?.trim()) });
});

app.get('/api/traffic', async (request, response) => {
  const serverApiKey = process.env.opentransportdata_api_key?.trim();
  const browserApiKey = request.get('X-OpenTransportData-Api-Key')?.trim();
  const apiKey = serverApiKey || browserApiKey;
  if (!apiKey) {
    response.status(428).json({
      error: 'Enter an Open Transport Data API key to load live traffic.',
      code: 'api_key_required',
      ...(cache ? { staleData: cache.data } : {}),
    });
    return;
  }

  if (cache && Date.now() - cache.fetchedAt < cacheTtlMs) {
    response.set('Cache-Control', 'public, max-age=30');
    response.json(cache.data);
    return;
  }

  try {
    if (!inFlight) {
      const credentialId = createHash('sha256').update(apiKey).digest('hex');
      const retryWaitMs = lastAttempt && lastAttempt.credentialId === credentialId
        ? cacheTtlMs - (Date.now() - lastAttempt.attemptedAt)
        : 0;

      if (retryWaitMs > 0) {
        response.set('Retry-After', String(Math.ceil(retryWaitMs / 1000)));
        response.status(429).json({
          error: 'Live traffic was checked recently. Showing the last available result.',
          ...(cache ? { staleData: cache.data } : {}),
        });
        return;
      }

      lastAttempt = { credentialId, attemptedAt: Date.now() };
      inFlight = fetchAstraTraffic(apiKey).finally(() => {
        inFlight = null;
      });
    }
    const data = await inFlight;
    cache = { data, fetchedAt: Date.now() };
    response.set('Cache-Control', 'public, max-age=30');
    response.json(data);
  } catch (error) {
    console.error('[traffic]', error instanceof Error ? error.message : error);
    const invalidBrowserKey = !serverApiKey && error instanceof AstraHttpError && [401, 403].includes(error.status);
    response.status(invalidBrowserKey ? 401 : 502).json({
      error: invalidBrowserKey
        ? 'The API key was rejected. Check it and try again.'
        : 'Live traffic data is temporarily unavailable.',
      ...(invalidBrowserKey ? { code: 'invalid_api_key' } : {}),
      ...(cache ? { staleData: cache.data } : {}),
    });
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(currentDir, '../dist');
app.use(express.static(distDir));
app.get('*path', (_request, response) => response.sendFile(path.join(distDir, 'index.html')));

app.listen(port, host, () => {
  console.log(`Gotthard traffic server listening on http://${host}:${port}`);
});
