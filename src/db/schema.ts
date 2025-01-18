import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Define the schema for the 'channels' table
export const channels = sqliteTable('channels', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelName: text('channel_name').notNull().unique(),
    createdAt: text('created_at')
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
});

// Define the schema for the 'videos' table
export const videos = sqliteTable('videos', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    videoId: text('video_id').notNull().unique(),
    channelId: integer('channel_id')
        .notNull()
        .references(() => channels.id),
    title: text('title').notNull(),
    url: text('url').notNull(),
    thumbnailUrl: text('thumbnail_url').notNull(),
    createdAt: text('created_at')
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
});

// Define the schema for the 'video_statistics' table
export const videoStatistics = sqliteTable('video_statistics', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    videoId: integer('video_id')
        .notNull()
        .references(() => videos.id),
    viewCount: integer('view_count').notNull(),
    likeCount: integer('like_count').notNull(),
    commentCount: integer('comment_count').notNull(),
    recordedAt: text('recorded_at')
        .notNull()
        .default(sql`CURRENT_TIMESTAMP`),
});

// Define TypeScript types for the tables
export type Channel = typeof channels.$inferInsert; // Insert type for channels
export type Video = typeof videos.$inferInsert; // Insert type for videos
export type VideoStatistics = typeof videoStatistics.$inferInsert; // Insert type for videoStatistics