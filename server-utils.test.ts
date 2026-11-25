import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExerciseMediaPath,
  resolveApiRuntimeEnv,
  filterProxyHeaders,
} from './server-utils';

test('parseExerciseMediaPath accepts valid still and clip paths', () => {
  const still = parseExerciseMediaPath('/exercise-media/still/0025.webp?v=1');
  assert.deepEqual(still, {
    dir: 'still',
    fileName: '0025.webp',
    contentType: 'image/webp',
    upstreamUrl:
      'https://raw.githubusercontent.com/DuarteSantos8/openGym/main/catalogue/media/still/0025.webp',
  });

  const clip = parseExerciseMediaPath('/exercise-media/clip/12345.mp4');
  assert.deepEqual(clip, {
    dir: 'clip',
    fileName: '12345.mp4',
    contentType: 'video/mp4',
    upstreamUrl:
      'https://raw.githubusercontent.com/DuarteSantos8/openGym/main/catalogue/media/clip/12345.mp4',
  });
});

test('parseExerciseMediaPath rejects traversal, wrong extensions, and unknown prefixes', () => {
  assert.equal(parseExerciseMediaPath('/exercise-media/still/../0025.webp'), null);
  assert.equal(parseExerciseMediaPath('/exercise-media/still/0025.mp4'), null);
  assert.equal(parseExerciseMediaPath('/exercise-media/clip/0025.webp'), null);
  assert.equal(parseExerciseMediaPath('/exercise-media/other/0025.webp'), null);
  assert.equal(parseExerciseMediaPath('/exercise-media/still/%2e%2e/secret.webp'), null);
  assert.equal(parseExerciseMediaPath('/api/health'), null);
});

test('resolveApiRuntimeEnv derives origin, rpId, and SameSite cleanly', () => {
  assert.deepEqual(resolveApiRuntimeEnv({}), {
    origin: 'http://localhost:3000',
    rpId: 'localhost',
    sameSite: 'lax',
  });

  assert.deepEqual(
    resolveApiRuntimeEnv({ APP_URL: 'https://ais-dev-example.us-east1.run.app/path' }),
    {
      origin: 'https://ais-dev-example.us-east1.run.app',
      rpId: 'ais-dev-example.us-east1.run.app',
      sameSite: 'none',
    },
  );

  assert.deepEqual(
    resolveApiRuntimeEnv({ APP_URL: 'MY_APP_URL' }),
    {
      origin: 'http://localhost:3000',
      rpId: 'localhost',
      sameSite: 'lax',
    },
  );
});

test('filterProxyHeaders strips hop-by-hop headers while keeping cookies and auth', () => {
  const filtered = filterProxyHeaders({
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    cookie: 'gym_sid=abc',
    authorization: 'Bearer xyz',
    'content-type': 'application/json',
  });

  assert.deepEqual(filtered, {
    cookie: 'gym_sid=abc',
    authorization: 'Bearer xyz',
    'content-type': 'application/json',
  });
});
