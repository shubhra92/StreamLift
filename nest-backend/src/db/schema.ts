import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  uuid,
  bigint,
  unique,
} from 'drizzle-orm/pg-core';

export const guests = pgTable('guests', {
  id: uuid('id').defaultRandom().primaryKey(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  isActive: boolean('is_active').default(true),
  lastSeenAt: timestamp('last_seen_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const megaSessions = pgTable('mega_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  sessionData: text('session_data'),
  country: text('country'),
  ipAddress: text('ip_address'),
  workerId: uuid('worker_id'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const workers = pgTable('workers', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id').references(() => guests.id),
  name: text('name').notNull(),
  downloadLocation: text('download_location').notNull(),
  computeType: text('compute_type').notNull(),
  megaEmail: text('mega_email'),
  megaSession: text('mega_session'),
  megaNeedsRelink: boolean('mega_needs_relink').default(false),
  megaRelinkReason: text('mega_relink_reason'),
  pinggyToken: text('pinggy_token'),
  authToken: text('auth_token').notNull(),
  version: text('version').default('1.0.0'),
  totalDownloads: integer('total_downloads').default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0),
  pinggyUrl: text('pinggy_url'),
  lastHeartbeat: timestamp('last_heartbeat'),
  ipAddress: text('ip_address'),
  countryCode: text('country_code'),
  sessionToken: text('session_token'),
  sessionTokenExpiry: timestamp('session_token_expiry'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  unique('workers_name_guest_unique').on(t.name, t.guestId),
]);

export const fileDownloads = pgTable('file_downloads', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id').references(() => guests.id),
  sessionId: uuid('session_id').references(() => megaSessions.id),
  workerId: uuid('worker_id').references(() => workers.id),
  fileName: text('file_name').default('default'),
  sourceUrl: text('source_url').notNull(),
  location: text('location'),
  locationPath: text('location_path'),
  fileSize: bigint('file_size', { mode: 'number' }),
  fileType: text('file_type'),
  status: text('status').default('pending'),
  errorMessage: text('error_message'),
  downloadType: text('download_type').default('http'),
  selectedFileIndices: text('selected_file_indices'),
  cloudFileHandle: text('cloud_file_handle'),
  cloudShareUrl: text('cloud_share_url'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export type FileDownload = typeof fileDownloads.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type MegaSession = typeof megaSessions.$inferSelect;
