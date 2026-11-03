// Tonoz AI Ofisi - 7/24 Otonom GitHub Actions Arka Plan Motoru
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.GEMINI_API_KEY) {
  console.log('FIREBASE_SERVICE_ACCOUNT veya GEMINI_API_KEY tanımlı değil, çıkılıyor.');
  process.exit(0);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const MODEL_MAP = {
  'Gemini 3.8 Flash':      { api: 'gemini-2.5-flash',      limit: 20 },
  'Gemini 3.6 Flash':      { api: 'gemini-2.5-flash',      limit: 20 },
  'Gemini 3 Flash':        { api: 'gemini-2.5-flash',      limit: 20 },
  'Gemini 2.5 Flash':      { api: 'gemini-2.5-flash',      limit: 20 },
  'Gemini 3.5 Flash Lite': { api: 'gemini-2.5-flash-lite', limit: 500 },
  'Gemini 3.1 Flash Lite': { api: 'gemini-2.5-flash-lite', limit: 500 },
  'Gemma 4 31B':           { api: 'gemini-2.5-flash-lite', limit: 14400 }
};

async function runSingleTick() {
  const guardSnap = await db.doc('settings/guard').get();
  const guard = guardSnap.exists ? guardSnap.data() : {};
  if (guard.paused) {
    console.log('Sistem yönetici tarafından duraklatılmış (paused=true).');
    return;
    }

  // Bekleyen en eski maili al
  const nowTs = admin.firestore.Timestamp.now();
  const mailsSnap = await db.collection('mails')
    .where('processed', '==', false)
    .orderBy('createdAt', 'asc')
    .limit(5)
    .get();

  if (mailsSnap.empty) {
    console.log('Bekleyen görev/yazışma yok. Personel dinleniyor.');
    return;
  }

  const mailDoc = mailsSnap.docs.find(d => {
    const data = d.data();
    if (data.to === 'owner') return false;
    if (data.notBefore && data.notBefore.toMillis() > nowTs.toMillis()) return false;
    return true;
  });

  if (!mailDoc) {
    console.log('Sıradaki görevlerin mola süresi (notBefore) henüz dolmadı.');
    return;
  }

  const mail = { id: mailDoc.id, ...mailDoc.data() };
  const staffSnap = await db.collection('staff').get();
  const staffList = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const agent = staffList.find(s => s.id === mail.to || s.name === mail.to);

  if (!agent) {
    await mailDoc.ref.update({ processed: true });
    return;
  }

  // Günlük kota kontrolü
  const today = new Date().toISOString().slice(0, 10);
  const usageRef = db.collection('usage').doc(today);
  const usageSnap = await usageRef.get();
  const pools = (usageSnap.exists && usageSnap.data().pools) ? usageSnap.data().pools : {};

  let chosenName = agent.model || 'Gemini 3.1 Flash Lite';
  let cfg = MODEL_MAP[chosenName] || MODEL_MAP['Gemini 3.1 Flash Lite'];
  if ((pools[chosenName] || 0) >= cfg.limit) {
    chosenName = agent.backup || 'Gemma 4 31B';
    cfg = MODEL_MAP[chosenName] || MODEL_MAP['Gemma 4 31B'];
    if ((pools[chosenName] || 0) >= cfg.limit) {
      console.log(`${agent.name} için tüm model kotaları dolu.`);
      return;
    }
  }

  const filesSnap = await db.collection('files').orderBy('updatedAt', 'desc').limit(4).get();
  const filesOverview = filesSnap.docs.map(d => {
    const f = d.data();
    return `Dosya: ${f.path} (Yazan: ${f.owner})\n${(f.content || '').slice(0, 3000)}`;
  }).join('\n===\n') || 'Ortak klasör boş.';

  const directory = staffList.map(s =>
    `- ID: "${s.id}" | İsim: ${s.name} | Rol: ${s.role} | Uzmanlık: ${s.skills || ''}`
  ).join('\n');

  const systemInstruction = `Sen Tonoz AI Ofisi'nde çalışan "${agent.name}" (${agent.role}) isimli yapay zeka personelsin.
Uzmanlığın: ${agent.skills || ''}
Şirket Personel Rehberi:
${directory}
- Şirket Sahibi ID: "owner" (Burak Bey).
Kurumsal İstanbul Türkçesi (Bey/Hanım) kullan. Sadece JSON döndür:
{
  "fileToSave": { "path": "", "kind": "md", "content": "" },
  "outgoingMails": [ { "toAgentId": "", "subject": "", "body": "", "type": "görev" } ]
}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.api}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: `Konu: ${mail.subject}\nMesaj:\n${mail.body}\n\nOrtak Klasör:\n${filesOverview}` }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
    })
  });

  if (!res.ok) throw new Error('Gemini API Hatası: ' + res.status);
  const data = await res.json();
  const decision = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');

  // Kotayı artır
  pools[chosenName] = (pools[chosenName] || 0) + 1;
  await usageRef.set({ updatedAt: FV.serverTimestamp(), pools }, { merge: true });

  // Dosya varsa kaydet
  if (decision.fileToSave && decision.fileToSave.path && decision.fileToSave.content) {
    await db.collection('files').add({
      path: decision.fileToSave.path,
      content: decision.fileToSave.content,
      kind: decision.fileToSave.kind || 'md',
      owner: agent.name,
      version: 1,
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp()
    });
  }

  // Yeni mailleri oluştur (5 dakika mola ekleyerek)
  const cooldownMs = (guard.cooldownSec || 120) * 1000;
  for (let i = 0; i < (decision.outgoingMails || []).length; i++) {
    const out = decision.outgoingMails[i];
    if (!out.toAgentId || !out.body) continue;
    await db.collection('mails').add({
      from: agent.id,
      to: out.toAgentId,
      subject: out.subject || ('Görev: ' + mail.subject),
      body: out.body,
      type: out.type || 'görev',
      threadId: mail.threadId || mail.id,
      processed: out.toAgentId === 'owner',
      notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + (i + 1) * cooldownMs),
      createdAt: FV.serverTimestamp()
    });
  }

  await mailDoc.ref.update({ processed: true, readAt: FV.serverTimestamp() });
  console.log(`Başarıyla işlendi: ${agent.name} -> ${mail.subject}`);
}

runSingleTick().catch(e => { console.error(e); process.exit(1); });
