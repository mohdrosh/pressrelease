const http = require('http');
const https = require('https');

const PORT = 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
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
        generationConfig: { maxOutputTokens: 8192, temperature: 0.7, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } }
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
// Keep-alive ping to prevent Render free tier sleep
setInterval(() => {
  https.get('https://pressrelease-tmo5.onrender.com', (res) => {
    console.log('Keep-alive ping:', res.statusCode);
  }).on('error', () => {});
}, 840000); // ping every 14 minutes
server.listen(PORT, () => console.log(`✅ Gemini proxy running at http://localhost:${PORT}`));