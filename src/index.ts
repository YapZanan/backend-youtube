import { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { App } from "./types";
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { channels, videos, videoStatistics } from './db/schema';
import { autochunk } from './autochunk';

const app = new Hono<App>();

app.use('/', cors());

function extractUsername(input: string): string | null {
  const urlRegex = /^https?:\/\/(www\.)?youtube\.com\/(channel\/UC[\w-]{21}[AQgw]|(c\/|user\/)?[\w@-]+)$/;

  if (input.startsWith('@')) {
    return input;
  }

  const match = input.match(urlRegex);
  return match ? match[2] : null;
}

interface YouTubeChannelResponse {
  items: Array<{
    contentDetails: {
      relatedPlaylists: {
        uploads: string;
      };
    };
  }>;
}

interface PlaylistItemResponse {
  nextPageToken: string | undefined;
  items: Array<{
    snippet: {
      thumbnails: any;
      title: string;
      resourceId: {
        videoId: string;
      };
    };
  }>;
}

interface VideoStatisticsResponse {
  items: Array<{
    id: string;
    statistics: {
      viewCount: string;
      likeCount: string;
      commentCount: string;
    };
  }>;
}

async function getUploadsChannelId(apiKey: string, username: string): Promise<string | null> {
  const url = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&forHandle=${username}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data: YouTubeChannelResponse = await response.json();
    return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
  } catch (error) {
    console.error('Error fetching uploads channel ID:', error);
    return null;
  }
}

async function getPlaylistVideos(apiKey: string, playlistId: string): Promise<any[]> {
  const url = `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}`;
  let videos: any[] = [];
  let nextPageToken: string | undefined;

  do {
    const apiUrl = nextPageToken ? `${url}&pageToken=${nextPageToken}` : url;
    const response = await fetch(apiUrl);
    const data: PlaylistItemResponse = await response.json();

    videos.push(...data.items.map(item => ({
      videoId: item.snippet.resourceId.videoId,
      videoTitle: item.snippet.title,
      thumbnailUrl: item.snippet.thumbnails?.high?.url,
    })));

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return videos;
}

async function getVideoStatistics(apiKey: string, videoIds: string[]): Promise<any[]> {
  const url = `https://youtube.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data: VideoStatisticsResponse = await response.json();
    return data.items?.map(item => ({
      videoId: item.id,
      viewCount: item.statistics.viewCount,
      likeCount: item.statistics.likeCount,
      commentCount: item.statistics.commentCount,
    })) || [];
  } catch (error) {
    console.error('Error fetching video statistics:', error);
    return [];
  }
}

async function batchGetVideoStatistics(apiKey: string, videoIds: string[]): Promise<any[]> {
  const batchSize = 50;
  const batches = [];

  for (let i = 0; i < videoIds.length; i += batchSize) {
    batches.push(getVideoStatistics(apiKey, videoIds.slice(i, i + batchSize)));
  }

  const results = await Promise.all(batches);
  return results.flat();
}

const insertChannel = async (channelName: string, c: Context) => {
  const db = drizzle(c.env.DB);
  const existingChannel = await db.select().from(channels).where(eq(channels.channelName, channelName)).get();
  return existingChannel || (await db.insert(channels).values({ channelName }).returning())[0];
};

const batchInsertVideos = async (
  videosData: {
    videoId: string;
    channelId: number;
    title: string;
    url: string;
    thumbnailUrl: string;
  }[],
  c: Context,
): Promise<Map<string, number>> => {
  const db = drizzle(c.env.DB);

  // Fetch existing video IDs and their database IDs
  const existingVideos = await db
    .select({
      id: videos.id,
      videoId: videos.videoId,
    })
    .from(videos);

  const existingVideoMap = new Map(
    existingVideos.map((video) => [video.videoId, video.id]),
  );

  // Separate new videos from existing ones
  const newVideosData = videosData.filter(
    (video) => !existingVideoMap.has(video.videoId),
  );

  // Use autochunk to insert new videos in smaller chunks
  const insertedVideos = await autochunk(
    newVideosData,
    (chunk) => db.insert(videos).values(chunk).returning(),
  );

  // Add the newly inserted videos to the existingVideoMap
  for (const video of insertedVideos) {
    existingVideoMap.set(video.videoId, video.id);
  }

  // Return a map of videoId to database ID for all videos
  return existingVideoMap;
};

const batchInsertVideoStatistics = async (
  statsData: {
    videoId: string;
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
  }[],
  videoIdMap: Map<string, number>,
  c: Context,
) => {
  const db = drizzle(c.env.DB);

  // Map videoId to database ID and ensure all required fields have valid values
  const statsWithDbIds = statsData.map((stat) => ({
    videoId: videoIdMap.get(stat.videoId)!,
    viewCount: stat.viewCount || 0, // Default to 0 if null or undefined
    likeCount: stat.likeCount || 0, // Default to 0 if null or undefined
    commentCount: stat.commentCount || 0, // Default to 0 if null or undefined
  }));

  // Use autochunk to insert statistics in smaller chunks
  const insertedStats = await autochunk(
    statsWithDbIds,
    (chunk) => db.insert(videoStatistics).values(chunk).returning(),
  );

  return insertedStats.flat();
};

app.get('/', async (c) => {
  const apiKey = c.env.apiKey;
  const startTime = Date.now();
  const channelUrl = c.req.query('url');

  if (!channelUrl) {
    return c.text("URL or username is missing");
  }

  const username = extractUsername(channelUrl);

  if (!username) {
    return c.text("Invalid input (either a YouTube URL or a username is required)");
  }

  const uploadsChannelId = await getUploadsChannelId(apiKey, username);

  if (!uploadsChannelId) {
    return c.text("Unable to fetch uploads channel ID.");
  }

  const videos = await getPlaylistVideos(apiKey, uploadsChannelId);

  if (videos.length === 0) {
    return c.text("No videos found in the playlist.");
  }

  const videoIds = videos.map(video => video.videoId);
  const stats = await batchGetVideoStatistics(apiKey, videoIds);
  const channel = await insertChannel(username, c);

  const videosInsertData = videos.map(video => ({
    videoId: video.videoId,
    channelId: channel.id,
    title: video.videoTitle,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    thumbnailUrl: video.thumbnailUrl
  }));

  // Insert videos and get a map of videoId to database ID
  const videoIdMap = await batchInsertVideos(videosInsertData, c);

  const statsInsertData = stats.map(stat => ({
    videoId: stat.videoId,
    viewCount: stat.viewCount,
    likeCount: stat.likeCount,
    commentCount: stat.commentCount
  }));

  // Insert statistics using the videoId map
  await batchInsertVideoStatistics(statsInsertData, videoIdMap, c);

  const videosWithStats = videos.map(video => {
    const stat = stats.find(s => s.videoId === video.videoId);
    return {
      videoID: video.videoId,
      channelName: username,
      title: video.videoTitle,
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      viewCount: stat?.viewCount || "N/A",
      likeCount: stat?.likeCount || "N/A",
      commentCount: stat?.commentCount || "N/A",
      thumbnailUrl: video.thumbnailUrl
    };
  });

  const endTime = Date.now();
  const elapsedTime = endTime - startTime;

  const jsonResponse = {
    status: '200 OK',
    totalVideos: videosWithStats.length,
    elapsedTime,
    videos: videosWithStats
  };

  return c.text(JSON.stringify(jsonResponse, null, 2), 200, {
    'Content-Type': 'application/json'
  });
});

export default app;