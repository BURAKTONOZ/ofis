// Tonoz AI Ofisi - 7/24 Arka Plan Motoru (Dinamik Model Keşifli & Takılma Korumalı)
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log('FIREBASE_SERVICE_ACCOUNT secret eksik.');
  process.exit(0);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

async function getWorkingModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) return ['gemini-2.5-flash'];
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''));
}

async function runWorker() {
  // API Anahtarını doğrudan Firestore settings/secret kasasından çek
  const secretSnap = await db.doc('settings/secret').get();
  const apiKey = process.env.GEMINI_API_KEY || (secretSnap.exists ? secretSnap.data().apiKey : '');
  if (!apiKey) {
    console.log('API anahtarı bulunamadı.');
    return;
  }

  const validModels = await getWorkingModels(apiKey);
  const chosenApiModel = validModels.find(m => m.includes('flash-lite'))
                      || validModels.find(m => m.includes('flash'))
                      || validModels[0]
                      || 'gemini-2.5-flash';

  const mailsSnap = await db.collection('mails').where('processed', '==', false).limit(10).get();
  if (mailsSnap.empty) {
    console.log('Bekleyen görev yok.');
    return;
  }

  const nowMs = Date.now();
  const mailDoc = mailsSnap.docs.find(d => {
    const m = d.data();
    return m.to !== 'owner' && (!m.notBefore || m.notBefore.toMillis() <= nowMs);
  });

  if (!mailDoc) {
    console.log('Görevlerin dinlenme süresi devam ediyor.');
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

  const directory = staffList.map(s => `- ID: "${s.id}" | ${s.name} (${s.role}): ${s.skills || ''}`).join('\n');
  const sysPrompt = `Sen Tonoz AI Ofisi'nde "${agent.name}" (${agent.role}) olarak görev yapıyorsun.
Şirket Rehberi:\n${directory}\n- Şirket Sahibi ID: "owner" (Burak Bey).
Sadece JSON döndür:
{"fileToSave":{"path":"","kind":"md","content":""},"outgoingMails":[{"toAgentId":"","subject":"","body":"","type":"görev"}]}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${chosenApiModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sysPrompt }] },
      contents: [{ role: 'user', parts: [{ text: `Konu: ${mail.subject}\nMesaj: ${mail.body}` }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
    })
  });

  if (!res.ok) {
    // Hata alırsa görevi 3 dakika ileri at (Takılmayı önler)
    await mailDoc.ref.update({
      notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + 180000)
    });
    console.log(`API (${chosenApiModel}) hata verdi (${res.status}), görev 3 dk ertelendi.`);
    return;
  }

  const data = await res.json();
  let txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  txt = txt.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const decision = JSON.parse(txt);

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
      notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + (i + 1) * 70000),
      createdAt: FV.serverTimestamp()
    });
  }

  await mailDoc.ref.update({ processed: true, readAt: FV.serverTimestamp() });
  console.log(`Görev tamamlandı: ${agent.name}`);
}

runWorker().catch(console.error);
