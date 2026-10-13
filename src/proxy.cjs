const net = require('node:net');
const http = require('node:http');
const { proxyConfig } = require('./model.cjs');
function encodeTarget(host,port){
  host=String(host).replace(/^\[|\]$/g,'');if(!Number.isInteger(port)||port<1||port>65535)throw Error('目标端口无效');
  const tail=Buffer.alloc(2);tail.writeUInt16BE(port);const ip=net.isIP(host);let address;
  if(ip===4)address=Buffer.from([1,...host.split('.').map(Number)]);
  else if(ip===6){if(host.includes('.')){const at=host.lastIndexOf(':'),v=host.slice(at+1).split('.').map(Number);host=host.slice(0,at+1)+((v[0]<<8)|v[1]).toString(16)+':'+((v[2]<<8)|v[3]).toString(16);}const [a,b]=host.split('::'),left=a?a.split(':'):[],right=b?b.split(':'):[],words=b!==undefined?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;const bytes=Buffer.alloc(16);words.forEach((x,i)=>bytes.writeUInt16BE(parseInt(x,16),i*2));address=Buffer.concat([Buffer.from([4]),bytes]);}
  else {const name=Buffer.from(host);if(!name.length||name.length>255||/[\s\0]/.test(host))throw Error('目标域名无效或过长');address=Buffer.concat([Buffer.from([3,name.length]),name]);}
  return Buffer.concat([Buffer.from([5,1,0]),address,tail]);
}
// An authenticated SOCKS connection resolves destination names on the proxy side.
async function socksConnect(proxy, host, port, track=s=>s) {
  const request=encodeTarget(host,port);
  const socket = net.connect(proxy.port, proxy.host);
  socket.on('error', () => {});
  track(socket);
  const timer=setTimeout(()=>socket.destroy(new Error('SOCKS5 握手超时')),15000);
  let buffer = Buffer.alloc(0), pending;
  const fail = error => { if (pending) { const x = pending; pending = null; x.reject(error); } };
  function pump() { if (pending && buffer.length >= pending.n) { const x = pending; pending = null; const b = buffer.subarray(0, x.n); buffer = buffer.subarray(x.n); x.resolve(b); } }
  const onData = b => { if(buffer.length+b.length>1024*1024){socket.destroy(new Error('SOCKS5 握手响应过大'));return;}buffer = Buffer.concat([buffer, b]); pump(); };
  socket.on('data', onData); socket.on('close', () => fail(new Error('SOCKS5 连接已关闭'))); socket.on('error', fail); socket.on('end', () => fail(new Error('SOCKS5 连接中断')));
  const read = n => new Promise((resolve, reject) => { if (socket.destroyed) return reject(Error('SOCKS5 连接已关闭')); pending = { n, resolve, reject }; pump(); });
  try {
    await new Promise((resolve,reject)=>{const clean=()=>{socket.removeListener('connect',connected);socket.removeListener('error',failed);socket.removeListener('close',closed);};const connected=()=>{clean();resolve();},failed=e=>{clean();reject(e);},closed=()=>failed(Error('SOCKS5 连接已关闭'));socket.once('connect',connected);socket.once('error',failed);socket.once('close',closed);if(socket.destroyed)closed();});
    const auth = !!proxy.username;
    socket.write(Buffer.from([5, 1, auth ? 2 : 0]));
    const greeting = await read(2);
    if (greeting[0] !== 5 || greeting[1] !== (auth ? 2 : 0)) throw Error('SOCKS5 认证方式不受支持');
    if (auth) {
      const u = Buffer.from(proxy.username), p = Buffer.from(proxy.password);
      socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const reply = await read(2); if (reply[0] !== 1 || reply[1] !== 0) throw Error('SOCKS5 用户名或密码错误');
    }
    socket.write(request);
    const head = await read(4); if (head[0] !== 5 || head[1] !== 0) throw Error('SOCKS5 代理拒绝连接：' + head[1]);
    if (head[3] === 1) await read(6); else if (head[3] === 4) await read(18); else if (head[3] === 3) await read((await read(1))[0] + 2); else throw Error('SOCKS5 响应无效');
    socket.pause(); socket.removeListener('data', onData); socket.removeListener('error', fail); socket.setTimeout(0);
    if (buffer.length) socket.unshift(buffer);
    return socket;
  } catch (e) { socket.destroy(); throw e; } finally {clearTimeout(timer);}
}
async function createProxyRoute(proxy) {
  if (proxy.type !== 'socks5' || !proxy.username) return { config: proxyConfig(proxy), close: async () => {} };
  let closed=false,closing;const sockets = new Set(); const track = s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); if(closed)s.destroy();return s; };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url); if (u.protocol !== 'http:') throw Error('不支持的代理请求');
      const socket = await socksConnect(proxy, u.hostname, Number(u.port || 80),track);
      const headers = { ...req.headers, host: u.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => socket;
      const forward = http.request({ hostname: u.hostname, port: Number(u.port || 80), method: req.method, path: u.pathname + u.search, headers, agent }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); upstream.on('end', () => agent.destroy()); });
      forward.on('error', () => { agent.destroy(); if (!res.headersSent) res.writeHead(502); res.end('代理连接失败'); });
      req.on('aborted', () => forward.destroy()); req.pipe(forward); socket.resume();
    } catch { res.writeHead(502); res.end('代理连接失败'); }
  });
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    try {
      const u = new URL('http://' + req.url); const remote = await socksConnect(proxy, u.hostname, Number(u.port || 443),track);
      if (client.destroyed) { remote.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client); remote.resume(); client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
    } catch { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { config: proxyConfig({ type: 'http', host: '127.0.0.1', port: server.address().port }), close: () => {if(closing)return closing;closed=true;closing=new Promise(resolve=>{for(const s of sockets)s.destroy();server.close(resolve);});return closing;} };
}
module.exports = { createProxyRoute, socksConnect,encodeTarget };
