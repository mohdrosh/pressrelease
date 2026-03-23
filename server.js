require('dotenv').config();
const http = require('http');
const https = require('https');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
const dbName = 'pressrelease';
let db;

async function connectDB(){
  const client = await MongoClient.connect(MONGO_URI);
  db = client.db(dbName);
  console.log('✅ MongoDB connected');
}
connectDB().catch(err => console.error('MongoDB error:', err));

const PORT = 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }

  // GET saved press releases
  if (req.method === 'GET' && req.url === '/saves') {
    try {
      const saves = await db.collection('saves').find().sort({savedAt:-1}).toArray();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(saves));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET approved press releases only (public)
  if (req.method === 'GET' && req.url === '/saves/approved') {
    try {
      const saves = await db.collection('saves').find({ status: 'approved' }).sort({ savedAt: -1 }).toArray();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(saves));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // PATCH update a press release (edit content + status)
  if (req.method === 'PATCH' && req.url.startsWith('/saves/')) {
    const { ObjectId } = require('mongodb');
    const id = req.url.split('/saves/')[1];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        await db.collection('saves').updateOne(
          { _id: new ObjectId(id) },
          { $set: update }
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // DELETE a press release
  if (req.method === 'DELETE' && req.url.startsWith('/saves/')) {
    const { ObjectId } = require('mongodb');
    const id = req.url.split('/saves/')[1];
    try {
      await db.collection('saves').deleteOne({ _id: new ObjectId(id) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST save a press release
  if (req.method === 'POST' && req.url === '/saves') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const entry = JSON.parse(body);
        entry.savedAt = new Date().toISOString();
        entry.status = entry.status || 'draft';
        const result = await db.collection('saves').insertOne(entry);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, _id: result.insertedId.toString() }));
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const incoming = JSON.parse(body);
      const userContent = incoming.messages[0].content;

      let parts = [];

      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (block.type === 'document') {
            parts.push({ inline_data: { mime_type: 'application/pdf', data: block.source.data } });
          } else if (block.type === 'text') {
            parts.push({ text: block.text });
          }
        }
      } else {
        parts.push({ text: userContent });
      }

      // Prepend system prompt as a text part
      if (incoming.system) {
        parts.unshift({ text: '【システム指示】\n' + incoming.system + '\n\n【ユーザー入力】\n' });
      }

      const geminiBody = JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 16000, temperature: 0.7, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } }
      });

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(geminiBody)
        }
      };

      const proxy = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          console.log('GEMINI RAW:', data); // Remove .substring(0, 300) to see everything
          try {
            const geminiResp = JSON.parse(data);
            const text = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (!text) {
              console.error('Empty text from Gemini:', data);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Empty response from Gemini', raw: data }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Parse failed', raw: data }));
          }
        });
      });

      proxy.on('error', e => { console.error('Proxy error:', e.message); res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      proxy.write(geminiBody);
      proxy.end();

    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});
setInterval(() => {
  https.get('https://pressrelease-tmo5.onrender.com/health', (res) => {
    console.log('Keep-alive ping:', res.statusCode);
  }).on('error', () => {});
}, 840000);
 // ping every 14 minutes
server.listen(PORT, () => console.log(`✅ Gemini proxy running at http://localhost:${PORT}`));