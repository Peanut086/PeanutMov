/**
 * 管道探针服务（真机自测用）
 *
 * 给设备上的 App 提供五类合成响应，用于在真机上验证管道行为：
 *   /probe-gbk        无 charset 的 GBK 正文（验证探测解码）
 *   /probe-bmp        application/json 但正文是 BMP 魔数（验证伪装拒绝）
 *   /probe-xml        application/rss+xml（验证 xml.vod）
 *   /probe-htmljson   text/html 但正文是 TVBox JSON（验证 CHG-06 规则）
 *   /probe-empty      空响应体
 */
const http = require('node:http');

const GBK_NAME = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const GBK_SUB = Buffer.concat([Buffer.from('{"name":"'), GBK_NAME, Buffer.from('"}')]);
const BMP = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]);

const PORT = Number(process.env.PROBE_PORT || 8911);

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];
  switch (pathname) {
    case '/probe-gbk':
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end(GBK_SUB);
    case '/probe-bmp':
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(BMP);
    case '/probe-xml':
      res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Access-Control-Allow-Origin': '*' });
      return res.end(
        '<?xml version="1.0"?><rss><channel><item><title>XML 影片</title><guid>42</guid>' +
          '<enclosure url="https://img.example.com/1.jpg" />' +
          '<link>https://cdn.example.com/42.m3u8</link></item></channel></rss>',
      );
    case '/probe-htmljson':
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ code: 1, list: [{ vod_id: 1, vod_name: 'HTML 包 JSON' }] }));
    case '/probe-empty':
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end('   ');
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
  }
});

server.listen(PORT, () => console.log(`probe ready on ${PORT}`));
