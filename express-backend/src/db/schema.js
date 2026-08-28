import { pgTable, text, timestamp, integer, boolean, uuid, bigint, unique } from 'drizzle-orm/pg-core';

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
  sessionData: text('session_data'), // JSON string of mega session
  country: text('country'),
  ipAddress: text('ip_address'),
  workerId: uuid('worker_id'),       // null = server session, set = worker-specific session
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Workers table
export const workers = pgTable('workers', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id').references(() => guests.id), // owning guest
  name: text('name').notNull(),                          // unique per guest
  downloadLocation: text('download_location').notNull(), // 'local' | 'mega'
  computeType: text('compute_type').notNull(),           // 'low' | 'medium' | 'high'
  megaEmail: text('mega_email'),
  megaPassword: text('mega_password'),                   // AES-256-GCM encrypted
  pinggyToken: text('pinggy_token'),                     // AES-256-GCM encrypted
  authToken: text('auth_token').notNull(),
  version: text('version').default('1.0.0'),
  totalDownloads: integer('total_downloads').default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0),
  // ── v2: direct connection fields ─────────────────────────────────────────
  pinggyUrl: text('pinggy_url'),                         // current public tunnel URL
  lastHeartbeat: timestamp('last_heartbeat'),            // updated every 8s by worker
  ipAddress: text('ip_address'),                         // worker's public IP
  countryCode: text('country_code'),                     // ISO country for the current public IP
  sessionToken: text('session_token'),                   // short-lived client access token
  sessionTokenExpiry: timestamp('session_token_expiry'), // rotated every 4hr
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  unique('workers_name_guest_unique').on(t.name, t.guestId),
]);

// File downloads table
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
  status: text('status').default('pending'), // pending, downloading, uploading, completed, failed
  errorMessage: text('error_message'),
  downloadType: text('download_type').default('http'), // 'http' or 'torrent'
  selectedFileIndices: text('selected_file_indices'), // JSON array of selected file indices for torrents
  cloudFileHandle: text('cloud_file_handle'), // Provider node handle for the uploaded file (used for share links)
  cloudShareUrl: text('cloud_share_url'),    // Provider share link URL (created on demand)
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
