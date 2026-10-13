const {test}=require('node:test'),assert=require('node:assert/strict');const {encodeTarget}=require('../src/proxy.cjs');
test('SOCKS5 distinguishes domains, IPv4 and compressed or mapped IPv6 targets',()=>{
 assert.equal(encodeTarget('a.test',443).toString('hex'),'0501000306612e7465737401bb');
 assert.equal(encodeTarget('192.0.2.1',80).toString('hex'),'05010001c00002010050');
 assert.equal(encodeTarget('[::1]',443).toString('hex'),'050100040000000000000000000000000000000101bb');
 assert.equal(encodeTarget('2001:db8::1',443).toString('hex'),'0501000420010db800000000000000000000000101bb');
 assert.equal(encodeTarget('::ffff:192.0.2.1',443).toString('hex'),'0501000400000000000000000000ffffc000020101bb');
 for(const [host,port] of [['host',0],['host',65536],['',80],['bad host',80]])assert.throws(()=>encodeTarget(host,port));
});
