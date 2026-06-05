#!/usr/bin/env node
// Scrape https://dwao.com/blog for the latest post slugs (in visitor-facing
// reverse-chronological order), resolve each post's title and publication date
// from its page, and write the result into profile/README.md between the
// <!-- BLOG-POST-LIST:START --> / <!-- BLOG-POST-LIST:END --> markers.
//
// Why /blog and not sitemap.xml: the sitemap's <lastmod> reflects when a post
// was last *edited*, which makes recently-republished older posts look new.
// The /blog index renders posts in true published-date order.

import { readFile, writeFile } from "node:fs/promises";

const BLOG_INDEX_URL = "https://dwao.com/blog";
const README_PATH = "profile/README.md";
const MAX_POSTS = 5;
const START_MARKER = "<!-- BLOG-POST-LIST:START -->";
const END_MARKER = "<!-- BLOG-POST-LIST:END -->";
const POST_BASE = "https://dwao.com/blog/";

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

const titleCase = (slug) =>
  slug
    .split("-")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "dwao-github-profile-bot/1.0 (+https://github.com/dwaollp)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractOrderedSlugs(indexHtml) {
  const slugRe = /href="\/blog\/([a-z0-9][a-z0-9-]*)"/g;
  const seen = new Set();
  const ordered = [];
  let m;
  while ((m = slugRe.exec(indexHtml)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    ordered.push(slug);
  }
  return ordered;
}

function cleanTitle(title) {
  return title
    .replace(/\s*[|\-–—]\s*DWAO.*$/i, "")
    .replace(/\s*[|\-–—]\s*Blog.*$/i, "")
    .trim();
}

function extractTitle(html, fallbackSlug) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return cleanTitle(decodeEntities(og[1]));
  const tw = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
  if (tw) return cleanTitle(decodeEntities(tw[1]));
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (t) return cleanTitle(decodeEntities(t[1].trim()));
  return titleCase(fallbackSlug);
}

function extractPublishedDate(html) {
  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of candidates) {
        const date = findDatePublished(node);
        if (date) return date.slice(0, 10);
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  const meta = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i);
  if (meta) return meta[1].slice(0, 10);
  return "";
}

function findDatePublished(node) {
  if (!node || typeof node !== "object") return null;
  if (typeof node.datePublished === "string") return node.datePublished;
  if (Array.isArray(node["@graph"])) {
    for (const child of node["@graph"]) {
      const d = findDatePublished(child);
      if (d) return d;
    }
  }
  return null;
}

async function resolvePost(slug) {
  const url = `${POST_BASE}${slug}`;
  try {
    const html = await fetchText(url);
    return {
      title: extractTitle(html, slug),
      url,
      date: extractPublishedDate(html),
    };
  } catch (err) {
    console.warn(`post fetch failed for ${url}: ${err.message}`);
    return { title: titleCase(slug), url, date: "" };
  }
}

function renderList(posts) {
  if (!posts.length) return "_No posts found._";
  return posts
    .map((p) => `- [${p.title}](${p.url})${p.date ? ` — _${p.date}_` : ""}`)
    .join("\n");
}

function replaceBetweenMarkers(readme, payload) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("README markers not found");
  }
  const before = readme.slice(0, start + START_MARKER.length);
  const after = readme.slice(end);
  return `${before}\n${payload}\n${after}`;
}

async function main() {
  console.log(`Fetching ${BLOG_INDEX_URL}`);
  const indexHtml = await fetchText(BLOG_INDEX_URL);
  const slugs = extractOrderedSlugs(indexHtml).slice(0, MAX_POSTS);
  console.log(`Picked ${slugs.length} latest slugs: ${slugs.join(", ")}`);

  const resolved = [];
  for (const slug of slugs) {
    const r = await resolvePost(slug);
    console.log(`  • ${r.title} (${r.url}) ${r.date}`);
    resolved.push(r);
  }

  const readme = await readFile(README_PATH, "utf8");
  const updated = replaceBetweenMarkers(readme, renderList(resolved));

  if (updated === readme) {
    console.log("No changes to README");
    return;
  }

  await writeFile(README_PATH, updated, "utf8");
  console.log(`Wrote ${README_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
