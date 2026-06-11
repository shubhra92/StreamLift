import { pgTable, text, timestamp, integer, boolean, uuid, bigint } from 'drizzle-orm/pg-core';

// Mega sessions table
export const megaSessions = pgTable('mega_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  sessionData: text('session_data'), // JSON string of mega session
  country: text('country'), // Country code from IP (e.g., 'US', 'GB', 'DE')
  ipAddress: text('ip_address'), // IP address when session was created
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Workers table
export const workers = pgTable('workers', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  downloadLocation: text('download_location').notNull(), // 'local' | 'mega'
  computeType: text('compute_type').notNull(),           // 'low' | 'medium' | 'high'
  megaEmail: text('mega_email'),
  megaPassword: text('mega_password'),                   // AES-256-GCM encrypted
  authToken: text('auth_token').notNull(),
  version: text('version').default('1.0.0'),
  totalDownloads: integer('total_downloads').default(0),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0),
  totalUptime: integer('total_uptime').default(0),       // seconds
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// File downloads table
export const fileDownloads = pgTable('file_downloads', {
  id: uuid('id').defaultRandom().primaryKey(),
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
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
