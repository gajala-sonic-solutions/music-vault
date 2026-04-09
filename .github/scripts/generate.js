/**
 * generate.js
 * ============================================================
 * Runs inside GitHub Actions after a release event.
 *
 * What it does:
 *   1. Fetches ALL releases from the music-vault repo via GitHub API
 *      (authenticated → 5000 req/hr, no rate-limit concern)
 *   2. For each release, builds albums/<tag>.json from the release assets
 *   3. Rebuilds index.json with every album's summary
 *
 * How to encode album metadata in your release:
 * ─────────────────────────────────────────────
 *   Release title  → "Artist - Album (Year)"   ← parsed automatically
 *   Release body   → key: value pairs           ← override if needed
 *
 *   Example release title:
 *     Shashwat Sachdev - Dhurandhar (2025)
 *
 *   Example release body (optional overrides):
 *     artist: Shashwat Sachdev
 *     year: 2025
 *
 * Audio file detection:
 *   Any asset whose extension is one of:
 *   .m4a .mp3 .flac .wav .ogg .aac .opus
 *   is treated as a track.
 *
 * Track ordering:
 *   Sorted by leading track number in filename.
 *   "01.-.Name.m4a" → track 1, "12.-.Name.m4a" → track 12
 *
 * Cover image:
 *   Any asset named cover.jpg / cover.png / cover.webp
 * ============================================================
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Config ───────────────────────────────────────────────────

const REPO      = process.env.GITHUB_REPOSITORY;  // "Bharadwaja1557/music-vault"
const GH_TOKEN  = process.env.GH_TOKEN;
const [OWNER, REPO_NAME] = REPO.split('/');

const AUDIO_EXTS  = new Set(['.m4a', '.mp3', '.flac', '.wav', '.ogg', '.aac', '.opus', '.m4b']);
// Files to separate into their own arrays for pairing
const M4A_EXTS   = new Set(['.m4a', '.aac', '.mp3', '.ogg', '.opus', '.wav', '.m4b']);
const FLAC_EXTS  = new Set(['.flac']);
const COVER_NAMES = new Set(['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp']);

const ALBUMS_DIR = path.join(__dirname, '../../albums');
const INDEX_FILE = path.join(__dirname, '../../index.json');

// ── GitHub API helper ────────────────────────────────────────

function ghFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method: 'GET',
      headers: {
        'Authorization':        `Bearer ${GH_TOKEN}`,
        'Accept':               'application/vnd.github+json',
        'User-Agent':           'git-play-generator/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode}: ${body}`));
        } else {
          resolve(JSON.parse(body));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Paginate through all releases (handles repos with >100 releases)
async function fetchAllReleases() {
  const releases = [];
  let page = 1;

  while (true) {
    const batch = await ghFetch(
      `/repos/${OWNER}/${REPO_NAME}/releases?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return releases;
}

// ── Metadata parsers ─────────────────────────────────────────

/**
 * Parse "key: value" pairs from the release body.
 * Supports: artist, year
 */
function parseReleaseBody(body) {
  const meta = {};
  if (!body) return meta;

  for (const line of body.split('\n')) {
    const match = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (match) {
      const key   = match[1].toLowerCase().trim();
      const value = match[2].trim();
      if (key === 'artist') meta.artist = value;
      if (key === 'year')   meta.year   = parseInt(value, 10) || value;
    }
  }

  return meta;
}

/**
 * Parse "Artist - Album (Year)" from the release title.
 * Falls back gracefully if the format doesn't match.
 */
function parseReleaseTitle(title) {
  if (!title) return {};

  const match = title.match(/^(.*?)\s*-\s*(.*?)\s*\((\d{4})\)$/);
  if (!match) return {};

  return {
    artist: match[1].trim(),
    album:  match[2].trim(),
    year:   parseInt(match[3], 10),
  };
}

// ── Track number extractor ───────────────────────────────────

/**
 * "01.-.Title.Track.m4a" → 1
 * "12.-.Slow.Burn.m4a"   → 12
 * "random-name.mp3"      → fallback
 */
function extractTrackNum(filename, fallback) {
  const match = filename.match(/^(\d{1,3})[.\-_\s]/);
  return match ? parseInt(match[1], 10) : fallback;
}

// ── Asset classifier ─────────────────────────────────────────

function classifyAssets(assets) {
  const tracks = [];
  let   cover  = null;

  // Sort by track number so order is always correct
  const sorted = [...assets].sort((a, b) =>
    extractTrackNum(a.name, 999) - extractTrackNum(b.name, 999)
  );

  for (const asset of sorted) {
    const lc  = asset.name.toLowerCase();
    const ext = path.extname(lc);

    if (COVER_NAMES.has(lc)) {
      cover = asset.name;  // preserve original casing
      continue;
    }

    if (AUDIO_EXTS.has(ext)) {
      tracks.push(asset.name);
    }
  }

  return { tracks, cover };
}

// ── Song filename parser ─────────────────────────────────────

/**
 * v2 format: "01.--.Song.Name.--.Singer.1.&.Singer.2.m4a"
 *   → { title: "Song Name", singers: ["Singer 1", "Singer 2"] }
 * v1 legacy: "01.-.Song.Name.-.Singer.m4a"
 *   → { title: "Song Name", singers: ["Singer"] }
 */
function parseSongFilename(filename) {
  const name = filename.replace(/\.[^.]+$/, '');

  if (name.includes('.--.')){
    const parts = name.split(/\.--\./).map(p => p.replace(/\./g, ' ').trim());
    const hasNum = /^\d{1,3}$/.test(parts[0]);
    const titleIdx  = hasNum ? 1 : 0;
    const singersRaw = hasNum ? parts.slice(2) : parts.slice(1);
    const title   = parts[titleIdx] || '';
    const singers = singersRaw.length > 0
      ? singersRaw.join(' ').split(/\s*&\s*/).map(s => s.trim()).filter(Boolean)
      : [];
    return { title, singers };
  }

  // v1 legacy
  const parts = name.split(/\.-\./).map(p => p.replace(/\./g, ' ').trim());
  if (parts.length <= 1) return { title: parts[0].replace(/^\d{1,3}\s*-?\s*/, '').trim(), singers: [] };
  const hasNum = /^\d{1,3}$/.test(parts[0]);
  if (parts.length === 2) return { title: hasNum ? parts[1] : parts[0], singers: [] };
  if (hasNum) return { title: parts.slice(1, -1).join(' - '), singers: [parts[parts.length - 1]] };
  return { title: parts[0], singers: parts.slice(1) };
}

// ── Build album JSON ─────────────────────────────────────────

function buildAlbumJson(release, meta, tracks, cover) {
  const parsed     = parseReleaseTitle(release.name);
  const releaseTag = release.tag_name;

  // Priority: body keys  →  parsed title  →  fallbacks
  const artist     = meta.artist   || parsed.artist || 'Unknown Artist';
  const albumTitle = parsed.album  || release.name  || releaseTag;
  const year       = meta.year     || parsed.year   || new Date(release.published_at).getFullYear();

  // Pair M4A and FLAC files by track number
  const m4aFiles  = tracks.filter(f => /\.m4a$/i.test(f));
  const flacFiles = tracks.filter(f => /\.flac$/i.test(f));

  // Build a map: trackNum → flac filename
  const flacByNum = {};
  flacFiles.forEach(f => {
    const num = extractTrackNum(f, null);
    if (num !== null) flacByNum[num] = f;
  });

  const trackList = m4aFiles
    .map((filename, i) => {
      const parsed  = parseSongFilename(filename);
      const trackNum = extractTrackNum(filename, i + 1);
      const flacFile = flacByNum[trackNum] || null;
      return {
        track:   trackNum,
        file:    filename,
        flac:    flacFile,               // null if no FLAC uploaded
        title:   parsed.title,
        singers: parsed.singers.join(' & '),  // store as string, & separated
      };
    })
    .sort((a, b) => a.track - b.track);

  return {
    artist,
    album:     albumTitle,
    year,
    releaseTag,
    cover:     cover || null,
    tracks:    trackList,
  };
}

// ── Build index entry ────────────────────────────────────────

function buildIndexEntry(release, albumJson) {
  const [owner, repo] = REPO.split('/');
  const tag   = release.tag_name;
  const cover = albumJson.cover
    ? `https://github.com/${owner}/${repo}/releases/download/${tag}/${albumJson.cover}`
    : null;

  return {
    id:     tag,
    artist: albumJson.artist,
    title:  albumJson.album,
    year:   albumJson.year,
    cover,
  };
}

// ── File helpers ─────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`  ✔ Written: ${path.relative(process.cwd(), filePath)}`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎵 git-play index generator`);
  console.log(`   Repo: ${REPO}\n`);

  ensureDir(ALBUMS_DIR);

  // 1. Fetch all releases
  console.log('📡 Fetching releases from GitHub API…');
  const releases  = await fetchAllReleases();
  const published = releases.filter(r => !r.draft);
  console.log(`   Found ${published.length} published release(s)\n`);

  if (published.length === 0) {
    console.log('⚠️  No published releases found. Writing empty index.');
    writeJson(INDEX_FILE, { albums: [] });
    return;
  }

  const indexAlbums = [];

  // 2. Process each release
  for (const release of published) {
    const tag = release.tag_name;
    console.log(`🎶 Processing: "${release.name}" (tag: ${tag})`);

    const meta = parseReleaseBody(release.body);
    console.log(`   Artist: ${meta.artist || '(from title or fallback)'}`);
    console.log(`   Year:   ${meta.year   || '(from title or release date)'}`);

    const { tracks, cover } = classifyAssets(release.assets);
    console.log(`   Tracks: ${tracks.length}  |  Cover: ${cover || 'none'}`);

    if (tracks.length === 0) {
      console.log(`   ⚠️  No audio files — skipping.\n`);
      continue;
    }

    const albumJson  = buildAlbumJson(release, meta, tracks, cover);
    const albumFile  = path.join(ALBUMS_DIR, `${tag}.json`);
    writeJson(albumFile, albumJson);

    indexAlbums.push(buildIndexEntry(release, albumJson));
    console.log();
  }

  // 3. Sort newest first
  indexAlbums.sort((a, b) => (b.year || 0) - (a.year || 0));

  // 4. Write index.json
  console.log('📋 Writing index.json…');
  writeJson(INDEX_FILE, { albums: indexAlbums });

  // 5. Remove orphaned album JSONs (from deleted releases)
  const validTags    = new Set(published.map(r => r.tag_name));
  const existingFiles = fs.readdirSync(ALBUMS_DIR).filter(f => f.endsWith('.json'));

  for (const file of existingFiles) {
    const tag = file.replace('.json', '');
    if (!validTags.has(tag)) {
      fs.unlinkSync(path.join(ALBUMS_DIR, file));
      console.log(`🗑  Removed orphaned: albums/${file}`);
    }
  }

  console.log('\n✅ Done!\n');
}

main().catch(err => {
  console.error('\n❌ Generator failed:', err.message);
  process.exit(1);
});
