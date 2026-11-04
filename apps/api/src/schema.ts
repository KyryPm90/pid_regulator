import { z } from "zod";
import { PROP_MAX, PROP_MIN } from "@pid/core";

/** Перевірка параметрів борта, які приходять від клієнта. */
export const buildParamsSchema = z.object({
  prop: z.number().min(PROP_MIN).max(PROP_MAX),
  pitch: z.number().min(1).max(15),
  blades: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  frame: z.enum(["open", "ducted"]),
  stator: z.string().max(12),
  kv: z.number().min(30).max(5000),
  cells: z.number().int().min(1).max(16),
  auw: z.number().min(100).max(60000),
  style: z.enum(["freestyle", "race", "cinematic", "longrange", "payload"]),
  motorPoles: z.number().int().min(4).max(64),
  profile: z.number().int().min(0).max(3),
  rateProfile: z.number().int().min(0).max(3),
  rpmFilter: z.boolean(),
});

export const buildInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  params: buildParamsSchema,
});

/** Запис тюну: стартовий розрахунок або корекція за логом. */
export const sessionInputSchema = z.object({
  kind: z.enum(["start", "log"]),
  cli: z.string().min(1).max(50_000),
  /** Налаштування, як їх повертає @pid/core (PID, фільтри, рейти) */
  tune: z.record(z.unknown()),
  changes: z
    .array(z.object({ group: z.string(), param: z.string(), from: z.number(), to: z.number(), reason: z.string() }))
    .max(200)
    .default([]),
  findings: z.array(z.string().max(500)).max(100).default([]),
  /** Короткий підсумок аналізу логу: пік відгуку, шум, резонанс тощо */
  summary: z.record(z.union([z.number(), z.string(), z.null()])).default({}),
  note: z.string().max(2000).optional(),
});

export type BuildInput = z.infer<typeof buildInputSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;

/** Тимчасова ідентифікація клієнта до появи акаунтів: випадковий UUID з браузера. */
export const clientIdSchema = z.string().uuid();
