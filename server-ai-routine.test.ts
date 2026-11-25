import test from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingLevel } from '@google/genai';
import {
  AI_MODEL_ATTEMPTS,
  validateAiRoutineInput,
  selectCandidateExercises,
  sanitizeAiRoutineResponse,
} from './server-ai-routine.ts';
import { exerciseEnvironment } from './frontend/src/lib/home-filter.js';

test('AI_MODEL_ATTEMPTS uses only supported ThinkingLevel values for each Gemini model', () => {
  assert.ok(AI_MODEL_ATTEMPTS.length >= 2);
  for (const attempt of AI_MODEL_ATTEMPTS) {
    if (attempt.model === 'gemini-4-hydrogen') {
      assert.notEqual(
        attempt.thinkingLevel,
        ThinkingLevel.MINIMAL,
        'gemini-4-hydrogen rejects ThinkingLevel.MINIMAL with 400 INVALID_ARGUMENT',
      );
    }
  }
});

test('validateAiRoutineInput requires valid weight and height and computes BMI', () => {
  const missing = validateAiRoutineInput({ heightCm: 175, lang: 'es' });
  assert.equal(missing.ok, false);

  const badHeight = validateAiRoutineInput({ weightKg: 70, heightCm: 50, lang: 'es' });
  assert.equal(badHeight.ok, false);

  const ok = validateAiRoutineInput({
    weightKg: 75,
    heightCm: 175,
    age: 32,
    bodyType: 'mesomorph',
    envs: ['none', 'home'],
    goal: 'hypertrophy',
    focus: 'full_body',
    minutes: 40,
    conditions: ['knees', 'cardiac'],
    conditionNotes: 'Molestia leve en rodilla derecha',
    lang: 'es',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.bmi, 24.5);
    assert.deepEqual(ok.data.envs, ['none', 'home']);
    assert.deepEqual(ok.data.conditions, ['knees', 'cardiac']);
  }
});

test('selectCandidateExercises strictly enforces envs and excludes contraindicated movements', () => {
  const parsed = validateAiRoutineInput({
    weightKg: 82,
    heightCm: 172,
    age: 45,
    bodyType: 'endomorph',
    envs: ['none'],
    goal: 'general',
    focus: 'full_body',
    minutes: 40,
    conditions: ['cardiac', 'knees'],
    lang: 'es',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const candidates = selectCandidateExercises(parsed.data);
  assert.ok(candidates.length >= 20, `expected at least 20 safe candidates, got ${candidates.length}`);
  for (const ex of candidates) {
    assert.equal(exerciseEnvironment(ex), 'none', `gym/home exercise leaked: ${ex.n} (${ex.id})`);
    assert.doesNotMatch(ex.n, /\b(burpee|jump|plyo|sprint|sissy squat)\b/i, `unsafe exercise leaked: ${ex.n}`);
  }
});

test('sanitizeAiRoutineResponse strips hallucinated IDs, normalizes zero-padded IDs, and clamps sets/reps/rest', () => {
  const parsed = validateAiRoutineInput({
    weightKg: 70,
    heightCm: 175,
    envs: ['none'],
    lang: 'es',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const candidates = selectCandidateExercises(parsed.data);
  const allowedById = new Map(candidates.map((c) => [c.id, c]));
  const firstId = candidates[0].id;
  const secondId = candidates[1].id;
  const unpaddedFirst = firstId.replace(/^0+/, '') || firstId;

  const result = sanitizeAiRoutineResponse(
    {
      name: 'Rutina Segura en Casa',
      summary: 'Adaptada a tu complexión.',
      safetyNotes: 'Mantén respiración controlada.',
      adaptationAdvice: 'Sin impacto en rodillas.',
      exercises: [
        { id: 'HALLUCINATED_9999', sets: 3, reps: 10, mode: 'reps', restSec: 60, rationale: 'Fake' },
        { id: unpaddedFirst, sets: 99, reps: 100, mode: 'reps', restSec: 999, rationale: 'Buen control' },
        { id: `${firstId} | Extra Name`, sets: 3, reps: 10, mode: 'reps', restSec: 60, rationale: 'Duplicate' },
        { id: `${secondId} | ${candidates[1].n}`, sets: 3, sec: 45, mode: 'time', restSec: 45, rationale: 'Estabilidad core' },
      ],
    },
    allowedById,
    parsed.data,
  );

  assert.ok(result, 'expected valid sanitized result');
  assert.equal(result.exercises.length, 2);
  assert.equal(result.exercises[0].id, firstId);
  assert.equal(result.exercises[0].sets, 6);
  assert.equal(result.exercises[0].reps, 30);
  assert.equal(result.exercises[0].restSec, 180);
  assert.equal(result.exercises[1].id, secondId);
  assert.equal(result.exercises[1].mode, 'time');
  assert.equal(result.exercises[1].sec, 45);
});

test('selectCandidateExercises respects gender, level, and intensity preferences', () => {
  const parsed = validateAiRoutineInput({
    weightKg: 60,
    heightCm: 165,
    gender: 'female',
    level: 'beginner',
    intensity: 'low',
    envs: ['none'],
    focus: 'lower',
    lang: 'es',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.gender, 'female');
  assert.equal(parsed.data.level, 'beginner');
  assert.equal(parsed.data.intensity, 'low');

  const candidates = selectCandidateExercises(parsed.data);
  assert.ok(candidates.length >= 10);
  for (const ex of candidates) {
    assert.equal(exerciseEnvironment(ex), 'none');
    assert.doesNotMatch(ex.n, /\(male\)/i);
  }
});

