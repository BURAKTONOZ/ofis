// ============================================================================
// TONOZ AI COMPANY - 7/24 OTONOM ARKA PLAN MOTORU (SADECE FIRESTORE)
// ============================================================================
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
  'Gemini 2.5 Pro':        { api: 'gemini-2.5-pro',        limit: 25,    rpm: 5 },
  'Gemini 2.5 Flash':      { api: 'gemini-2.5-flash',      limit: 250,   rpm: 10 },
  'Gemini 2.0 Flash':      { api: 'gemini-2.0-flash',      limit: 500,   rpm: 15 },
  'Gemini 2.5 Flash Lite': { api: 'gemini-2.5-flash-lite', limit: 1000,  rpm: 15 },
  'Gemini 2.0 Flash Lite': { api: 'gemini-2.0-flash-lite', limit: 1500,  rpm: 30 },
  'Gemma 3 27B':           { api: 'gemma-3-27b-it',        limit: 14400, rpm: 30 },
  'Gemini 3.8 Flash':      { api: 'gemini-2.5-flash',      limit: 250,   rpm: 10 },
  'Gemini 3.6 Flash':      { api: 'gemini-2.5-flash',      limit: 250,   rpm: 10 },
  'Gemini 3 Flash':        { api: 'gemini-2.5-flash',      limit: 250,   rpm: 10 },
  'Gemini 3.5 Flash Lite': { api: 'gemini-2.5-flash-lite', limit: 1000,  rpm: 15 },
  'Gemini 3.1 Flash Lite': { api: 'gemini-2.5-flash-lite', limit: 1000,  rpm: 15 },
  'Gemma 4 31B':           { api: 'gemini-2.5-flash-lite', limit: 14400, rpm: 30 }
};

const FALLBACK_CHAIN = [
  'Gemini 2.5 Flash',
  'Gemini 2.5 Flash Lite',
  'Gemini 2.0 Flash Lite',
  'Gemma 3 27B'
];

async function callGeminiWithFailover(candidates, systemInstruction, userText, pools) {
  let lastError = null;
  for (const modelName of candidates) {
    const cfg = MODEL_MAP[modelName] || MODEL_MAP['Gemini 2.5 Flash Lite'];
    if ((pools[modelName] || 0) >= cfg.limit) continue;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.api}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: { temperature: 0.35, responseMimeType: 'application/json' }
          })
        }
      );

      if (!res.ok) {
        const errBody = await res.text();
        lastError = new Error(`Model ${modelName} (${cfg.api}) HTTP ${res.status}: ${errBody.slice(0, 180)}`);
        continue;
      }

      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return { decision: JSON.parse(raw), usedModel: modelName };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Uygun model veya kota bulunamadı.');
}

async function runSingleTick() {
  const guardSnap = await db.doc('settings/guard').get();
  const guard = guardSnap.exists ? guardSnap.data() : {};
  if (guard.paused) {
    console.log('Sistem yönetici tarafından duraklatılmış (paused=true).');
    return;
  }

  const nowTs = admin.firestore.Timestamp.now();
  const mailsSnap = await db.collection('mails')
    .where('processed', '==', false)
    .orderBy('createdAt', 'asc')
    .limit(8)
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
    console.log('Sıradaki görevlerin mola süresi henüz dolmadı.');
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

  const today = new Date().toISOString().slice(0, 10);
  const usageRef = db.collection('usage').doc(today);
  const usageSnap = await usageRef.get();
  const pools = (usageSnap.exists && usageSnap.data().pools) ? usageSnap.data().pools : {};

  const candidates = [
    agent.model || 'Gemini 2.5 Flash Lite',
    agent.backup || 'Gemma 3 27B',
    ...FALLBACK_CHAIN
  ].filter((v, i, a) => a.indexOf(v) === i);

  const filesSnap = await db.collection('files').orderBy('updatedAt', 'desc').limit(5).get();
  const filesOverview = filesSnap.docs.map(d => {
    const f = d.data();
    return `Dosya: ${f.path} (Yazan: ${f.owner})\n${(f.content || '').slice(0, 3000)}`;
  }).join('\n===\n') || 'Ortak klasör boş.';

  const directory = staffList.map(s =>
    `- ID: "${s.id}" | İsim: ${s.name} | Rol: ${s.role} | Uzmanlık: ${s.skills || ''}`
  ).join('\n');

  const systemInstruction = `Sen Tonoz AI Company'de çalışan "${agent.name}" (${agent.role}) isimli yapay zeka personelsin.
Uzmanlığın: ${agent.skills || ''}
Şirket Personel Rehberi:
${directory}
- Şirket Sahibi ID: "owner" (Burak Bey).
Kurumsal İstanbul Türkçesi (Bey/Hanım) kullan.
Eğer Burak Bey 2D ofis sahnesine bir obje/dekorasyon/değişiklik veya site arayüzüne yeni bir özellik/menü/araç eklenmesini istediyse, aranızda planlayıp Kod/Tasarım aşamasında "officePatch" içindeki "sceneMods" (serbest 2.5D çizim kodu drawJs) veya "uiMods" (serbest HTML/CSS/JS) alanlarını doldurarak Burak Bey'in onayına sunun.
Sadece JSON döndür:
{
  "canvasBubble": "Kısa durum",
  "fileToSave": { "path": "", "kind": "md", "content": "" },
  "outgoingMails": [ { "toAgentId": "", "subject": "", "body": "", "type": "görev" } ],
  "officePatch": {
    "hasPatch": false,
    "title": "",
    "summary": "",
    "sceneMods": [
      { "id": "", "label": "", "depth": 12, "drawJs": "" }
    ],
    "uiMods": [
      { "id": "", "slot": "top-right | header-menu | floating-widget", "title": "", "html": "", "css": "", "js": "" }
    ]
  },
  "submitFinalApproval": { "ready": false, "summary": "" }
}`;

  const userText = `Konu: ${mail.subject}\nMesaj:\n${mail.body}\n\nOrtak Klasör:\n${filesOverview}`;
  const { decision, usedModel } = await callGeminiWithFailover(candidates, systemInstruction, userText, pools);

  pools[usedModel] = (pools[usedModel] || 0) + 1;
  await usageRef.set({ updatedAt: FV.serverTimestamp(), pools }, { merge: true });
  await db.collection('staff').doc(agent.id).set({
    usedToday: (agent.usedToday || 0) + 1,
    lastActionAt: FV.serverTimestamp()
  }, { merge: true });

  if (decision.fileToSave && decision.fileToSave.path && decision.fileToSave.content) {
    await db.collection('files').add({
      path: String(decision.fileToSave.path).slice(0, 240),
      content: String(decision.fileToSave.content).slice(0, 900000),
      kind: decision.fileToSave.kind || 'md',
      owner: `${agent.name} (${agent.role})`,
      version: 1,
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp()
    });
  }

  const hasPatch = decision.officePatch && decision.officePatch.hasPatch;
  const isFinal = decision.submitFinalApproval && decision.submitFinalApproval.ready;
  if (hasPatch || isFinal) {
    await db.collection('approvals').add({
      title: (decision.officePatch && decision.officePatch.title) || mail.subject || 'Çalışma Onayı',
      summary: (decision.officePatch && decision.officePatch.summary) || (decision.submitFinalApproval && decision.submitFinalApproval.summary) || 'Ekip çalışmayı tamamladı ve onayınıza sunar.',
      createdBy: `${agent.name} (${agent.role})`,
      status: 'pending',
      hasPatch: !!hasPatch,
      sceneMods: (decision.officePatch && Array.isArray(decision.officePatch.sceneMods)) ? decision.officePatch.sceneMods : [],
      uiMods: (decision.officePatch && Array.isArray(decision.officePatch.uiMods)) ? decision.officePatch.uiMods : [],
      threadId: mail.threadId || mail.id,
      createdAt: FV.serverTimestamp()
    });
  }

  const cooldownMs = (guard.cooldownSec || 65) * 1000;
  const validTypes = ['görev', 'rapor', 'soru', 'bilgi', 'onay'];
  for (let i = 0; i < (decision.outgoingMails || []).length; i++) {
    const out = decision.outgoingMails[i];
    if (!out.toAgentId || !out.body) continue;
    await db.collection('mails').add({
      from: agent.id,
      to: out.toAgentId,
      subject: String(out.subject || ('Görev: ' + mail.subject)).slice(0, 290),
      body: String(out.body).slice(0, 39000),
      type: validTypes.includes(out.type) ? out.type : 'görev',
      threadId: mail.threadId || mail.id,
      processed: out.toAgentId === 'owner',
      notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + (i + 1) * cooldownMs),
      createdAt: FV.serverTimestamp()
    });
  }

  await mailDoc.ref.update({ processed: true, readAt: FV.serverTimestamp() });
  console.log(`Başarıyla işlendi [${usedModel}]: ${agent.name} -> ${mail.subject}`);
}

runSingleTick().catch(e => { console.error(e); process.exit(1); });
