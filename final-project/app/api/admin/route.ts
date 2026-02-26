export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';

// Simple admin auth
function checkAuth(req: Request) {
  const key = req.headers.get('x-admin-key') || new URL(req.url).searchParams.get('key');
  return key === process.env.ADMIN_SECRET;
}

// GET /api/admin?action=stats|tasks|queue
export async function GET(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const action = new URL(req.url).searchParams.get('action') || 'stats';

  try {
    if (action === 'stats') {
      const [tasksSnap, mqSnap, wqSnap] = await Promise.all([
        db.collection('scraping_tasks').orderBy('createdAt', 'desc').limit(1).get(),
        db.collection('movies_queue').get(),
        db.collection('webseries_queue').get(),
      ]);

      const [completedSnap, failedSnap, processingSnap] = await Promise.all([
        db.collection('scraping_tasks').where('status', '==', 'completed').get(),
        db.collection('scraping_tasks').where('status', '==', 'failed').get(),
        db.collection('scraping_tasks').where('status', '==', 'processing').get(),
      ]);

      const mqPending = mqSnap.docs.filter(d => d.data().status === 'pending').length;
      const wqPending = wqSnap.docs.filter(d => d.data().status === 'pending').length;
      const mqDone = mqSnap.docs.filter(d => d.data().status === 'completed').length;
      const wqDone = wqSnap.docs.filter(d => d.data().status === 'completed').length;

      return NextResponse.json({
        tasks: {
          completed: completedSnap.size,
          failed: failedSnap.size,
          processing: processingSnap.size,
          total: completedSnap.size + failedSnap.size + processingSnap.size,
        },
        queue: {
          movies: { pending: mqPending, completed: mqDone, total: mqSnap.size },
          webseries: { pending: wqPending, completed: wqDone, total: wqSnap.size },
          totalPending: mqPending + wqPending,
        },
      });
    }

    if (action === 'tasks') {
      const limit = parseInt(new URL(req.url).searchParams.get('limit') || '20');
      const status = new URL(req.url).searchParams.get('status');
      let query: any = db.collection('scraping_tasks').orderBy('createdAt', 'desc').limit(limit);
      if (status) query = db.collection('scraping_tasks').where('status', '==', status).orderBy('createdAt', 'desc').limit(limit);
      const snap = await query.get();
      return NextResponse.json(snap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
    }

    if (action === 'queue') {
      const type = new URL(req.url).searchParams.get('type') || 'all';
      const items: any[] = [];
      if (type === 'all' || type === 'movies') {
        const s = await db.collection('movies_queue').orderBy('createdAt', 'desc').limit(50).get();
        s.docs.forEach(d => items.push({ id: d.id, collection: 'movies_queue', ...d.data() }));
      }
      if (type === 'all' || type === 'webseries') {
        const s = await db.collection('webseries_queue').orderBy('createdAt', 'desc').limit(50).get();
        s.docs.forEach(d => items.push({ id: d.id, collection: 'webseries_queue', ...d.data() }));
      }
      return NextResponse.json({ items, total: items.length });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/admin — delete task or queue item
export async function DELETE(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { id, collection } = await req.json();
    if (!id || !collection) return NextResponse.json({ error: 'id and collection required' }, { status: 400 });
    await db.collection(collection).doc(id).delete();
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PATCH /api/admin — update status
export async function PATCH(req: Request) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { id, collection, status } = await req.json();
    if (!id || !collection || !status) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    await db.collection(collection).doc(id).update({ status, updatedAt: new Date().toISOString() });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
