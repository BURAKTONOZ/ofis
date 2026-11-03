// ============================================================================
// TONOZ AI COMPANY - 7/24 OTONOM GITHUB ACTIONS ARKA PLAN MOTORU
// Sayfa kapalıyken nöbeti devralır, İK/Kota analizlerini ve görevleri yürütür
// ============================================================================
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

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

// Kullanıcının AI Studio Hesabındaki Gerçek Limit Tablosu (RPM, TPM, RPD, Saatlik)
const MODEL_QUOTAS = {
  'Gemini 3.8 Flash':       { apis: ['gemini-3.8-flash', 'gemini-2.5-flash'],           rpm: 5,  tpm: 250000, rpd: 20,    rph: 10 },
  'Gemini 3.6 Flash':       { apis: ['gemini-3.6-flash', 'gemini-2.5-flash'],           rpm: 5,  tpm: 250000, rpd: 20,    rph: 10 },
  'Gemini 3 Flash':         { apis: ['gemini-3-flash', 'gemini-2.5-flash'],             rpm: 5,  tpm: 250000, rpd: 20,    rph: 10 },
  'Gemini 2.5 Flash':       { apis: ['gemini-2.5-flash'],                               rpm: 5,  tpm: 250000, rpd: 20,    rph: 10 },
  'Gemini 2.5 Flash Lite':  { apis: ['gemini-2.5-flash-lite'],                          rpm: 10, tpm: 250000, rpd: 20,    rph: 15 },
  'Gemini 3.5 Flash Lite':  { apis: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'], rpm: 15, tpm: 250000, rpd: 500,   rph: 120 },
  'Gemini 3.1 Flash Lite':  { apis: ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], rpm: 15, tpm: 250000, rpd: 500,   rph: 120 },
  'Gemma 4 31B':            { apis: ['gemma-4-31b-it', 'gemma-3-27b-it', 'gemini-2.5-flash-lite'], rpm: 30, tpm: 16000, rpd: 14400, rph: 1200 },
  'Gemma 4 26B':            { apis: ['gemma-4-26b-it', 'gemma-3-27b-it', 'gemini-2.5-flash-lite'], rpm: 30, tpm: 16000, rpd: 14400, rph: 1200 },
  'Gemini Robotics ER 2':   { apis: ['gemini-robotics-er-2-preview', 'gemini-2.5-flash'], rpm: 5, tpm: 250000, rpd: 20,   rph: 10 },
  'Yerçekimsiz (Ajan)':     { apis: ['gemini-2.5-flash'],                               rpm: 60, tpm: 100000, rpd: 100,   rph: 50 }
};

const FALLBACK_ORDER = [
  'Gemini 3.5 Flash Lite',
  'Gemini 3.1 Flash Lite',
  'Gemma 4 31B',
  'Gemma 4 26B',
  'Gemini 2.5 Flash',
  'Gemini 2.5 Flash Lite'
];

async function callGeminiWithFailover(candidates, systemInstruction, userText, pools) {
  let lastErr = null;
  for (const modelName of candidates) {
    const cfg = MODEL_QUOTAS[modelName] || MODEL_QUOTAS['Gemini 3.5 Flash Lite'];
    if ((pools[modelName] || 0) >= cfg.rpd) continue;

    for (const apiId of cfg.apis) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${apiId}:generateContent?key=${GEMINI_KEY}`,
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
          const t = await res.text();
          lastErr = new Error(`${modelName} (${apiId}) HTTP ${res.status}: ${t.slice(0, 160)}`);
          continue;
        }

        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const tokensUsed = data?.usageMetadata?.totalTokenCount || 1200;
        return { decision: JSON.parse(raw), usedModel: modelName, tokensUsed };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('Uygun model veya günlük kota bulunamadı.');
}

async function runSingleTick() {
  const guardSnap = await db.doc('settings/guard').get();
  const guard = guardSnap.exists ? guardSnap.data() : {};
  if (guard.paused) {
    console.log('Sistem yönetici tarafından duraklatılmış (paused=true).');
    return;
  }

  // Eğer yönetici şu an tarayıcıda aktifse (son 90 saniyede sinyal göndermişse) çakışmamak için tarayıcıya bırak
  if (guard.lastBrowserHeartbeat && guard.lastBrowserHeartbeat.toMillis) {
    const diffSec = (Date.now() - guard.lastBrowserHeartbeat.toMillis()) / 1000;
    if (diffSec < 90) {
      console.log(`Yönetici şu an tarayıcıda çevrimiçi (${Math.round(diffSec)} sn önce aktif). İşlemler tarayıcıdan yürütülüyor.`);
      return;
    }
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
    console.log('Sıradaki görevlerin güvenli mola süresi henüz dolmadı.');
    return;
  }

  const mail = { id: mailDoc.id, ...mailDoc.data() };
  const staffSnap = await db.collection('staff').get();
  const staffList = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  function findStaffSmart(query) {
    if (!query) return null;
    const tr = s => String(s || '').toLocaleLowerCase('tr-TR').trim();
    const q = tr(query);
    if (!q) return null;
    let found = staffList.find(s => s.id === query || tr(s.id) === q || tr(s.name) === q || tr(s.role) === q);
    if (found) return found;
    if (q.length >= 2) {
      found = staffList.find(s => tr(s.name).includes(q) || q.includes(tr(s.name)));
      if (found) return found;
    }
    if (q.length >= 3) {
      found = staffList.find(s => tr(s.role).includes(q) || q.includes(tr(s.role)));
      if (found) return found;
    }
    const words = q.split(/\s+/).filter(w => w.length >= 3);
    if (words.length) {
      let best = null, bestScore = 0;
      for (const s of staffList) {
        const hay = tr(s.name + ' ' + s.role + ' ' + (s.skills || ''));
        let score = 0;
        for (const w of words) {
          if (tr(s.name).includes(w) || tr(s.role).includes(w)) score += 3;
          else if (hay.includes(w)) score += 1;
        }
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (bestScore >= 2) return best;
    }
    return null;
  }

  const agent = findStaffSmart(mail.to);

  if (!agent) {
    await mailDoc.ref.update({ processed: true });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const hourKey = new Date().toISOString().slice(11, 13);
  const usageRef = db.collection('usage').doc(today);
  const usageSnap = await usageRef.get();
  const uData = usageSnap.exists ? usageSnap.data() : {};
  const pools = uData.pools || {};
  const hourly = uData.hourly || {};
  const tokens = uData.tokens || {};

  const candidates = [
    agent.model || 'Gemini 3.5 Flash Lite',
    agent.backup || 'Gemma 4 31B',
    ...FALLBACK_ORDER
  ].filter((v, i, a) => a.indexOf(v) === i);

  const filesSnap = await db.collection('files').orderBy('updatedAt', 'desc').limit(6).get();
  const filesOverview = filesSnap.docs.map(d => {
    const f = d.data();
    return `Dosya ID: "${d.id}" | Dosya Adı: ${f.path} (Yazan: ${f.owner})\n${(f.content || '').slice(0, 3000)}`;
  }).join('\n===\n') || 'Ortak klasör boş.';

  const directory = staffList.map(s =>
    `- ID: "${s.id}" | Mevcut İsim: "${s.name}" | Unvan/Rol: "${s.role}" | Oda No: ${s.room} | Ana Model: "${s.model}" | Yedek Model: "${s.backup}" | Bugün: ${s.usedToday || 0}\n  Mevcut Uzmanlık/Skills: "${s.skills || ''}"`
  ).join('\n');

  const quotaSummary = Object.entries(MODEL_QUOTAS).map(([k, v]) =>
    `- ${k}: Günlük ${pools[k] || 0}/${v.rpd} RPD | Saatlik Limit: ${v.rph} RPH | Dakikalık: ${v.rpm} RPM | Token: ${(v.tpm / 1000)}K TPM`
  ).join('\n');

  const systemInstruction = `Sen TONOZ AI COMPANY'de çalışan "${agent.name}" (${agent.role}) isimli yapay zeka personelsin.
Senin Uzmanlığın: ${agent.skills || ''}

CANLI FIRESTORE VERİTABANI - ŞİRKET PERSONEL TABLOSU ("staff" koleksiyonu):
${directory}
- Şirket Sahibi / Yönetici ID: "owner" (Burak Bey).

ŞİRKET MODEL VE KOTA LİMİTLERİ (CANLI):
${quotaSummary}
Mevcut Güvenli Mola Süresi: ${guard.cooldownSec || 65} saniye.

KURALLAR VE DOĞRUDAN FIRESTORE GÜNCELLEME YETKİSİ:
1. Kurumsal İstanbul Türkçesi (Bey/Hanım) kullan.
2. DOĞRUDAN FIRESTORE VERİTABANI OKUMA VE GÜNCELLEME ("hrUpdates"):
   - Yukarıdaki "staff" tablosu canlı Firestore veritabanıdır. Tüm personellerin mevcut isimlerini, rollerini, modellerini ve mevcut "skills" (uzmanlık) metinlerini buradan okuyabilirsin.
   - Burak Bey bir personelin adını ("name"), uzmanlığını/yeteneklerini ("skills"), unvanını ("role"), modelini ("model"/"backup") değiştirmeyi, yeni personel eklemeyi ("action": "create") veya mola süresini güncellemeyi istediğinde BUNU ASLA "fileToSave" İLE JSON DOSYASI OLARAK KAYDETME! Doğrudan "hrUpdates.staffUpdates" dizisini doldur!
   - Mevcut skill'lere ekleme istendiyse tablodaki mevcut "skills" metnini koruyup yeni yeteneği ekleyerek tam metni "hrUpdates.staffUpdates[].skills" alanına yaz.
3. Eğer Burak Bey 2D ofise bir eşya/tasarım veya siteye yeni bir özellik/menü eklenmesini istediyse "officePatch" alanını doldur.
4. Sadece geçerli JSON döndür:
{
  "canvasBubble": "Kısa durum",
  "hrUpdates": {
    "cooldownSec": 0,
    "staffUpdates": [
      {
        "action": "update | create | delete",
        "agentId": "Güncellenecek personelin ID'si veya mevcut adı/unvanı",
        "name": "Personelin yeni adı (isim değişecekse yeni adını yaz)",
        "role": "Personelin yeni unvanı",
        "skills": "Personelin güncellenmiş tam uzmanlık/skill metni",
        "model": "Ana Gemini modeli",
        "backup": "Yedek Gemini modeli",
        "room": -1
      }
    ]
  },
  "outgoingMails": [ { "toAgentId": "", "subject": "", "body": "", "type": "görev | rapor | onay" } ],
  "fileToSave": { "path": "", "kind": "md | code", "content": "" },
  "officePatch": {
    "hasPatch": false,
    "title": "",
    "summary": "",
    "sceneMods": [ { "id": "", "label": "", "depth": 12, "drawJs": "" } ],
    "uiMods": [ { "id": "", "slot": "top-right | header-menu | floating-widget", "title": "", "html": "", "css": "", "js": "" } ]
  },
  "submitFinalApproval": { "ready": false, "summary": "" }
}`;

  const userText = `Konu: ${mail.subject}\nMesaj:\n${mail.body}\n\nOrtak Klasör:\n${filesOverview}`;
  const { decision, usedModel, tokensUsed } = await callGeminiWithFailover(candidates, systemInstruction, userText, pools);

  // Günlük, Saatlik ve Token sayaçlarını güncelle
  pools[usedModel] = (pools[usedModel] || 0) + 1;
  const hKey = `${usedModel}_${hourKey}`;
  hourly[hKey] = (hourly[hKey] || 0) + 1;
  tokens[usedModel] = (tokens[usedModel] || 0) + tokensUsed;

  await usageRef.set({ updatedAt: FV.serverTimestamp(), pools, hourly, tokens }, { merge: true });
  await db.collection('staff').doc(agent.id).set({
    usedToday: (agent.usedToday || 0) + 1,
    lastActionAt: FV.serverTimestamp()
  }, { merge: true });

  // Eğer model yanlışlıkla fileToSave içine personel güncelleme JSON'u koyduysa yakala
  let extraStaffUpdates = [];
  if (Array.isArray(decision.staffUpdates)) extraStaffUpdates.push(...decision.staffUpdates);
  if (decision.fileToSave && decision.fileToSave.content) {
    const fPath = String(decision.fileToSave.path || '').toLowerCase();
    const fContent = String(decision.fileToSave.content || '').trim();
    if (fPath.endsWith('.json') || decision.fileToSave.kind === 'json' || (fContent.startsWith('{') && fContent.endsWith('}'))) {
      try {
        const parsed = JSON.parse(fContent);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.staffUpdates)) {
            extraStaffUpdates.push(...parsed.staffUpdates);
            decision.fileToSave = null;
          } else if (parsed.hrUpdates && Array.isArray(parsed.hrUpdates.staffUpdates)) {
            extraStaffUpdates.push(...parsed.hrUpdates.staffUpdates);
            decision.fileToSave = null;
          } else if (parsed.agentId || parsed.newName || (parsed.skills && (parsed.name || parsed.role))) {
            extraStaffUpdates.push(parsed);
            decision.fileToSave = null;
          }
        }
      } catch (e) {}
    }
  }

  // İK / Veritabanı güncellemeleri varsa Firestore'a uygula
  const hr = decision.hrUpdates || {};
  if (hr.cooldownSec && hr.cooldownSec >= 10) {
    await db.doc('settings/guard').set({ cooldownSec: Number(hr.cooldownSec) }, { merge: true });
  }
  const allStaffUpdates = [
    ...(Array.isArray(hr.staffUpdates) ? hr.staffUpdates : []),
    ...extraStaffUpdates
  ];
  for (const su of allStaffUpdates) {
    if (!su || typeof su !== 'object') continue;
    const action = String(su.action || 'update').toLowerCase();
    if (action === 'create' || action === 'add') {
      const newName = String(su.name || su.newName || '').trim().slice(0, 48);
      if (!newName) continue;
      await db.collection('staff').add({
        name: newName,
        role: String(su.role || su.newRole || 'Uzman').trim().slice(0, 75),
        room: (su.room != null && su.room >= 0 && su.room < 10) ? Math.floor(Number(su.room)) : 0,
        model: su.model || 'Gemini 3.5 Flash Lite',
        backup: su.backup || 'Gemma 4 31B',
        skills: String(su.skills || ''),
        active: true,
        status: 'Odasında',
        usedToday: 0,
        createdBy: agent.id,
        createdAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp()
      });
      continue;
    }
    const lookupKey = su.agentId || su.id || su.target || su.currentName || su.oldName || su.role || su.name;
    const targetStaff = findStaffSmart(lookupKey);
    if (!targetStaff) continue;
    if (action === 'delete' || action === 'remove') {
      await db.collection('staff').doc(targetStaff.id).delete();
      continue;
    }
    const upObj = {
      name: targetStaff.name,
      role: targetStaff.role,
      room: Number.isFinite(Number(targetStaff.room)) ? Math.floor(Number(targetStaff.room)) : 0,
      updatedAt: FV.serverTimestamp()
    };
    const candName = su.newName || su.name;
    if (candName && String(candName).trim() && String(candName).trim() !== targetStaff.name && String(candName).toLocaleLowerCase('tr-TR') !== String(targetStaff.role).toLocaleLowerCase('tr-TR')) {
      upObj.name = String(candName).trim().slice(0, 48);
    }
    const candRole = su.newRole || su.role;
    if (candRole && String(candRole).trim()) upObj.role = String(candRole).trim().slice(0, 75);
    if (su.skills || su.newSkills) upObj.skills = String(su.newSkills || su.skills).trim();
    if (su.model) upObj.model = su.model;
    if (su.backup) upObj.backup = su.backup;
    if (su.room != null && Number(su.room) >= 0 && Number(su.room) < 10) upObj.room = Math.floor(Number(su.room));
    await db.collection('staff').doc(targetStaff.id).set(upObj, { merge: true });
  }

  // Dosya varsa Ortak Klasöre kaydet
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

  // Ofis / UI yaması varsa hem Ortak Klasöre yedekle hem Onay Kutusuna sun
  const hasPatch = decision.officePatch && decision.officePatch.hasPatch;
  const isFinal = decision.submitFinalApproval && decision.submitFinalApproval.ready;
  if (hasPatch || isFinal) {
    if (hasPatch) {
      await db.collection('files').add({
        path: `yama-${Date.now()}.json`,
        content: JSON.stringify(decision.officePatch, null, 2),
        kind: 'json',
        owner: `${agent.name} (${agent.role})`,
        version: 1,
        createdAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp()
      });
    }
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
    const isToOwner = out.toAgentId === 'owner' || String(out.toAgentId).toLowerCase().includes('burak');
    const resolvedTarget = isToOwner ? { id: 'owner' } : findStaffSmart(out.toAgentId);
    if (!resolvedTarget) continue;
    await db.collection('mails').add({
      from: agent.id,
      to: resolvedTarget.id,
      subject: String(out.subject || ('Görev: ' + mail.subject)).slice(0, 290),
      body: String(out.body).slice(0, 39000),
      type: validTypes.includes(out.type) ? out.type : 'görev',
      threadId: mail.threadId || mail.id,
      processed: resolvedTarget.id === 'owner',
      notBefore: admin.firestore.Timestamp.fromMillis(Date.now() + (i + 1) * cooldownMs),
      createdAt: FV.serverTimestamp()
    });
  }

  await mailDoc.ref.update({ processed: true, readAt: FV.serverTimestamp() });
  console.log(`Başarıyla işlendi [${usedModel}]: ${agent.name} -> ${mail.subject}`);
}

runSingleTick().catch(e => { console.error(e); process.exit(1); });
