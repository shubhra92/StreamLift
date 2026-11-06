import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  uuid,
  bigint,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * A permanent account. Credentials only — the workspace owns all resources.
 *
 * Users and workspaces are linked 1:1 for now through
 * workspaces.owner_user_id. A future workspace_members table can make this
 * many-to-many without moving any data.
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),          // always stored lowercase
  passwordHash: text('password_hash').notNull(),    // scrypt$N$r$p$salt$hash
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * A tenant. Every guest, download, worker, and TV device belongs to one.
 *
 * owner_user_id IS NULL  → anonymous guest workspace
 * owner_user_id IS NOT NULL → permanent account workspace
 */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: uuid('owner_user_id').references(() => users.id),
  name: text('name').notNull().default('Personal workspace'),
  // Deprecated: only used for one-release rollback to the old guest-token
  // model. New code authenticates through auth_sessions instead.
  legacyToken: text('legacy_token'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  isActive: boolean('is_active').default(true),
  lastSeenAt: timestamp('last_seen_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  // null = permanent account workspace; a date = anonymous guest workspace
  expiresAt: timestamp('expires_at'),
  // Soft delete for a future retention job. No destructive cleanup yet.
  deletedAt: timestamp('deleted_at'),
}, (t) => [
  uniqueIndex('workspaces_owner_user_unique')
    .on(t.ownerUserId)
    .where(sql`${t.ownerUserId} is not null`),
  index('workspaces_cleanup_idx')
    .on(t.expiresAt)
    .where(sql`${t.ownerUserId} is null and ${t.deletedAt} is null`),
]);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

/**
 * One row per signed-in browser/device. The cookie holds a 256-bit random
 * token; only its SHA-256 hash is stored here.
 *
 * user_id IS NULL → anonymous guest session
 * user_id IS NOT NULL → authenticated account session
 */
export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  revokedAt: timestamp('revoked_at'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
}, (t) => [
  index('auth_sessions_workspace_idx').on(t.workspaceId),
  index('auth_sessions_user_idx').on(t.userId),
  index('auth_sessions_expiry_idx').on(t.expiresAt),
]);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;

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
  workspaceId: uuid('workspace_id').references(() => workspaces.id), // owning workspace
  name: text('name').notNull(),                          // unique per workspace — see table constraint below
  downloadLocation: text('download_location').notNull(), // 'local' | 'mega'
  computeType: text('compute_type').notNull(),           // 'low' | 'medium' | 'high'
  consoleLogs: boolean('console_logs').notNull().default(true), // print worker logs to the console
  megaEmail: text('mega_email'),
  megaSession: text('mega_session'),                     // AES-256-GCM encrypted session JSON (session-only mode)
  megaNeedsRelink: boolean('mega_needs_relink').default(false), // set by worker when session dies
  megaRelinkReason: text('mega_relink_reason'),
  authToken: text('auth_token').notNull(),
  version: text('version').default('1.0.0'),
  totalDownloads: integer('total_downloads').default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0),
  // ── v2: direct connection fields ─────────────────────────────────────────
  tunnelUrl: text('tunnel_url'),                         // current public tunnel URL
  // ── v3: multi-provider tunnel config ─────────────────────────────────────
  activeTunnelProvider: text('active_tunnel_provider').default('pinggy'), // 'pinggy' | 'serveo' | 'zrok'
  tunnelConfig: text('tunnel_config'),                   // AES-256-GCM encrypted JSON: { pinggy?, serveo?, zrok? }
  lastHeartbeat: timestamp('last_heartbeat'),            // updated every 8s by worker
  ipAddress: text('ip_address'),                         // worker's public IP (set on register)
  countryCode: text('country_code'),                     // ISO 3166-1 alpha-2 country for the current public IP
  sessionToken: text('session_token'),                   // short-lived client access token
  sessionTokenExpiry: timestamp('session_token_expiry'), // rotated every 4hr
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  unique('workers_name_workspace_unique').on(t.name, t.workspaceId), // name unique per workspace
]);

export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;

export const fileDownloads = pgTable('file_downloads', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id),   // owning workspace
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

/**
 * An item explicitly saved to the Watch page.
 *
 * Rows are standalone: `source_download_id` is intentionally NOT a foreign key,
 * so deleting the originating download (or its MEGA file) never removes the
 * Watch entry. The saved `source_url` is enough to keep playing it.
 *
 * `provider` + `playback_mode` tell the client which playback adapter to use:
 *   provider "mega", playback_mode "mega-share" -> megajs range decryption
 *   provider "s3",   playback_mode "direct"     -> plain range fetch
 * Future providers only add values/adapters; the table shape stays the same.
 */
export const watchItems = pgTable('watch_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('mega'),
  providerItemId: text('provider_item_id'),
  name: text('name').notNull(),
  fileSize: bigint('file_size', { mode: 'number' }),
  kind: text('kind').notNull(), // 'video' | 'audio'
  mimeType: text('mime_type'),
  sourceUrl: text('source_url').notNull(),
  playbackMode: text('playback_mode').notNull().default('mega-share'),
  sourceDownloadId: uuid('source_download_id'), // no FK — survives download deletion
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  index('watch_items_workspace_idx').on(t.workspaceId),
  uniqueIndex('watch_items_workspace_provider_source_unique').on(t.workspaceId, t.provider, t.sourceUrl),
  uniqueIndex('watch_items_workspace_download_unique')
    .on(t.workspaceId, t.sourceDownloadId)
    .where(sql`${t.sourceDownloadId} is not null`),
]);

export type WatchItem = typeof watchItems.$inferSelect;
export type NewWatchItem = typeof watchItems.$inferInsert;

// ── Android TV pairing ────────────────────────────────────────────────────────

/**
 * A paired Android TV. The TV never holds the browser session cookie — it gets
 * its own bearer token, hashed here, so the web UI can revoke individual TVs.
 */
export const tvDevices = pgTable('tv_devices', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('Android TV'),
  model: text('model'),
  appVersion: text('app_version'),
  tokenHash: text('token_hash'),                 // null until the TV polls after approval
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').defaultNow(),
  revokedAt: timestamp('revoked_at'),
}, (t) => [
  index('tv_devices_workspace_idx').on(t.workspaceId),
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
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
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
