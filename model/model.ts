import { Type, type Static } from '@sinclair/typebox';

// ─── Auth ────────────────────────────────────────────────────────

export const SignUpEmailSchema = Type.Object({
  email: Type.String({ format: 'email' }),
  password: Type.String({ minLength: 6 }),
});
export type SignUpEmail = Static<typeof SignUpEmailSchema>;

export const LoginValidatorSchema = Type.Object({
  email: Type.String({ format: 'email' }),
  password: Type.String(),
});
export type LoginValidator = Static<typeof LoginValidatorSchema>;

export const UpdatePasswordSchema = Type.Object({
  current_password: Type.String(),
  new_password: Type.String({ minLength: 6 }),
});
export type UpdatePassword = Static<typeof UpdatePasswordSchema>;

export const RefreshTokenSchema = Type.Object({
  refresh_token: Type.String(),
});
export type RefreshToken = Static<typeof RefreshTokenSchema>;

// ─── File upload ─────────────────────────────────────────────────

export const UploadModelSchema = Type.Object({
  fileData: Type.String(),
  fileName: Type.String(),
  filePath: Type.String(),
  contentType: Type.String(),
});
export type UploadModel = Static<typeof UploadModelSchema>;

// ─── User profile ────────────────────────────────────────────────

export const UserProfileSchema = Type.Object({
  id: Type.String(),
  email: Type.Optional(Type.String()),
  display_name: Type.Optional(Type.String()),
  avatar_url: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  created_at: Type.Optional(Type.String()),
  skills: Type.Optional(Type.Array(Type.String())),
  resume_text: Type.Optional(Type.String()),
});
export type UserProfile = Static<typeof UserProfileSchema>;

// ─── Job / job board ─────────────────────────────────────────────

export const StructuredJobSchema = Type.Object({
  title: Type.String(),
  company: Type.String(),
  location: Type.Optional(Type.String()),
  description: Type.String(),
  skills: Type.Optional(Type.Array(Type.String())),
  remote_status: Type.Optional(Type.Union([
    Type.Literal('remote'),
    Type.Literal('hybrid'),
    Type.Literal('onsite'),
    Type.Literal('unknown'),
  ])),
  salary_range: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  apply_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  posted_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  source_site: Type.Optional(Type.String()),
});
export type StructuredJob = Static<typeof StructuredJobSchema>;

export const JobRecordSchema = Type.Intersect([
  StructuredJobSchema,
  Type.Object({
    id: Type.String(),
    source_url: Type.String(),
    crawled_at: Type.String(),
  }),
]);
export type JobRecord = Static<typeof JobRecordSchema>;

// ─── Resume / profile extraction ─────────────────────────────────

export const StructuredProfileSchema = Type.Object({
  skills: Type.Array(Type.String()),
  experience_years: Type.Optional(Type.Number()),
  top_roles: Type.Optional(Type.Array(Type.String())),
  locations_preferred: Type.Optional(Type.Array(Type.String())),
  remote_preference: Type.Optional(Type.Union([
    Type.Literal('remote'),
    Type.Literal('hybrid'),
    Type.Literal('onsite'),
    Type.Literal('not_specified'),
  ])),
});
export type StructuredProfile = Static<typeof StructuredProfileSchema>;

// ─── Application tracking ────────────────────────────────────────

export const ApplicationStatusSchema = Type.Union([
  Type.Literal('saved'),
  Type.Literal('applied'),
  Type.Literal('interviewing'),
  Type.Literal('offer'),
  Type.Literal('accepted'),
  Type.Literal('rejected'),
]);
export type ApplicationStatus = Static<typeof ApplicationStatusSchema>;

export const ApplicationSchema = Type.Object({
  id: Type.Optional(Type.String()),
  user_id: Type.String(),
  job_id: Type.String(),
  status: Type.Optional(ApplicationStatusSchema),
  notes: Type.Optional(Type.String()),
  deadline: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.Optional(Type.String()),
  updated_at: Type.Optional(Type.String()),
});
export type Application = Static<typeof ApplicationSchema>;

// ─── Match result ────────────────────────────────────────────────

export const MatchResultSchema = Type.Object({
  job_id: Type.String(),
  title: Type.String(),
  company: Type.String(),
  location: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  skills: Type.Optional(Type.Array(Type.String())),
  remote_status: Type.Optional(Type.String()),
  salary_range: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  apply_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  source_site: Type.Optional(Type.String()),
  posted_date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  similarity: Type.Number(),
  missing_skills: Type.Array(Type.String()),
});
export type MatchResult = Static<typeof MatchResultSchema>;

// ─── Generic API response ────────────────────────────────────────

export interface ApiResponse {
  success?: boolean;
  status?: number;
  response?: string;
  error?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

// ─── Redis Models  ────────────────────────────────────────

export const RedisGetString = Type.Object({
  key: Type.String()
});
export type RedisGetString = Static<typeof RedisGetString>;

export const RedisSetString = Type.Object({
  key: Type.String(),
  value: Type.String()
});
export type RedisSetString = Static<typeof RedisSetString>;

export const RedisSetExpiryString = Type.Object({
  key: Type.String(),
  value: Type.String(),
  expiry: Type.Number()
});
export type RedisSetExpiryString = Static<typeof RedisSetExpiryString>;

// Sorted set
export const RedisZAddPayload = Type.Object({
  key: Type.String(),
  score: Type.Number(),
  member: Type.String()
});
export type RedisZAddPayload = Static<typeof RedisZAddPayload>;

export const RedisZRangePayload = Type.Object({
  key: Type.String(),
  start: Type.Number(),
  stop: Type.Number()
});
export type RedisZRangePayload = Static<typeof RedisZRangePayload>;

// List
export const RedisLPushPayload = Type.Object({
  key: Type.String(),
  value: Type.String()
});
export type RedisLPushPayload = Static<typeof RedisLPushPayload>;

export const RedisLRangePayload = Type.Object({
  key: Type.String(),
  start: Type.Number(),
  stop: Type.Number()
});
export type RedisLRangePayload = Static<typeof RedisLRangePayload>;

// Hash
export const RedisHSetPayload = Type.Object({
  key: Type.String(),
  field: Type.String(),
  value: Type.String()
});
export type RedisHSetPayload = Static<typeof RedisHSetPayload>;

export const RedisHGetPayload = Type.Object({
  key: Type.String(),
  field: Type.String()
});
export type RedisHGetPayload = Static<typeof RedisHGetPayload>;

// Set
export const RedisSAddPayload = Type.Object({
  key: Type.String(),
  member: Type.String()
});
export type RedisSAddPayload = Static<typeof RedisSAddPayload>;

export const RedisSPopPayload = Type.Object({
  key: Type.String(),
  count: Type.Optional(Type.Number())
});
export type RedisSPopPayload = Static<typeof RedisSPopPayload>;
