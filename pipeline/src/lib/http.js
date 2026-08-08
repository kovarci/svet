import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = path.resolve(fileURLToPath(new URL('../../cache', import.meta.url)));

/** Requête HTTP GET avec cache disque : on ne retélécharge jamais deux fois la même chose. */
export async function getJSON(url, params = {}, { cacheKey, label } = {}) {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = qs ? `${url}?${qs}` : url;
  const key = cacheKey ?? createHash('sha1').update(fullUrl).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    // pas en cache : on télécharge
  }

  const res = await fetchWithRetry(fullUrl, label);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Réponse non-JSON de ${label ?? fullUrl} : ${text.slice(0, 200)}`);
  }
  if (data?.error) {
    throw new Error(`Erreur API ${label ?? fullUrl} : ${JSON.stringify(data.error).slice(0, 300)}`);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(data));
  return data;
}

/** POST de formulaire (Overpass n'accepte que ça pour les requêtes longues). */
export async function postForm(url, body, { cacheKey, label } = {}) {
  const key = cacheKey ?? createHash('sha1').update(url + JSON.stringify(body)).digest('hex').slice(0, 16);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    // pas en cache
  }

  const res = await fetchWithRetry(url, label, {
    method: 'POST',
    body: new URLSearchParams(body),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Réponse non-JSON de ${label ?? url} : ${text.slice(0, 300)}`);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(data));
  return data;
}

async function fetchWithRetry(url, label, init = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': 'svet/0.1 (carte lumière Paris)', ...(init.headers ?? {}) },
      });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} sur ${label ?? url}`);
    } catch (err) {
      lastError = err;
    }
    const wait = 1500 * attempt;
    process.stdout.write(`  ↻ nouvel essai (${attempt}/${attempts}) dans ${wait / 1000}s…\n`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastError;
}

export { CACHE_DIR };
