import { pgTable, text, timestamp, integer, boolean, uuid, bigint, unique, index } from 'drizzle-orm/pg-core';

export const guests = pgTable('guests', {
  id: uuid('id').defaultRandom().primaryKey(),
  token: text('token').notNull().unique(),  // stored in httpOnly cookie
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  isActive: boolean('is_active').default(true),
  lastSeenAt: timestamp('last_seen_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
});

export type Guest = typeof guests.$inferSelect;
export type NewGuest = typeof guests.$inferInsert;

export const megaSessions = pgTable('mega_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  sessionData: text('session_data'),
  workerId: uuid('worker_id'),   // null = server session, set = worker-specific session
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const workers = pgTable('workers', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id').references(() => guests.id), // owning guest
  name: text('name').notNull(),                          // unique per guest — see table constraint below
  downloadLocation: text('download_location').notNull(), // 'local' | 'mega'
  computeType: text('compute_type').notNull(),           // 'low' | 'medium' | 'high'
  megaEmail: text('mega_email'),
  megaSession: text('mega_session'),                     // AES-256-GCM encrypted session JSON (session-only mode)
  megaNeedsRelink: boolean('mega_needs_relink').default(false), // set by worker when session dies
  megaRelinkReason: text('mega_relink_reason'),
  pinggyToken: text('pinggy_token'),                     // AES-256-GCM encrypted
  authToken: text('auth_token').notNull(),
  version: text('version').default('1.0.0'),
  totalDownloads: integer('total_downloads').default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0),
  // ── v2: direct connection fields ─────────────────────────────────────────
  pinggyUrl: text('pinggy_url'),                         // current public tunnel URL
  lastHeartbeat: timestamp('last_heartbeat'),            // updated every 8s by worker
  ipAddress: text('ip_address'),                         // worker's public IP (set on register)
  countryCode: text('country_code'),                     // ISO 3166-1 alpha-2 country for the current public IP
  sessionToken: text('session_token'),                   // short-lived client access token
  sessionTokenExpiry: timestamp('session_token_expiry'), // rotated every 4hr
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  unique('workers_name_guest_unique').on(t.name, t.guestId), // name unique per guest
]);

export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;

export const fileDownloads = pgTable('file_downloads', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id').references(() => guests.id),   // owning guest
  sessionId: uuid('session_id').references(() => megaSessions.id),
  workerId: uuid('worker_id').references(() => workers.id), // assigned worker (nullable)
  fileName: text('file_name').default("default"),
  sourceUrl: text('source_url').notNull(),
  location: text('location'), // 'server' | 'mega' | 'all-workers' | 'worker-{uuid}'
  locationPath: text('location_path'),
  fileSize: bigint('file_size', { mode: 'number' }),
  fileType: text('file_type'),
  status: text('status').default('pending'),
  errorMessage: text('error_message'),
  downloadType: text('download_type').default('http'), // 'http' or 'torrent'
  selectedFileIndices: text('selected_file_indices'), // JSON array of selected file indices for torrents
  cloudFileHandle: text('cloud_file_handle'), // Provider node handle for the uploaded file (used for share links)
  cloudShareUrl: text('cloud_share_url'),    // Provider share link URL (created on demand)
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export type FileDownload = typeof fileDownloads.$inferSelect;

// ── Android TV pairing ────────────────────────────────────────────────────────

/**
 * A paired Android TV. The TV never holds the browser guest cookie — it gets
 * its own bearer token, hashed here, so the web UI can revoke individual TVs.
 */
export const tvDevices = pgTable('tv_devices', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id').notNull().references(() => guests.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('Android TV'),
  model: text('model'),
  appVersion: text('app_version'),
  tokenHash: text('token_hash'),                 // null until the TV polls after approval
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').defaultNow(),
  revokedAt: timestamp('revoked_at'),
}, (t) => [
  index('tv_devices_guest_idx').on(t.guestId),
  index('tv_devices_token_idx').on(t.tokenHash),
]);

export type TvDevice = typeof tvDevices.$inferSelect;
export type NewTvDevice = typeof tvDevices.$inferInsert;

/**
 * A short-lived pairing claim. The TV creates a device secret, displays the
 * server-generated 6-character code, and polls until a web session approves it.
 * Only hashes are stored; the raw code and secret never touch the database.
 */
export const tvPairings = pgTable('tv_pairings', {
  id: uuid('id').defaultRandom().primaryKey(),
  codeHash: text('code_hash').notNull(),
  deviceSecretHash: text('device_secret_hash').notNull(),
  deviceName: text('device_name'),
  model: text('model'),
  appVersion: text('app_version'),
  status: text('status').notNull().default('pending'), // pending | approved | denied | expired
  guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => tvDevices.id, { onDelete: 'cascade' }),
  attempts: integer('attempts').notNull().default(0),
  ipHash: text('ip_hash'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  approvedAt: timestamp('approved_at'),
  consumedAt: timestamp('consumed_at'),
}, (t) => [
  index('tv_pairings_code_idx').on(t.codeHash),
  index('tv_pairings_secret_idx').on(t.deviceSecretHash),
  index('tv_pairings_expiry_idx').on(t.expiresAt),
]);

export type TvPairing = typeof tvPairings.$inferSelect;
export type NewTvPairing = typeof tvPairings.$inferInsert;
