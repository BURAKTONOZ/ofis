// Tonoz AI Ofisi - 7/24 Otonom GitHub Actions Arka Plan Motoru
const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ HATA: FIREBASE_SERVICE_ACCOUNT GitHub Secret tanımlı değil!');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const todayKey = () => new Date().toISOString().slice(0, 10);

// Arayüzdeki model isimlerinin öncelikli API karşılıkları ve günlük limitleri
const MODELS = [
  { n: 'Gemini 3.8 Flash',      pref: ['gemini-2.5-flash', 'gemini-2.0-flash'], l: 20 },
  { n: 'Gemini 3.6 Flash',      pref: ['gemini-2.5-flash', 'gemini-2.0-flash'], l: 20 },
  { n: 'Gemini 3 Flash',        pref: ['gemini-2.5-flash', 'gemini-2.0-flash'], l: 20 },
  { n: 'Gemini 2.5 Flash',      pref: ['gemini-2.5-flash', 'gemini-2.0-flash'], l: 20 },
  { n: 'Gemini 3.5 Flash Lite', pref: ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'], l: 500 },
  { n: 'Gemini 3.1 Flash Lite', pref: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'], l: 500 },
  { n: 'Gemma 4 31B',           pref: ['gemma-3-27b-it', 'gemini-2.0-flash', 'gemini-2.5-flash'], l: 14400 },
  { n: 'Gemma 4 26B',           pref: ['gemma-3-27b-it', 'gemini-2.0-flash', 'gemini-2.5-flash'], l: 14400 }
];

// Google API'den o an gerçekten açık olan modelleri sorgula (404 hatasını önler)
async function fetchActiveModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
  } catch (e) {
    return [];
  }
}

function pickBestModel(agent, usagePools, validApiModels) {
  const candidates = [agent.model, agent.backup, 'Gemini 3.5 Flash Lite', 'Gemini 2.5 Flash', 'Gemma 4 31B'];
  for (const label of candidates) {
    const m = MODELS.find(x => x.n === label);
    if (!m) continue;
    const used = usagePools[m.n] || 0;
    if (used >= m.l) continue;

    for (const api of m.pref) {
      if (validApiModels.length === 0 || validApiModels.includes(api)) {
        return { poolName: m.n, apiName: api };
      }
    }
  }
  const fallback = validApiModels.find(x => /flash|gemma/i.test(x)) || 'gemini-2.5-flash';
  return { poolName: 'Gemini 3.5 Flash Lite', apiName: fallback };
}

async function runOfficeCycle() {
  console.log('🏢 Tonoz AI Ofisi Arka Plan Nöbetçisi Uyandı:', new Date().toISOString());

  // 1. Acil Durdurma (Guard) Kontrolü
  const guardSnap = await db.doc('settings/guard').get();
  if (guardSnap.exists && guardSnap.data().paused) {
    console.log('⏸ Ofis yönetici tarafından duraklatılmış (paused=true). Çıkılıyor.');
    return;
  }

  // 2. API Anahtarını Firestore settings/secret kasasından al
  const secretSnap = await db.doc('settings/secret').get();
  const apiKey = (secretSnap.exists && secretSnap.data().apiKey) ? secretSnap.data().apiKey.trim() : process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('⚠️ Firestore settings/secret içinde apiKey bulunamadı!');
    return;
  }

  // 3. Bekleyen görev/yazışmaları çek
  const mailsSnap = await db.collection('mails').where('processed', '==', false).get();
  if (mailsSnap.empty) {
    console.log('✅ Sırada bekleyen görev yok. Tüm ajanlar dinleniyor.');
    return;
  }

  const nowMs = Date.now();
  const pendingDocs = mailsSnap.docs
    .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
    .filter(m => m.to && m.to !== 'owner' && (!m.notBefore || m.notBefore.toMillis() <= nowMs))
    .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));

  if (pendingDocs.length === 0) {
    console.log('⏳ Bekleyen görevler var ancak güvenli mola (notBefore) süreleri henüz dolmadı.');
    return;
  }

  // 4. Personel, Ortak Klasör ve Günlük Kota bilgilerini çek
  const [staffSnap, filesSnap, usageSnap, validApiModels] = await Promise.all([
    db.collection('staff').get(),
    db.collection('files').orderBy('updatedAt', 'desc').limit(5).get(),
    db.collection('usage').doc(todayKey()).get(),
    fetchActiveModels(apiKey)
  ]);

  const staffList = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const filesList = filesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const usagePools = (usageSnap.exists && usageSnap.data().pools) ? usageSnap.data().pools : {};

  // Her çalışmada maksimum 2 görevi aralarında 70 saniye bekleyerek işle (RPM sınırını korur)
  const tasksToProcess = pendingDocs.slice(0, 2);

  for (let step = 0; step < tasksToProcess.length; step++) {
    const mail = tasksToProcess[step];
    const agent = staffList.find(s => s.id === mail.to || s.name === mail.to || `${s.name} · ${s.role}` === mail.to);

    if (!agent) {
      console.log(`⚠️ Alıcı ajan bulunamadı (${mail.to}), mesaj kapatılıyor.`);
      await mail.ref.update({ processed: true });
      continue;
    }

    // Sonsuz döngü kontrolü (Aynı thread'de 12'den fazla mesaj varsa durdur)
    if (mail.threadId) {
      const threadSnap = await db.collection('mails').where('threadId', '==', mail.threadId).get();
      if (threadSnap.size >= 12) {
        console.log(`🛑 Görev zinciri (${mail.threadId}) 12 adıma ulaştı, otomatik kapatıldı.`);
        await mail.ref.update({ processed: true });
        continue;
      }
    }

    const { poolName, apiName } = pickBestModel(agent, usagePools, validApiModels);
    console.log(`🤖 Çalışan Ajan: ${agent.name} (${agent.role}) | Model: ${apiName}`);

    const companyDirectory = staffList.map(s =>
      `- ID: "${s.id}" | İsim: ${s.name} (${s.role}) | Uzmanlık: ${s.skills || ''}`
    ).join('\n');

    const filesOverview = filesList.map(f =>
      `Dosya: ${f.path} (Yazan: ${f.owner})\nİçerik:\n${(f.content || '').slice(0, 2800)}`
    ).join('\n===\n') || 'Ortak klasör boş.';

    const systemInstruction = `Sen "Tonoz AI Ofisi" şirketinde çalışan "${agent.name}", unvanın "${agent.role}".
Uzmanlığın: ${agent.skills || ''}

KURALLAR:
1. Resmi, kurumsal İstanbul Türkçesi (Bey/Hanım) kullan.
2. Görev atarken SADECE aşağıdaki personel listesindeki ID'leri ("toAgentId") kullan:
${companyDirectory}
- Şirket Sahibi ID: "owner" (Burak Bey). Sadece son sunum/onay aşamasında "owner"a rapor gönder.
3. İşini hemen yap, dosya üretiyorsan "fileToSave" içine tam içeriği yaz ve bir sonraki departmana ilet.
4. SADECE geçerli bir JSON döndür:
{
  "canvasBubble": "Kısa durum",
  "fileToSave": {
    "path": "Dosya adı (Örn: makale.md veya kod.js) - yoksa ''",
    "kind": "md | code | svg | json",
    "content": "Dosya içeriği"
  },
  "outgoingMails": [
    {
      "toAgentId": "Alıcı ID",
      "subject": "Mesaj konusu",
      "body": "Kurumsal talimat veya rapor",
      "type": "görev | rapor | onay"
    }
  ]
}`;

    const userPrompt = `GELEN GÖREV / MESAJ:\nKonu: ${mail.subject}\nİçerik:\n${mail.body}\n\nORTAK KLASÖR:\n${filesOverview}`;
    const isGemma = apiName.startsWith('gemma');
    const bodyPayload = isGemma ? {
      contents: [{ role: 'user', parts: [{ text: systemInstruction + '\n\n' + userPrompt }] }],
      generationConfig: { temperature: 0.4 }
    } : {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
    };

    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${apiName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 150)}`);
      }

      const data = await res.json();
      let rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      rawText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const decision = JSON.parse(rawText);

      // 1) Kotayı güncelle
      usagePools[poolName] = (usagePools[poolName] || 0) + 1;
      await db.collection('usage').doc(todayKey()).set({ updatedAt: FV.serverTimestamp(), pools: usagePools }, { merge: true });
      await db.collection('staff').doc(agent.id).set({
        usedToday: (agent.usedToday || 0) + 1,
        status: decision.canvasBubble || 'Odasında',
        lastActionAt: FV.serverTimestamp()
      }, { merge: true });

      // 2) Dosya üretildiyse Ortak Klasöre (files) kaydet
      if (decision.fileToSave && decision.fileToSave.path && decision.fileToSave.content) {
        const existingFile = filesList.find(f => f.path === decision.fileToSave.path);
        const fileId = existingFile ? existingFile.id : db.collection('files').doc().id;
        const ver = existingFile ? (existingFile.version || 1) + 1 : 1;
        await db.collection('files').doc(fileId).set({
          path: decision.fileToSave.path,
          content: decision.fileToSave.content,
          kind: decision.fileToSave.kind || 'md',
          owner: `${agent.name} · ${agent.role}`,
          version: ver,
          createdAt: FV.serverTimestamp(),
          updatedAt: FV.serverTimestamp()
        }, { merge: true });
        console.log(`📁 Ortak klasöre dosya yazıldı: ${decision.fileToSave.path}`);
      }

      // 3) Giden mailleri oluştur (Her birine 70 sn güvenli mola ekle)
      const outList = Array.isArray(decision.outgoingMails) ? decision.outgoingMails : [];
      for (let i = 0; i < outList.length; i++) {
        const out = outList[i];
        if (!out.toAgentId || !out.body) continue;
        await db.collection('mails').add({
          from: agent.id,
          to: out.toAgentId,
          subject: out.subject || ('Görev: ' + mail.subject),
          body: out.body,
          type: ['görev', 'rapor', 'soru', 'bilgi', 'onay'].includes(out.type) ? out.type : 'görev',
          threadId: mail.threadId || mail.id,
          processed: out.toAgentId === 'owner',
          notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + (i + 1) * 70000),
          createdAt: FV.serverTimestamp()
        });
        console.log(`✉️ Yeni mesaj bırakıldı: ${agent.name} -> ${out.toAgentId}`);
      }

      // 4) Mevcut maili işlendi olarak kapat
      await mail.ref.update({ processed: true, readAt: FV.serverTimestamp() });

      // Eğer sırada 2. bir görev daha varsa, RPM sınırına takılmamak için 65 saniye bekle
      if (step + 1 < tasksToProcess.length) {
        console.log('☕ Dakika başı kota koruması için 65 saniye mola veriliyor...');
        await new Promise(r => setTimeout(r, 65000));
      }
    } catch (err) {
      console.error(`❌ Ajan hatası (${agent.name}):`, err.message);
      const retryCount = (mail.retryCount || 0) + 1;
      if (retryCount >= 3) {
        console.log(`🛑 Görev 3 kez hata aldı, kuyruğu tıkamaması için kapatılıyor.`);
        await mail.ref.update({ processed: true, errorNote: err.message });
      } else {
        await mail.ref.update({
          retryCount,
          notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + 180000)
        });
      }
    }
  }
}

runOfficeCycle().catch(err => {
  console.error('Kritik Motor Hatası:', err);
  process.exit(1);
});
