// 检测用户自己保存的代理是否可用:经代理访问公开 IP 查询接口,记录延迟。
const http = require('http');

const TEST_HOST = 'ip-api.com';
const TEST_PATH = '/json/?fields=status,message,query,country,regionName,city,isp';
const TIMEOUT_MS = 12000;

function parseIpApiBody(raw) {
  const text = String(raw || '');
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) throw new Error('返回解析失败');
  const data = JSON.parse(text.slice(jsonStart));
  if (data.status !== 'success') throw new Error(data.message || '查询失败');
  return {
    ip: data.query || '',
    country: data.country || '',
    region: data.regionName || '',
    city: data.city || '',
    isp: data.isp || '',
  };
}

function testHttpProxy({ host, port, username, password }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const finish = (ok, extra) => resolve({ ok, latency: Date.now() - t0, ...extra });
    const headers = {
      Host: TEST_HOST,
      'User-Agent': 'gpt-plus-proxy-test/1.0',
      Connection: 'close',
    };
    if (username) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
    }
    const req = http.request(
      {
        host,
        port,
        path: `http://${TEST_HOST}${TEST_PATH}`,
        method: 'GET',
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.length > 20000) req.destroy();
        });
        res.on('end', () => {
          try {
            finish(true, parseIpApiBody(buf));
          } catch (e) {
            finish(false, { message: String(e.message || e).slice(0, 160) });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish(false, { message: '连接超时' });
    });
    req.on('error', (e) => finish(false, { message: String(e.message || e).slice(0, 160) }));
    req.end();
  });
}

function testSocks5Proxy({ host, port, username, password }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const finish = (ok, extra) => resolve({ ok, latency: Date.now() - t0, ...extra });
    let SocksClient;
    try {
      ({ SocksClient } = require('socks'));
    } catch {
      return finish(false, { message: '当前环境未安装 socks 依赖' });
    }
    SocksClient.createConnection(
      {
        proxy: {
          host,
          port: Number(port),
          type: 5,
          userId: username || undefined,
          password: password || undefined,
        },
        command: 'connect',
        destination: { host: TEST_HOST, port: 80 },
        timeout: TIMEOUT_MS,
      },
      (err, info) => {
        if (err || !info?.socket) return finish(false, { message: String(err?.message || 'socks 连接失败').slice(0, 160) });
        const socket = info.socket;
        let buf = '';
        socket.setTimeout(TIMEOUT_MS);
        socket.on('data', (c) => {
          buf += c;
          if (buf.length > 20000) socket.destroy();
        });
        socket.on('end', () => {
          try {
            finish(true, parseIpApiBody(buf));
          } catch (e) {
            finish(false, { message: String(e.message || e).slice(0, 160) });
          }
        });
        socket.on('timeout', () => {
          socket.destroy();
          finish(false, { message: '连接超时' });
        });
        socket.on('error', (e) => finish(false, { message: String(e.message || e).slice(0, 160) }));
        socket.write(
          `GET ${TEST_PATH} HTTP/1.1\r\nHost: ${TEST_HOST}\r\nUser-Agent: gpt-plus-proxy-test/1.0\r\nConnection: close\r\n\r\n`
        );
      }
    );
  });
}

async function testProxy(row, password) {
  const payload = {
    host: row.host,
    port: Number(row.port),
    username: row.username || '',
    password: password || '',
  };
  if (row.proxy_type === 'socks5') return testSocks5Proxy(payload);
  return testHttpProxy(payload);
}

module.exports = { parseIpApiBody, testHttpProxy, testSocks5Proxy, testProxy };
