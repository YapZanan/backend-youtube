import { Hono } from 'hono'


export type Env = {
  apiKey: string
}

const app = new Hono<{ Bindings: Env }>();
// Function to extract username dynamically
function extractUsername(input: string): string | null {
  const urlRegex = /^https?:\/\/(www\.)?youtube\.com\/(channel\/UC[\w-]{21}[AQgw]|(c\/|user\/)?[\w@-]+)$/;

  if (input.startsWith('@')) {
    return input;  // Return the username as is
  }

  const match = input.match(urlRegex);
  if (match) {
    const username = match[2];
    return username;
  }

  return null;
}

// Define types for the YouTube API response
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

// Function to get the uploads playlist ID from YouTube API
async function getUploadsChannelId(apiKey: string, username: string): Promise<string | null> {
  const url = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&forHandle=${username}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data: YouTubeChannelResponse = await response.json();

    if (data.items && data.items.length > 0) {
      const uploadsChannelId = data.items[0].contentDetails.relatedPlaylists.uploads;
      return uploadsChannelId;
    } else {
      throw new Error('No valid channel found');
    }
  } catch (error) {
    console.error('Error fetching uploads channel ID:', error);
    return null;
  }
}

// Function to get videos from the uploads playlist
async function getPlaylistVideos(apiKey: string, playlistId: string): Promise<any[]> {
  const url = `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}`;

  let videos: any[] = [];
  try {
    let nextPageToken: string | undefined = undefined;

    // Loop through pages of videos if there are more than 50
    do {
      const apiUrl = nextPageToken
        ? `${url}&pageToken=${nextPageToken}`
        : url;
      const response = await fetch(apiUrl);
      const data: PlaylistItemResponse = await response.json();

      // Extract video IDs, titles, and thumbnails from the response
      for (const item of data.items) {
        const videoTitle = item.snippet.title;
        const videoId = item.snippet.resourceId.videoId;
        const thumbnailUrl = item.snippet.thumbnails?.high?.url;

        // Push video data including thumbnail URL
        videos.push({ videoId, videoTitle, thumbnailUrl });
      }

      // Update nextPageToken for the next iteration if available
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);  // Continue if there are more pages

    return videos;
  } catch (error) {
    console.error('Error fetching playlist videos:', error);
    return [];
  }
}

// Function to get statistics for each batch of video IDs
async function getVideoStatistics(apiKey: string, videoIds: string[]): Promise<any[]> {
  const url = `https://youtube.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data: VideoStatisticsResponse = await response.json();

    // Check if the data.items array exists and has content
    if (!data.items || data.items.length === 0) {
      console.error('No video statistics found for the provided video IDs.');
      return videoIds.map(id => ({
        videoId: id,
        viewCount: 'N/A',
        likeCount: 'N/A',
        commentCount: 'N/A'
      }));
    }

    // Map the video statistics into the desired structure
    const stats = data.items.map(item => ({
      videoId: item.id,
      viewCount: item.statistics.viewCount,
      likeCount: item.statistics.likeCount,
      commentCount: item.statistics.commentCount,
    }));

    // Ensure that missing video statistics (from any missing IDs) return N/A
    return videoIds.map(id => {
      const stat = stats.find(s => s.videoId === id);
      return stat || {
        videoId: id,
        viewCount: 'N/A',
        likeCount: 'N/A',
        commentCount: 'N/A'
      };
    });

  } catch (error) {
    console.error('Error fetching video statistics:', error);
    return videoIds.map(id => ({
      videoId: id,
      viewCount: 'N/A',
      likeCount: 'N/A',
      commentCount: 'N/A'
    }));
  }
}

// Function to handle batch processing of video IDs
async function batchGetVideoStatistics(apiKey: string, videoIds: string[]): Promise<any[]> {
  const batchSize = 50;
  const batches = [];

  // Split the videoIds array into batches of 50
  for (let i = 0; i < videoIds.length; i += batchSize) {
    const batch = videoIds.slice(i, i + batchSize);
    batches.push(getVideoStatistics(apiKey, batch));
  }

  // Await all requests in parallel using Promise.all
  const results = await Promise.all(batches);
  return results.flat();  // Flatten the results into a single array
}

app.get('/', async (c) => {
  const apiKey = c.env.apiKey;  // Fetch the API key from the environment
  const startTime = Date.now();  // Start tracking time
  const channelUrl = c.req.query('url');  // Channel URL or username passed as query parameter

  if (!channelUrl) {
    return c.text("URL or username is missing");
  }

  const username = extractUsername(channelUrl);

  if (!username) {
    return c.text("Invalid input (either a YouTube URL or a username is required)");
  }

  // Get the uploads channel ID
  const uploadsChannelId = await getUploadsChannelId(apiKey, username);

  if (!uploadsChannelId) {
    return c.text("Unable to fetch uploads channel ID.");
  }

  // Get the videos from the uploads playlist
  const videos = await getPlaylistVideos(apiKey, uploadsChannelId);

  if (videos.length > 0) {
    // Get video statistics for the fetched videos in parallel
    const videoIds = videos.map(video => video.videoId);
    const stats = await batchGetVideoStatistics(apiKey, videoIds);

    // Combine video data with statistics and thumbnail URL
    const videosWithStats = videos.map(video => {
      const stat = stats.find(s => s.videoId === video.videoId);
      return {
        videoID: video.videoId, // Use videoID as the first field
        title: video.videoTitle,
        url: `https://www.youtube.com/watch?v=${video.videoId}`,
        viewCount: stat?.viewCount || "N/A",
        likeCount: stat?.likeCount || "N/A",
        commentCount: stat?.commentCount || "N/A",
        thumbnailUrl: video.thumbnailUrl // Include the thumbnail URL
      };
    });

    // Calculate the elapsed time
    const endTime = Date.now();
    const elapsedTime = endTime - startTime;

    // Pretty print the JSON response
    const jsonResponse = {
      status: '200 OK',
      totalVideos: videosWithStats.length,
      elapsedTime, // Include elapsed time in milliseconds
      videos: videosWithStats
    };

    // Return pretty-printed JSON response
    return c.text(JSON.stringify(jsonResponse, null, 2), 200, {
      'Content-Type': 'application/json'
    });
  } else {
    return c.text("No videos found in the playlist.");
  }
});


export default app;
