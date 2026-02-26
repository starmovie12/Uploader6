export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';

async function sendTelegram(msg: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' }),
    });
  } catch {}
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();

  try {
    // Pick 1 pending item — movies first, then webseries
    let doc: any = null;
    let col = '';

    const mSnap = await db.collection('movies_queue').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(1).get();
    if (!mSnap.empty) { doc = mSnap.docs[0]; col = 'movies_queue'; }
    else {
      const wSnap = await db.collection('webseries_queue').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(1).get();
      if (!wSnap.empty) { doc = wSnap.docs[0]; col = 'webseries_queue'; }
    }

    if (!doc) return NextResponse.json({ status: 'idle', message: 'Queue empty' });

    const item = { id: doc.id, ...doc.data() } as any;

    // Lock it
    await db.collection(col).doc(item.id).update({ status: 'processing', lockedAt: new Date().toISOString() });

    const base = process.env.NEXT_PUBLIC_BASE_URL!;
    const taskRes = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url }),
    });

    if (!taskRes.ok) throw new Error(`/api/tasks HTTP ${taskRes.status}`);
    const taskData = await taskRes.json();
    if (taskData.error) throw new Error(taskData.error);

    const taskId = taskData.taskId;

    // Fetch and solve links
    const listRes = await fetch(`${base}/api/tasks`);
    const taskList = await listRes.json();
    const newTask = Array.isArray(taskList) ? taskList.find((t: any) => t.id === taskId) : null;

    let success = false;
    if (newTask?.links?.length > 0) {
      const pending = newTask.links.map((l: any, i: number) => ({ ...l, _idx: i })).filter((l: any) => {
        const s = (l.status || '').toLowerCase();
        return s === 'pending' || s === '' || s === 'processing';
      });
      if (pending.length > 0) {
        const solveRes = await fetch(`${base}/api/stream_solve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ links: pending.map((l: any) => ({ id: l._idx, name: l.name, link: l.link })), taskId }),
        });
        if (solveRes.ok && solveRes.body) {
          const reader = solveRes.body.getReader();
          const dec = new TextDecoder();
          let buf = '', ok = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const l of lines) {
              try { const d = JSON.parse(l); if (d.status === 'done') ok++; } catch {}
            }
          }
          success = ok > 0;
        }
      } else { success = true; }
    }

    await db.collection(col).doc(item.id).update({
      status: success ? 'completed' : 'failed',
      processedAt: new Date().toISOString(),
      taskId,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const title = taskData.preview?.title || item.title || item.url;

    await sendTelegram(success
      ? `✅ <b>Auto-Pilot</b>\n🎬 ${title}\n⏱ ${elapsed}s`
      : `❌ <b>Auto-Pilot Failed</b>\n🎬 ${title}`
    );

    return NextResponse.json({ status: success ? 'completed' : 'failed', title, elapsed });
  } catch (e: any) {
    await sendTelegram(`🚨 <b>CRON ERROR</b>\n${e.message}`);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
