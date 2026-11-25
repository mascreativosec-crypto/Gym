import type { Request, Response } from 'express';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { EXDB } from './frontend/src/lib/exercises-data.js';
import { exerciseEnvironment, matchesEnvironment, normalizeEnvFilter } from './frontend/src/lib/home-filter.js';
import { exerciseGender, exerciseIntensity, exerciseLevel } from './frontend/src/lib/exercise-classifier.js';

export type TrainingEnv = 'none' | 'home' | 'gym';

export type BodyType = 'ectomorph' | 'mesomorph' | 'endomorph' | 'athletic' | 'average' | 'unknown';

export type RoutineGoal = 'strength' | 'hypertrophy' | 'fat_loss' | 'mobility' | 'general' | 'endurance';

export type RoutineFocus = 'full_body' | 'upper' | 'lower' | 'push' | 'pull' | 'core';

export type TrainingLevel = 'beginner' | 'intermediate' | 'advanced';
export type TrainingIntensity = 'low' | 'medium' | 'high';
export type RoutineGender = 'male' | 'female' | 'all';

export type HealthCondition =
  | 'cardiac'
  | 'knees'
  | 'lower_back'
  | 'shoulders'
  | 'wrists'
  | 'neck'
  | 'ankles'
  | 'ligaments_muscle';

export interface AiRoutineInput {
  weightKg: number;
  heightCm: number;
  bmi: number;
  age: number | null;
  bodyType: BodyType;
  gender: RoutineGender;
  level: TrainingLevel;
  intensity: TrainingIntensity;
  envs: TrainingEnv[];
  goal: RoutineGoal;
  focus: RoutineFocus;
  minutes: number;
  conditions: HealthCondition[];
  conditionNotes: string;
  lang: 'es' | 'en';
}

export interface CatalogueExercise {
  id: string;
  n: string;
  bp: string;
  tg: string;
  eq: string;
  cat?: string;
  sec?: string[];
  nd?: string[];
}

export interface AiRoutineExerciseOut {
  id: string;
  sets: number;
  reps?: number;
  sec?: number;
  mode: 'reps' | 'time';
  restSec: number;
  rationale: string;
}

export interface AiRoutineResult {
  name: string;
  summary: string;
  safetyNotes: string;
  adaptationAdvice: string;
  bmi: number;
  estimatedMinutes: number;
  envs: TrainingEnv[];
  exercises: AiRoutineExerciseOut[];
}

const VALID_BODY_TYPES = new Set<BodyType>(['ectomorph', 'mesomorph', 'endomorph', 'athletic', 'average', 'unknown']);
const VALID_GOALS = new Set<RoutineGoal>(['strength', 'hypertrophy', 'fat_loss', 'mobility', 'general', 'endurance']);
const VALID_FOCUSES = new Set<RoutineFocus>(['full_body', 'upper', 'lower', 'push', 'pull', 'core']);
const VALID_CONDITIONS = new Set<HealthCondition>([
  'cardiac',
  'knees',
  'lower_back',
  'shoulders',
  'wrists',
  'neck',
  'ankles',
  'ligaments_muscle',
]);

const VALID_LEVELS = new Set<TrainingLevel>(['beginner', 'intermediate', 'advanced']);
const VALID_INTENSITIES = new Set<TrainingIntensity>(['low', 'medium', 'high']);
const VALID_GENDERS = new Set<RoutineGender>(['male', 'female', 'all']);

const NOT_WORKOUT_LIFT_RE = /form check|massage|release|breathing|test\b/i;
const STRETCH_ONLY_RE = /stretch|mobility|mobilization|\bpose\b|yoga|foam roll/i;

const CONDITION_EXCLUSIONS: Record<HealthCondition, RegExp> = {
  cardiac: /\b(burpee|jump|plyo|explosive|sprint|hiit|thruster|snatch|clean|box jump|tuck jump|star jump|mountain climber|high knees|jumping jack|handstand|headstand|inverted)\b/i,
  knees: /\b(jump|plyo|burpee|sissy squat|pistol|deep squat|lunge jump|split jump|skater|kneeling|box jump|tuck jump|squat jump|hop|leap|running|sprint)\b/i,
  lower_back: /\b(deadlift|good morning|hyperextension|back extension|sit[- ]?up|v[- ]?up|jefferson|burpee|kettlebell swing|clean|snatch|superman|dragon flag|rollout|toe touch|leg raise)\b/i,
  shoulders: /\b(handstand|pike push|military press|overhead press|shoulder press|arnold|behind the neck|upright row|\bdip\b|\bdips\b|muscle[- ]?up|pull[- ]?up|snatch|jerk|thruster|burpee)\b/i,
  wrists: /\b(push[- ]?up|handstand|plank(?!.*forearm|.*elbow)|burpee|mountain climber|bear crawl|wrist|crab|reverse plank|l[- ]?sit|planche|dip)\b/i,
  neck: /\b(neck|headstand|handstand|bridge|behind the neck|crunch|sit[- ]?up|shrug|wrestler)\b/i,
  ankles: /\b(jump|hop|plyo|skip|sprint|running|burpee|calf raise|skater|leap|lunge jump|high knees|jumping jack)\b/i,
  ligaments_muscle: /\b(plyo|jump|explosive|ballistic|kipping|snatch|clean|jerk|burpee|sprint|clap push|depth drop|max)\b/i,
};

const FOCUS_BODYPARTS: Record<RoutineFocus, Set<string>> = {
  full_body: new Set(['chest', 'back', 'shoulders', 'upper legs', 'lower legs', 'upper arms', 'waist']),
  upper: new Set(['chest', 'back', 'shoulders', 'upper arms', 'lower arms', 'waist']),
  lower: new Set(['upper legs', 'lower legs', 'waist']),
  push: new Set(['chest', 'shoulders', 'upper arms', 'waist']),
  pull: new Set(['back', 'upper arms', 'lower arms', 'waist']),
  core: new Set(['waist', 'back', 'upper legs']),
};

export function validateAiRoutineInput(body: unknown): { ok: true; data: AiRoutineInput } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const lang: 'es' | 'en' = String(b.lang || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';

  const rawWeight = Number(b.weightKg);
  const rawHeight = Number(b.heightCm);

  if (!Number.isFinite(rawWeight) || rawWeight < 25 || rawWeight > 300) {
    return {
      ok: false,
      error: lang === 'es'
        ? 'Ingresa un peso corporal válido (entre 25 y 300 kg).'
        : 'Enter a valid body weight (between 25 and 300 kg).',
    };
  }
  if (!Number.isFinite(rawHeight) || rawHeight < 100 || rawHeight > 250) {
    return {
      ok: false,
      error: lang === 'es'
        ? 'Ingresa una estatura válida (entre 100 y 250 cm).'
        : 'Enter a valid height (between 100 and 250 cm).',
    };
  }

  let age: number | null = null;
  if (b.age !== undefined && b.age !== null && String(b.age).trim() !== '') {
    const parsedAge = Number(b.age);
    if (!Number.isFinite(parsedAge) || parsedAge < 12 || parsedAge > 100) {
      return {
        ok: false,
        error: lang === 'es'
          ? 'Ingresa una edad válida (entre 12 y 100 años).'
          : 'Enter a valid age (between 12 and 100 years).',
      };
    }
    age = Math.round(parsedAge);
  }

  const bodyTypeRaw = String(b.bodyType || 'average').toLowerCase() as BodyType;
  const bodyType: BodyType = VALID_BODY_TYPES.has(bodyTypeRaw) ? bodyTypeRaw : 'average';

  const genderRaw = String(b.gender || 'all').toLowerCase() as RoutineGender;
  const gender: RoutineGender = VALID_GENDERS.has(genderRaw) ? genderRaw : 'all';

  const levelRaw = String(b.level || 'intermediate').toLowerCase() as TrainingLevel;
  const level: TrainingLevel = VALID_LEVELS.has(levelRaw) ? levelRaw : 'intermediate';

  const intensityRaw = String(b.intensity || 'medium').toLowerCase() as TrainingIntensity;
  const intensity: TrainingIntensity = VALID_INTENSITIES.has(intensityRaw) ? intensityRaw : 'medium';

  const goalRaw = String(b.goal || 'general').toLowerCase() as RoutineGoal;
  const goal: RoutineGoal = VALID_GOALS.has(goalRaw) ? goalRaw : 'general';

  const focusRaw = String(b.focus || 'full_body').toLowerCase() as RoutineFocus;
  const focus: RoutineFocus = VALID_FOCUSES.has(focusRaw) ? focusRaw : 'full_body';

  const minutesRaw = Number(b.minutes);
  const minutes = Number.isFinite(minutesRaw) ? Math.min(90, Math.max(15, Math.round(minutesRaw))) : 40;

  const rawEnvs = normalizeEnvFilter(b.envs as string | string[] | undefined) as TrainingEnv[];
  const envs: TrainingEnv[] = rawEnvs.length > 0 ? rawEnvs : ['none', 'home'];

  const conditionsRaw = Array.isArray(b.conditions) ? b.conditions : [];
  const conditions: HealthCondition[] = [];
  for (const c of conditionsRaw) {
    const key = String(c || '').toLowerCase() as HealthCondition;
    if (VALID_CONDITIONS.has(key) && !conditions.includes(key)) {
      conditions.push(key);
    }
  }

  const conditionNotes = String(b.conditionNotes || '').trim().slice(0, 500);
  const bmi = Number((rawWeight / ((rawHeight / 100) ** 2)).toFixed(1));

  return {
    ok: true,
    data: {
      weightKg: Number(rawWeight.toFixed(1)),
      heightCm: Math.round(rawHeight),
      bmi,
      age,
      bodyType,
      gender,
      level,
      intensity,
      envs,
      goal,
      focus,
      minutes,
      conditions,
      conditionNotes,
      lang,
    },
  };
}

export function selectCandidateExercises(
  input: AiRoutineInput,
  catalogue: CatalogueExercise[] = EXDB as CatalogueExercise[],
  maxCandidates = 60,
): CatalogueExercise[] {
  const targetBps = FOCUS_BODYPARTS[input.focus] || FOCUS_BODYPARTS.full_body;
  const allowMobility = input.goal === 'mobility' || input.conditions.length > 0;
  const allowedCats = new Set(['strength', 'calisthenics', 'isometric', ...(allowMobility ? ['mobility', 'rehab', 'pilates', 'stretching'] : [])]);

  const byBucket = new Map<string, CatalogueExercise[]>();

  for (const ex of catalogue) {
    if (!ex || !ex.id || !ex.n) continue;
    if (!matchesEnvironment(ex, input.envs)) continue;
    if (NOT_WORKOUT_LIFT_RE.test(ex.n)) continue;
    const exGen = exerciseGender(ex);
    if (input.gender === 'female' && exGen === 'male') continue;
    if (input.gender === 'male' && exGen === 'female') continue;
    if (ex.cat && !allowedCats.has(ex.cat)) continue;
    if (input.goal !== 'mobility' && input.conditions.length === 0 && input.intensity !== 'low' && STRETCH_ONLY_RE.test(ex.n)) continue;

    // Exclude exercises contraindicated by reported conditions
    let unsafe = false;
    for (const cond of input.conditions) {
      const re = CONDITION_EXCLUSIONS[cond];
      if (re && re.test(ex.n)) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) continue;

    const bp = String(ex.bp || '').toLowerCase();
    if (!targetBps.has(bp)) continue;

    // For push/pull focus, refine arms to triceps (push) or biceps/forearms (pull)
    const tg = String(ex.tg || '').toLowerCase();
    if (input.focus === 'push' && bp === 'upper arms' && tg !== 'triceps') continue;
    if (input.focus === 'pull' && bp === 'upper arms' && tg !== 'biceps') continue;

    const bucketKey = `${bp}:${tg || 'general'}`;
    if (!byBucket.has(bucketKey)) byBucket.set(bucketKey, []);
    byBucket.get(bucketKey)!.push(ex);
  }

  // Prefer exercises aligned with level, intensity, gender profile, and concise classic names
  for (const list of byBucket.values()) {
    list.sort((a, b) => {
      const score = (ex: CatalogueExercise) => {
        let s = ex.n.length;
        if (input.conditions.length > 0 && (ex.cat === 'rehab' || ex.cat === 'isometric' || ex.cat === 'pilates')) s -= 15;
        if (/\bv\.\s*\d|\bpov\b|one arm|single arm/i.test(ex.n)) s += 18;
        if (exerciseLevel(ex) === input.level) s -= 22;
        if (exerciseIntensity(ex) === input.intensity) s -= 16;
        if (input.gender !== 'all' && exerciseGender(ex) === input.gender) s -= 18;
        return s;
      };
      return score(a) - score(b) || (a.id < b.id ? -1 : 1);
    });
  }

  // Round-robin across buckets so Gemini gets balanced muscle coverage within maxCandidates
  const buckets = [...byBucket.values()];
  const selected: CatalogueExercise[] = [];
  const seen = new Set<string>();
  let depth = 0;

  while (selected.length < maxCandidates) {
    let addedInRound = false;
    for (const list of buckets) {
      if (depth < list.length && selected.length < maxCandidates) {
        const ex = list[depth];
        if (!seen.has(ex.id)) {
          seen.add(ex.id);
          selected.push(ex);
          addedInRound = true;
        }
      }
    }
    if (!addedInRound) break;
    depth++;
  }

  return selected;
}

function resolveAllowedId(rawId: unknown, allowedById: Map<string, CatalogueExercise>): string | null {
  const s = String(rawId || '').trim();
  if (!s) return null;
  if (allowedById.has(s)) return s;
  const beforePipe = s.split('|')[0].trim();
  if (allowedById.has(beforePipe)) return beforePipe;
  if (/^\d{1,4}$/.test(beforePipe)) {
    const padded = beforePipe.padStart(4, '0');
    if (allowedById.has(padded)) return padded;
  }
  return null;
}

export function sanitizeAiRoutineResponse(
  raw: unknown,
  allowedById: Map<string, CatalogueExercise>,
  input: AiRoutineInput,
): AiRoutineResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawList = Array.isArray(obj.exercises) ? obj.exercises : [];

  const seen = new Set<string>();
  const exercises: AiRoutineExerciseOut[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const id = resolveAllowedId(it.id, allowedById);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const ex = allowedById.get(id)!;
    const isIso = ex.cat === 'isometric' || /plank|hold|wall sit/i.test(ex.n);
    const mode: 'reps' | 'time' = it.mode === 'time' || (isIso && !Number(it.reps)) ? 'time' : 'reps';
    const sets = Math.min(6, Math.max(1, Math.round(Number(it.sets) || 3)));
    const restSec = Math.min(180, Math.max(30, Math.round(Number(it.restSec) || 75)));
    const rationale = String(it.rationale || '').trim().slice(0, 260);

    if (mode === 'time') {
      const sec = Math.min(120, Math.max(15, Math.round(Number(it.sec) || 30)));
      exercises.push({ id, sets, sec, mode: 'time', restSec, rationale });
    } else {
      const reps = Math.min(30, Math.max(4, Math.round(Number(it.reps) || 10)));
      exercises.push({ id, sets, reps, mode: 'reps', restSec, rationale });
    }

    if (exercises.length >= 10) break;
  }

  if (exercises.length === 0) return null;

  let totalSec = 0;
  for (const e of exercises) {
    const work = e.mode === 'time' ? (e.sec || 30) : Math.max(35, (e.reps || 10) * 4);
    totalSec += e.sets * work + (e.sets - 1) * e.restSec + 90;
  }

  const defaultName = input.lang === 'es' ? 'Rutina personalizada con IA' : 'AI Personalized Routine';
  return {
    name: String(obj.name || defaultName).trim().slice(0, 80) || defaultName,
    summary: String(obj.summary || '').trim().slice(0, 600),
    safetyNotes: String(obj.safetyNotes || '').trim().slice(0, 700),
    adaptationAdvice: String(obj.adaptationAdvice || '').trim().slice(0, 700),
    bmi: input.bmi,
    estimatedMinutes: Math.max(10, Math.round(totalSec / 60)),
    envs: input.envs,
    exercises,
  };
}

const AI_ROUTINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, description: 'Short, motivating routine title in the user language.' },
    summary: { type: Type.STRING, description: '2-3 sentences explaining how this routine fits the user body type, BMI, age, goal, and equipment.' },
    safetyNotes: { type: Type.STRING, description: 'Specific safety guidance for any reported injuries, cardiac, joint, or ligament limitations (or general safe form cue if none). Include medical clearance note if cardiac or injury is reported.' },
    adaptationAdvice: { type: Type.STRING, description: 'Explains the alternative exercise strategies used to train target muscles safely without aggravating the reported limitations.' },
    exercises: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'Exact exercise id from the provided candidate list.' },
          sets: { type: Type.INTEGER },
          reps: { type: Type.INTEGER, description: 'Target repetitions per set when mode is reps.' },
          sec: { type: Type.INTEGER, description: 'Hold seconds per set when mode is time.' },
          mode: { type: Type.STRING, enum: ['reps', 'time'] },
          restSec: { type: Type.INTEGER, description: 'Rest in seconds between sets (30 to 180).' },
          rationale: { type: Type.STRING, description: '1 concise sentence explaining why this movement fits the user body type or safely works around limitations.' },
        },
        required: ['id', 'sets', 'mode', 'restSec', 'rationale'],
      },
    },
  },
  required: ['name', 'summary', 'safetyNotes', 'adaptationAdvice', 'exercises'],
};

function buildPrompt(input: AiRoutineInput, candidates: CatalogueExercise[]): string {
  const envLabels: Record<TrainingEnv, string> = {
    none: 'No equipment (pure bodyweight on floor)',
    home: 'Home adaptable (chair, wall, towel, table, doorway, bottles)',
    gym: 'Gym equipment (weights, machines, benches, bars)',
  };

  const conditionLabels: Record<HealthCondition, string> = {
    cardiac: 'Cardiac / cardiovascular / blood pressure condition (avoid high-impact spikes, breath-holding/Valsalva, extreme inversions; keep controlled pacing and longer rest)',
    knees: 'Knee pain / knee injury (avoid jumping, deep knee shear, high-impact lunges; favor hip-dominant, controlled or joint-friendly alternatives)',
    lower_back: 'Lower back / lumbar discomfort (avoid heavy spinal flexion/loading; favor core stability, glute bridges, supported postures)',
    shoulders: 'Shoulder discomfort / impingement (avoid overhead strain, dips, handstands; favor neutral/controlled planes and scapular work)',
    wrists: 'Wrist / elbow pain (avoid loaded wrist extension on floor; favor forearm/elbow support or standing exercises)',
    neck: 'Neck / cervical strain (avoid neck loading, pulling head during crunches, inversions)',
    ankles: 'Ankle / foot limitation (avoid jumping, running, ballistic calf impact)',
    ligaments_muscle: 'Ligament or muscle strain / recovery (avoid explosive/plyometric loads; favor controlled tempo and joint-friendly alternatives)',
  };

  const targetCount = input.minutes <= 25 ? '4 to 5' : input.minutes <= 45 ? '5 to 7' : '6 to 8';
  const candidateLines = candidates
    .map((ex) => `${ex.id} | ${ex.n} | bp:${ex.bp} | target:${ex.tg} | env:${exerciseEnvironment(ex)} | lvl:${exerciseLevel(ex)} | int:${exerciseIntensity(ex)} | profile:${exerciseGender(ex)} | eq:${ex.eq}`)
    .join('\n');

  const languageRule = input.lang === 'es'
    ? 'Respond ENTIRELY in natural, clear Spanish (name, summary, safetyNotes, adaptationAdvice, and every rationale).'
    : 'Respond ENTIRELY in natural, clear English.';

  return [
    'You are an expert certified strength & conditioning specialist and exercise physiologist designing a safe, personalized workout routine.',
    languageRule,
    '',
    'USER BIOMETRICS & PROFILE:',
    `- Weight: ${input.weightKg} kg`,
    `- Height: ${input.heightCm} cm (BMI: ${input.bmi})`,
    `- Age: ${input.age ? `${input.age} years` : 'Not specified'}`,
    `- Profile / Gender preference: ${input.gender}`,
    `- Training experience level: ${input.level} (beginner / intermediate / advanced)`,
    `- Desired intensity: ${input.intensity} (low=light/gentle, medium=moderate, high=challenging)`,
    `- Body type / somatotype: ${input.bodyType}`,
    `- Primary goal: ${input.goal}`,
    `- Session focus: ${input.focus}`,
    `- Target duration: ~${input.minutes} minutes (select ${targetCount} distinct exercises)`,
    `- Allowed training environments ONLY: ${input.envs.map((e) => envLabels[e]).join('; ')}`,
    `- Reported physical/medical limitations: ${input.conditions.length ? input.conditions.map((c) => conditionLabels[c]).join(' | ') : 'None reported'}`,
    `- Additional user notes on pain/limitations: ${input.conditionNotes || 'None'}`,
    '',
    'STRICT RULES:',
    '1. You MUST ONLY select exercise IDs that appear verbatim in the CANDIDATE EXERCISES list below. Never invent IDs.',
    '2. Every exercise must safely respect the user limitations, level, intensity, and profile. When a limitation prevents a classic exercise, select a joint-friendly alternative that still trains the muscle safely and explain why in `rationale` and `adaptationAdvice`.',
    '3. Tailor sets, reps/seconds, and rest times to the user level, intensity, body type, BMI, age, goal, and safety constraints (e.g., beginner/low intensity -> fewer sets, gentle movements, longer rest; advanced/high intensity -> challenging progressions, higher sets/reps, shorter rest).',
    '4. If cardiac or injury limitations are present, remind the user calmly in `safetyNotes` to stop on pain/dizziness and consult their physician/physiotherapist.',
    '',
    'CANDIDATE EXERCISES (format: id | name | body part | target muscle | environment | equipment):',
    candidateLines,
  ].join('\n');
}

export interface AiModelAttempt {
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  timeoutMs: number;
  thinkingLevel: ThinkingLevel;
}

// Per @google/genai guidelines: ThinkingLevel.MINIMAL is only supported on gemini-3.1-flash-lite;
// gemini-4-hydrogen requires ThinkingLevel.LOW or higher (passing MINIMAL returns 400 INVALID_ARGUMENT).
export const AI_MODEL_ATTEMPTS: readonly AiModelAttempt[] = [
  { model: 'gemini-4-hydrogen', timeoutMs: 22000, thinkingLevel: ThinkingLevel.LOW },
  { model: 'gemini-3.1-flash-lite', timeoutMs: 16000, thinkingLevel: ThinkingLevel.MINIMAL },
  { model: 'gemini-3.1-flash-lite', timeoutMs: 16000, thinkingLevel: ThinkingLevel.MINIMAL },
];

export async function handleAiRoutineRequest(req: Request, res: Response): Promise<void> {
  const validated = validateAiRoutineInput(req.body);
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const input = validated.data;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    res.status(503).json({
      error: input.lang === 'es'
        ? 'El servicio de IA no tiene configurada la clave GEMINI_API_KEY en el servidor.'
        : 'AI service is not configured: GEMINI_API_KEY is missing on the server.',
    });
    return;
  }

  const candidates = selectCandidateExercises(input);
  if (candidates.length === 0) {
    res.status(422).json({
      error: input.lang === 'es'
        ? 'No hay ejercicios compatibles con esa combinación de equipamiento y restricciones. Prueba añadir "Adaptable en casa" o cambiar el enfoque.'
        : 'No exercises match that combination of equipment and restrictions. Try adding "Home adaptable" or changing the focus.',
    });
    return;
  }

  const allowedById = new Map<string, CatalogueExercise>(candidates.map((ex) => [ex.id, ex]));

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const prompt = buildPrompt(input, candidates);
    let sanitized: AiRoutineResult | null = null;
    let lastErr: unknown = null;

    for (let i = 0; i < AI_MODEL_ATTEMPTS.length; i++) {
      const { model, timeoutMs, thinkingLevel } = AI_MODEL_ATTEMPTS[i];
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: AI_ROUTINE_SCHEMA,
            thinkingConfig: { thinkingLevel },
            abortSignal: AbortSignal.timeout(timeoutMs),
          },
        });
        const rawText = (response.text || '').trim();
        if (!rawText) {
          throw new Error(`Empty response from ${model}`);
        }
        const cleanedJson = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(cleanedJson);
        const result = sanitizeAiRoutineResponse(parsed, allowedById, input);
        if (!result) {
          throw new Error(`Model ${model} returned no valid exercises from the filtered catalogue`);
        }
        sanitized = result;
        break;
      } catch (err: unknown) {
        lastErr = err;
        const e = err as { status?: number; name?: string; message?: string };
        const status = e?.status;
        const msg = String(e?.message || '');
        const isAuthError = status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(msg);
        console.warn(`[ai-routine] Attempt ${i + 1}/${AI_MODEL_ATTEMPTS.length} (${model}, ${thinkingLevel}) failed:`, status || e?.name || 'error', msg.slice(0, 300));
        if (isAuthError) {
          throw err;
        }
        if (i < AI_MODEL_ATTEMPTS.length - 1) {
          const isRateOrServer = status === 429 || status === 503 || status === 500 || status === 504;
          if (isRateOrServer) {
            await new Promise((resolve) => setTimeout(resolve, 600 * (i + 1)));
          }
          continue;
        }
        throw err;
      }
    }

    if (!sanitized) {
      throw lastErr || new Error('Empty response from Gemini model');
    }

    res.json(sanitized);
  } catch (err: unknown) {
    const e = err as { status?: number; name?: string; message?: string };
    const msg = String(e?.message || '');
    console.error('[ai-routine] Gemini generation failed:', e?.status || e?.name, msg || err);

    const isAuthError = e?.status === 401 || e?.status === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(msg);
    const isQuota = e?.status === 429 || /RESOURCE_EXHAUSTED/i.test(msg);
    const isBusy = isQuota || e?.status === 503 || e?.name === 'TimeoutError' || e?.name === 'AbortError';

    if (isAuthError) {
      res.status(503).json({
        error: input.lang === 'es'
          ? 'La clave de API de Gemini no es válida o no tiene permisos. Verifícala en Ajustes > Secretos.'
          : 'The Gemini API key is invalid or lacks permissions. Check it in Settings > Secrets.',
      });
      return;
    }

    res.status(isBusy ? 503 : 502).json({
      error: isBusy
        ? (input.lang === 'es'
            ? 'El servicio de IA está con alta demanda en este momento. Espera unos segundos e inténtalo de nuevo.'
            : 'The AI service is experiencing high demand right now. Please wait a few seconds and try again.')
        : (input.lang === 'es'
            ? 'No se pudo generar la rutina con IA en este momento. Inténtalo de nuevo.'
            : 'Could not generate an AI routine right now. Please try again.'),
    });
  }
}
