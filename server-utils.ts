export interface MediaRequestSpec {
  dir: 'still' | 'clip';
  fileName: string;
  contentType: 'image/webp' | 'video/mp4';
  upstreamUrl: string;
}

export interface ApiRuntimeEnv {
  origin: string;
  rpId: string;
  sameSite: 'lax' | 'none' | 'strict';
}

const DEFAULT_MEDIA_BASE = 'https://raw.githubusercontent.com/DuarteSantos8/openGym/main/catalogue/media';
const MEDIA_NAME_RE = /^\d{4,5}\.(webp|mp4)$/;

export function parseExerciseMediaPath(
  urlPath: string,
  mediaBase: string = DEFAULT_MEDIA_BASE,
): MediaRequestSpec | null {
  const cleanPath = urlPath.split('?')[0];
  let dir: 'still' | 'clip';
  let expectedExt: '.webp' | '.mp4';
  let contentType: 'image/webp' | 'video/mp4';
  let rawName: string;

  if (cleanPath.startsWith('/exercise-media/still/')) {
    dir = 'still';
    expectedExt = '.webp';
    contentType = 'image/webp';
    rawName = cleanPath.slice('/exercise-media/still/'.length);
  } else if (cleanPath.startsWith('/exercise-media/clip/')) {
    dir = 'clip';
    expectedExt = '.mp4';
    contentType = 'video/mp4';
    rawName = cleanPath.slice('/exercise-media/clip/'.length);
  } else {
    return null;
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    return null;
  }

  if (!MEDIA_NAME_RE.test(fileName) || !fileName.endsWith(expectedExt)) {
    return null;
  }

  const normalizedBase = mediaBase.replace(/\/+$/, '');
  return {
    dir,
    fileName,
    contentType,
    upstreamUrl: `${normalizedBase}/${dir}/${fileName}`,
  };
}

export function resolveApiRuntimeEnv(env: Record<string, string | undefined>): ApiRuntimeEnv {
  const candidateOrigin = (env.ORIGIN || env.APP_URL || '').trim();
  let origin = 'http://localhost:3000';
  if (candidateOrigin) {
    try {
      const parsed = new URL(candidateOrigin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        origin = parsed.origin;
      }
    } catch {
      // Fall back to default localhost origin if env value is invalid or placeholder
    }
  }

  let rpId = (env.RP_ID || '').trim();
  if (!rpId) {
    try {
      rpId = new URL(origin).hostname;
    } catch {
      rpId = 'localhost';
    }
  }

  const explicitSameSite = (env.SESSION_SAMESITE || '').trim().toLowerCase();
  let sameSite: 'lax' | 'none' | 'strict';
  if (explicitSameSite === 'strict') {
    sameSite = 'strict';
  } else if (explicitSameSite === 'none' && origin.startsWith('https://')) {
    sameSite = 'none';
  } else if (explicitSameSite === 'lax') {
    sameSite = 'lax';
  } else {
    sameSite = origin.startsWith('https://') ? 'none' : 'lax';
  }

  return { origin, rpId, sameSite };
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export function filterProxyHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    result[key] = value;
  }
  return result;
}
