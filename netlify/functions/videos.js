// Netlify Function: fetch EverlastAI videos server-side (no CORS issues)
// Primary: YouTube RSS feed (always works, 15 videos)
// Fallback extras: Invidious instances (more videos if any are up)

const CHANNEL_ID = 'UC8T5gQ4U4GbI2h8kYCkEcvg';
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://invidious.slipfox.xyz',
];

// Parse YouTube RSS XML without external dependencies
function parseRSS(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const videoId   = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title     = (entry.match(/<title>([^<]+)<\/title>/) || [])[1];
    const published = (entry.match(/<published>([^<]+)<\/published>/) || [])[1];
    const thumb     = (entry.match(/<media:thumbnail url="([^"]+)"/) || [])[1];
    if (!videoId) continue;
    videos.push({
      id:          videoId,
      title:       title ? title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : '',
      publishedAt: published || '',
      thumbnail:   thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    });
  }
  return videos;
}

// Try a single Invidious instance for extra videos (pages 2+)
async function tryInvidious(instance, page = 1) {
  const url = `${instance}/api/v1/channels/${CHANNEL_ID}/videos?page=${page}&sort_by=newest`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data.videos)) throw new Error('No videos array');
  return data.videos.map(v => ({
    id:          v.videoId,
    title:       v.title || '',
    publishedAt: v.published ? new Date(v.published * 1000).toISOString() : '',
    thumbnail:   `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
  }));
}

exports.handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=900', // 15 min cache
    'Access-Control-Allow-Origin': '*',
  };

  try {
    // Always fetch YouTube RSS first (reliable, 15 videos)
    const rssRes = await fetch(RSS_URL, { signal: AbortSignal.timeout(8000) });
    if (!rssRes.ok) throw new Error(`RSS HTTP ${rssRes.status}`);
    const xml = await rssRes.text();
    const rssVideos = parseRSS(xml);

    if (!rssVideos.length) throw new Error('RSS returned no videos');

    // Try to get more videos from Invidious (pages 1-7, up to ~140 more)
    let extra = [];
    for (const inst of INVIDIOUS_INSTANCES) {
      try {
        let page = 1;
        while (extra.length < 140) {
          const batch = await tryInvidious(inst, page);
          if (!batch.length) break;
          extra = extra.concat(batch);
          if (batch.length < 20) break;
          page++;
        }
        if (extra.length > 0) break; // got extras from this instance
      } catch (_) {
        // try next instance
      }
    }

    // Merge: RSS videos are most recent, Invidious may overlap
    // Deduplicate by video ID, keep RSS data for the first 15 (fresher thumbnails)
    const seen = new Set(rssVideos.map(v => v.id));
    const merged = [...rssVideos];
    for (const v of extra) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        merged.push(v);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ videos: merged, source: extra.length ? 'rss+invidious' : 'rss' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
