export const maxDuration = 60;
export const dynamic = 'force-dynamic';

import { db } from '@/lib/firebaseAdmin';
import {
  extractMovieLinks,
  solveHBLinks, solveHubCDN, solveHubDrive, solveHubCloudNative,
} from '@/lib/solvers';

const TIMER_API = 'http://85.121.5.246:10000/solve?url=';

const fetchJ = async (url: string) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' },
    });
    return await res.json();
  } finally { clearTimeout(t); }
};

async function solveOne(link: string, log: (m: string, t: string) => void) {
  let cur = link;
  try {
    if (cur.includes('hubcdn.fans')) {
      const r = await solveHubCDN(cur);
      return r.status === 'success' ? { status: 'done', finalLink: r.final_link } : { status: 'error', error: r.message };
    }
    const targets = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
    let n = 0;
    while (n < 3 && !targets.some(d => cur.includes(d))) {
      const isTimer = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some(x => cur.includes(x));
      if (!isTimer && n === 0) break;
      log('⏳ Timer bypass...', 'warn');
      try {
        const r = await fetchJ(TIMER_API + encodeURIComponent(cur));
        if (r.status === 'success') { cur = r.extracted_link; log('✅ Bypassed', 'success'); }
        else throw new Error(r.message);
      } catch (e: any) { log(`❌ ${e.message}`, 'error'); break; }
      n++;
    }
    if (cur.includes('hblinks')) {
      const r = await solveHBLinks(cur);
      if (r.status === 'success') { cur = r.link!; } else return { status: 'error', error: r.message };
    }
    if (cur.includes('hubdrive')) {
      const r = await solveHubDrive(cur);
      if (r.status === 'success') { cur = r.link!; } else return { status: 'error', error: r.message };
    }
    if (cur.includes('hubcloud') || cur.includes('hubcdn')) {
      const r = await solveHubCloudNative(cur);
      if (r.status === 'success' && r.best_download_link) {
        return { status: 'done', finalLink: r.best_download_link, buttonName: r.best_button_name };
      }
      return { status: 'error', error: r.message };
    }
    return { status: 'error', error: 'Unrecognized format' };
  } catch (e: any) { return { status: 'error', error: e.message }; }
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  let queueId: string, collection: string, sourceUrl: string, title: string, queueType: string;

  try {
    const b = await req.json();
    queueId = b.queueId; collection = b.collection; sourceUrl = b.url;
    title = b.title || 'Unknown'; queueType = b.type || 'movie';
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (!queueId || !collection || !sourceUrl) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(data) + '\n')); } catch {}
      };

      try {
        await db.collection(collection).doc(queueId).update({ status: 'processing', updatedAt: new Date().toISOString() });

        send({ step: 'extract', msg: `🔍 Scraping: ${title}...`, type: 'info' });
        const extracted = await extractMovieLinks(sourceUrl);

        if (extracted.status !== 'success' || !extracted.links?.length) {
          const err = extracted.message || 'No links found';
          send({ step: 'done', status: 'failed', error: err });
          await db.collection(collection).doc(queueId).update({ status: 'failed', error: err });
          controller.close(); return;
        }

        const { links, metadata, preview } = extracted;
        send({ step: 'extract', msg: `✅ Found ${links.length} links`, type: 'success', totalLinks: links.length });
        send({ step: 'solve', msg: `⚡ Solving ${links.length} links in PARALLEL...`, type: 'info' });

        // ── PARALLEL solving for SPEED ──
        const resolved = await Promise.all(links.map(async (l: any, i: number) => {
          const result = await solveOne(l.link, (m, t) => send({ step: 'solve', msg: `[${i+1}] ${m}`, type: t }));
          const ok = result.status === 'done';
          send({ step: 'solve', msg: ok ? `✅ [${i+1}] ${l.name} → DONE` : `❌ [${i+1}] ${l.name} → ${result.error}`, type: ok ? 'success' : 'error' });
          return { name: l.name, originalLink: l.link, finalLink: (result as any).finalLink || null, buttonName: (result as any).buttonName || null, status: result.status, error: result.error || null };
        }));

        const success = resolved.filter(r => r.status === 'done');
        if (success.length === 0) {
          send({ step: 'done', status: 'failed', error: 'All links failed' });
          await db.collection(collection).doc(queueId).update({ status: 'failed', error: 'All links failed' });
          controller.close(); return;
        }

        send({ step: 'save', msg: `💾 Saving ${success.length} links...`, type: 'info' });
        const mainCol = queueType === 'webseries' ? 'webseries' : 'movies';
        const doc = {
          title: preview?.title || title,
          posterUrl: preview?.posterUrl || null,
          sourceUrl, quality: metadata?.quality || 'Unknown',
          languages: metadata?.languages || 'Not Specified',
          audioLabel: metadata?.audioLabel || 'Unknown',
          type: queueType,
          downloadLinks: success.map(l => ({ name: l.name, link: l.finalLink, buttonName: l.buttonName })),
          allLinks: resolved, totalLinks: links.length,
          successfulLinks: success.length, failedLinks: resolved.length - success.length,
          status: 'active', createdAt: new Date().toISOString(),
          autoProcessed: true, queueRef: { id: queueId, collection },
        };

        const ref = await db.collection(mainCol).add(doc);
        await db.collection(collection).doc(queueId).update({
          status: 'completed', processedAt: new Date().toISOString(),
          savedTo: { collection: mainCol, id: ref.id },
        });

        send({ step: 'done', status: 'completed', savedId: ref.id, savedCollection: mainCol, title: doc.title, successfulLinks: success.length, failedLinks: resolved.length - success.length });
      } catch (e: any) {
        send({ step: 'done', status: 'failed', error: e.message });
        try { await db.collection(collection).doc(queueId).update({ status: 'failed', error: e.message }); } catch {}
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
