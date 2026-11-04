// Tonoz AI Ofisi - 7/24 Arka Plan Motoru (Otomatik Model Zinciri / Failover)
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT eksik!');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const todayKey = () => new Date().toISOString().slice(0, 10);

const MODEL_CHAINS = {
  'Gemini 3.5 Flash Lite': ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'],
  'Gemini 3.1 Flash Lite': ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'],
  'Gemini 3.8 Flash':      ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  'Gemini 3.6 Flash':      ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  'Gemini 3 Flash':        ['gemini-3-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  'Gemini 2.5 Flash':      ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'],
  'Antigravity':           ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash']
};

async function callWithFailover(apiKey, agent, sysPrompt, userPrompt) {
  const pChain = MODEL_CHAINS[agent.model] || MODEL_CHAINS['Gemini 3.5 Flash Lite'];
  const bChain = MODEL_CHAINS[agent.backup] || MODEL_CHAINS['Gemini 3.1 Flash Lite'];
  const chain = [...new Set([...pChain, ...bChain, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'])];

  for (const apiModel of chain) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sysPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
        })
      });

      if (res.status === 429 || res.status === 503 || res.status === 404) {
        console.log(`⚠️ ${apiModel} (${res.status}) verdi, anında sıradaki modele geçiliyor...`);
        continue;
      }
      if (!res.ok) continue;

      const data = await res.json();
      let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      raw = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      return JSON.parse(raw);
    } catch (e) {
      continue;
    }
  }
  throw new Error('Hiçbir modelden yanıt alınamadı.');
}

async function runWorker() {
  const secretSnap = await db.doc('settings/secret').get();
  const apiKey = (secretSnap.exists && secretSnap.data().apiKey) ? secretSnap.data().apiKey.trim() : process.env.GEMINI_API_KEY;
  if (!apiKey) return console.log('API Key bulunamadı.');

  const mailsSnap = await db.collection('mails').where('processed', '==', false).get();
  if (mailsSnap.empty) return console.log('Bekleyen görev yok.');

  const nowMs = Date.now();
  const pending = mailsSnap.docs
    .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
    .filter(m => m.to && m.to !== 'owner' && (!m.notBefore || m.notBefore.toMillis() <= nowMs))
    .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));

  if (!pending.length) return console.log('Görevlerin mola süresi devam ediyor.');

  const mail = pending[0];
  const [staffSnap, filesSnap] = await Promise.all([
    db.collection('staff').get(),
    db.collection('files').orderBy('updatedAt', 'desc').limit(4).get()
  ]);

  const staffList = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const filesList = filesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const agent = staffList.find(s => s.id === mail.to || s.name === mail.to);

  if (!agent) return await mail.ref.update({ processed: true });

  const directory = staffList.map(s => `- ID: "${s.id}" | ${s.name} (${s.role}): ${s.skills || ''}`).join('\n');
  const filesOverview = filesList.map(f => `Dosya: ${f.path}\n${(f.content || '').slice(0, 2500)}`).join('\n===\n') || 'Yok';

  const sysPrompt = `Sen Tonoz AI Ofisi'nde "${agent.name}" (${agent.role}) olarak çalışıyorsun.
Şirket Rehberi:\n${directory}\n- Şirket Sahibi ID: "owner" (Burak Bey).
Sadece JSON döndür:
{"fileToSave":{"path":"","kind":"md","content":""},"outgoingMails":[{"toAgentId":"","subject":"","body":"","type":"görev"}]}`;

  const decision = await callWithFailover(apiKey, agent, sysPrompt, `Konu: ${mail.subject}\nMesaj: ${mail.body}\n\nOrtak Klasör:\n${filesOverview}`);

  if (decision.fileToSave && decision.fileToSave.path && decision.fileToSave.content) {
    await db.collection('files').add({
      path: decision.fileToSave.path,
      content: decision.fileToSave.content,
      kind: decision.fileToSave.kind || 'md',
      owner: `${agent.name} · ${agent.role}`,
      version: 1,
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp()
    });
  }

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
      notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + (i + 1) * 35000),
      createdAt: FV.serverTimestamp()
    });
  }

  await mail.ref.update({ processed: true, readAt: FV.serverTimestamp() });
  console.log(`✅ Tamamlandı: ${agent.name}`);
}

runWorker().catch(console.error);
