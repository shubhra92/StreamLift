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

// File downloads table
export const fileDownloads = pgTable('file_downloads', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').references(() => megaSessions.id),
  fileName: text('file_name').default("default"),
  sourceUrl: text('source_url').notNull(),
  location: text('location'), // mega, server
  locationPath: text('location_path'),
  fileSize: bigint('file_size', { mode: 'number' }),
  fileType: text('file_type'),
  status: text('status').default('pending'), // pending, downloading, uploading, completed, failed
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
