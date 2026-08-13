// Looks up book metadata (synopsis, genres, year) from open sources:
// Google Books first (best descriptions, no key needed), Open Library as
// fallback. Results are cached in the db by the caller, so each book is
// looked up once.

function cleanGenres(categories) {
  const out = [];
  for (const c of categories || []) {
    for (const part of String(c).split(' / ')) {
      const g = part.trim();
      if (g && g.toLowerCase() !== 'general' && !out.some(x => x.toLowerCase() === g.toLowerCase())) out.push(g);
    }
  }
  return out.slice(0, 4);
}

const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Free-text search for the upload screen's autofill.
export async function searchBooks(query) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=6&country=US`,
      { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const items = (await r.json()).items || [];
      const out = items.map(i => ({
        title: i.volumeInfo?.title || '',
        author: i.volumeInfo?.authors?.[0] || '',
        year: String(i.volumeInfo?.publishedDate || '').slice(0, 4),
      })).filter(x => x.title);
      if (out.length) return out;
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=6`,
      { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      return ((await r.json()).docs || []).map(d => ({
        title: d.title || '',
        author: d.author_name?.[0] || '',
        year: String(d.first_publish_year || ''),
      })).filter(x => x.title);
    }
  } catch { /* no luck */ }
  return [];
}

export async function fetchBookMeta(title, author) {
  try {
    const q = encodeURIComponent(`intitle:${title}${author ? ` inauthor:${author}` : ''}`);
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&country=US`,
      { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const v = (await r.json()).items?.[0]?.volumeInfo;
      if (v && (v.description || v.categories?.length)) {
        return {
          description: strip(v.description).slice(0, 2000),
          genres: cleanGenres(v.categories),
          year: String(v.publishedDate || '').slice(0, 4),
          source: 'Google Books',
        };
      }
    }
  } catch { /* fall through */ }

  try {
    const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}`
      + (author ? `&author=${encodeURIComponent(author)}` : '') + '&limit=1';
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const doc = (await r.json()).docs?.[0];
      if (doc) {
        let description = '';
        if (doc.key) {
          try {
            const w = await (await fetch(`https://openlibrary.org${doc.key}.json`, { signal: AbortSignal.timeout(10000) })).json();
            description = typeof w.description === 'string' ? w.description : w.description?.value || '';
          } catch { /* description optional */ }
        }
        return {
          description: strip(description).slice(0, 2000),
          genres: (doc.subject || []).slice(0, 4),
          year: String(doc.first_publish_year || ''),
          source: 'Open Library',
        };
      }
    }
  } catch { /* no luck */ }
  return null;
}
