import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'mope_mega', 'client.js_x_1686826450749');
const DST = path.join(__dirname, 'mope_mega', 'client.js');

const hex = (s) =>
  [...s].map((c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

// Patches. Anchors are literal raw substrings (hex-encoded like the obfuscated
// file). Inserted content uses plaintext strings (valid JS, mixed encoding ok).
const P = hex;
const patches = [
  // 1) Add a "Local Test" region/server as the FIRST game server so that with
  //    isTestingMode=true the client auto-selects it.
  {
    label: 'localtest-server-entry',
    anchor: `'${P('gameServers')}':[{`,
    replacement: `'${P('gameServers')}':[{'id':'localtest-1','name':'Local Test 1','url':'127.0.0.1:9339','region':'Local Test','gm':0x0},{`,
  },
  // 2) isTestingMode -> true (auto-select first region = Local Test).
  {
    label: 'is-testing-mode',
    anchor: `'${P('isTestingMode')}':![],`,
    replacement: `'${P('isTestingMode')}':!![],`,
  },
  // 2b) Never force-reload because the server advertises a newer gameVersion.
  //     The client otherwise alerts "mope.io has been updated!" and reloads,
  //     which drops the local connection. Keep the client connected.
  {
    label: 'version-reload-bypass',
    anchor: `_0x34f7d5['${P('gameVersion')}']>_0x4f0087){`,
    replacement: `_0x34f7d5['${P('gameVersion')}']>_0x4f0087&&![]){`,
  },
  // 2c) Append extra region servers to the game server list (kept after the
  //     Local Test entry so isTestingMode still auto-selects Local Test first).
  {
    label: 'extra-servers',
    anchor:
      `'${P('id')}':'${P('prod-lnd-au-sd-1')}','${P('name')}':'${P('Sydney 1')}'` +
      `,'${P('url')}':'${P('prod-lnd-au-sd-1.mathstudyguides.com')}','${P('region')}':'${P('Sydney, Australia')}'` +
      `,'${P('gm')}':0x0}]};`,
    replacement:
      `'${P('id')}':'${P('prod-lnd-au-sd-1')}','${P('name')}':'${P('Sydney 1')}'` +
      `,'${P('url')}':'${P('prod-lnd-au-sd-1.mathstudyguides.com')}','${P('region')}':'${P('Sydney, Australia')}'` +
      `,'${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-lnd-us-ch-1')}','${P('name')}':'${P('Chicago 1')}','${P('url')}':'${P('prod-lnd-us-ch-1.mathstudyguides.com')}','${P('region')}':'${P('Chicago, USA')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-lnd-us-sea-1')}','${P('name')}':'${P('Seattle 1')}','${P('url')}':'${P('prod-lnd-us-sea-1.mathstudyguides.com')}','${P('region')}':'${P('Seattle, USA')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-lnd-us-nh-1')}','${P('name')}':'${P('New Hampshire 1')}','${P('url')}':'${P('prod-lnd-us-nh-1.mathstudyguides.com')}','${P('region')}':'${P('New Hampshire, USA')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-lnd-us-va-1')}','${P('name')}':'${P('Virginia 1')}','${P('url')}':'${P('prod-lnd-us-va-1.mathstudyguides.com')}','${P('region')}':'${P('Virginia, USA')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-lnd-us-mia-1')}','${P('name')}':'${P('Miami 1')}','${P('url')}':'${P('prod-lnd-us-mia-1.mathstudyguides.com')}','${P('region')}':'${P('Miami, USA')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-ovh-nl-am-1')}','${P('name')}':'${P('Amsterdam 1')}','${P('url')}':'${P('prod-ovh-nl-am-1.mathstudyguides.com')}','${P('region')}':'${P('Amsterdam, Netherlands')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-ovh-uk-lo-1')}','${P('name')}':'${P('London 1')}','${P('url')}':'${P('prod-ovh-uk-lo-1.mathstudyguides.com')}','${P('region')}':'${P('London, UK')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-ovh-jp-tk-1')}','${P('name')}':'${P('Tokyo 1')}','${P('url')}':'${P('prod-ovh-jp-tk-1.mathstudyguides.com')}','${P('region')}':'${P('Tokyo, Japan')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-lnd-ar-ba-1')}','${P('name')}':'${P('Buenos Aires 1')}','${P('url')}':'${P('prod-lnd-ar-ba-1.mathstudyguides.com')}','${P('region')}':'${P('Buenos Aires, Argentina')}','${P('gm')}':0x0},` +
      `{'${P('id')}':'${P('prod-ovh-is-re-1')}','${P('name')}':'${P('Iceland 1')}','${P('url')}':'${P('prod-ovh-is-re-1.mathstudyguides.com')}','${P('region')}':'${P('Iceland')}','${P('gm')}':0x0}]};`,
  },
  // 3) Neutralize the anti-tamper domain lock. _0x2ccefb() checks the page
  //    hostname against a whitelist and, if not allowed, redirects to
  //    about:blank (killing the page). It runs once at the top of run();
  //    replacing the call site with a no-op keeps the whole game bootstrap
  //    alive on the preview host.
  {
    label: 'domain-lock-bypass',
    anchor: `_0x2ccefb();`,
    replacement: `0;`,
  },
  // 4) Ping error -> activate the server anyway (so all servers show as active).
  {
    label: 'ping-error-activate',
    anchor:
      `this['${P('testWs')}']['${P('onerror')}']=function(_0x4be543){console['${P('log')}']` +
      `('${P('TestWS: error connecting to server ')}'+_0x43854e['${P('serverObj')}']['${P('name')}']` +
      `+'${P(' IP ')}'+_0x43854e['${P('serverObj')}']['${P('ip')}']+_0x4be543);}`,
    replacement:
      `this['${P('testWs')}']['${P('onerror')}']=function(_0x4be543){console['${P('log')}']` +
      `('${P('TestWS: error connecting to server ')}'+_0x43854e['${P('serverObj')}']['${P('name')}']` +
      `+'${P(' IP ')}'+_0x43854e['${P('serverObj')}']['${P('ip')}']+_0x4be543);` +
      `if(_0x35be1c['${P('indexOf')}'](_0x43854e)>-0x1){` +
      `_0x43854e['${P('serverObj')}']['${P('ping')}']=_0x43854e['${P('serverObj')}']['${P('ping')}']||0x2710;` +
      `_0x2ba6af(_0x43854e);}}`,
  },
  // 5) Ping close -> activate the server anyway.
  {
    label: 'ping-close-activate',
    anchor: `this['${P('testWs')}']['${P('onclose')}']=function(_0x510445){};`,
    replacement:
      `this['${P('testWs')}']['${P('onclose')}']=function(_0x510445){` +
      `if(_0x35be1c['${P('indexOf')}'](_0x43854e)>-0x1){` +
      `_0x43854e['${P('serverObj')}']['${P('ping')}']=_0x43854e['${P('serverObj')}']['${P('ping')}']||0x2710;` +
      `_0x2ba6af(_0x43854e);}};`,
  },
  // 6) Join connection: use the page's own origin (protocol + location.host)
  //    for the localtest server so it also works from an https-previewed page
  //    through the preview tunnel. Other servers keep their own URL.
  {
    label: 'join-url-force-ws',
    anchor:
      `var _0x1a3fc6=window['${P('location')}']['${P('protocol')}']==='${P('https:')}'?` +
      `'${P('wss://')}':'${P('ws://')}',_0x3bbf00=_0x1a3fc6+_0x34f7d5['${P('serverConnURL')}'];`,
    replacement:
      `var _0x1a3fc6=window['${P('location')}']['${P('protocol')}']==='${P('https:')}'?` +
      `'${P('wss://')}':'${P('ws://')}',_0x3bbf00=_0x34f7d5['${P('serverConnURL')}']` +
      `&&_0x34f7d5['${P('serverConnURL')}']['${P('indexOf')}']('127.0.0.1')===0x0?` +
      `_0x1a3fc6+window['${P('location')}']['${P('host')}']:_0x1a3fc6+_0x34f7d5['${P('serverConnURL')}'];`,
  },
  // 7) Ping connection: same-origin through the preview tunnel for localtest.
  {
    label: 'ping-url-force-ws',
    anchor:
      `var _0x3b83e4=window['${P('location')}']['${P('protocol')}']==='${P('https:')}'?` +
      `'${P('wss://')}':'${P('ws://')}',_0xcf444a=_0x3b83e4+this['${P('serverObj')}']['${P('serverConnURL')}']` +
      `+'${P('/ping')}';`,
    replacement:
      `var _0x3b83e4=window['${P('location')}']['${P('protocol')}']==='${P('https:')}'?` +
      `'${P('wss://')}':'${P('ws://')}',_0xcf444a=this['${P('serverObj')}']['${P('serverConnURL')}']` +
      `&&this['${P('serverObj')}']['${P('serverConnURL')}']['${P('indexOf')}']('127.0.0.1')===0x0?` +
      `_0x3b83e4+window['${P('location')}']['${P('host')}']+'${P('/ping')}':` +
      `_0x3b83e4+this['${P('serverObj')}']['${P('serverConnURL')}']+'${P('/ping')}';`,
  },
  // 8) Redirect the account API to the local dev account server. An empty
  //    devAccountServerUrl makes all /auth/* + /playerSettings_update calls
  //    relative (same origin), working locally and through the tunnel.
  {
    label: 'dev-account-server',
    anchor: `'${P('useDevAccountServer')}':![],'${P('devAccountServerUrl')}':''`,
    replacement:
      `'${P('useDevAccountServer')}':!![],'${P('devAccountServerUrl')}':''`,
  },
  // 9) Expose email/password login + registration hooks (called from index.html
  //    forms). Login reuses the client's own _0x148122 success flow (coins,
  //    gems, localStorage, UI). Registration does a raw fetch to the local
  //    /auth/register/email endpoint, then completes the same flow.
  {
    label: 'email-login-hooks',
    anchor: `,_0x2fceb8=async _0x38acda=>{return;};`,
    replacement:
      `,_0x2fceb8=async _0x38acda=>{return;};` +
      `window['MopeEmailLogin']=async function(_email,_password){return await _0x148122(JSON['stringify']({'email':_email,'password':_password}),'web','email');};` +
      `window['MopeEmailRegister']=async function(_email,_password,_name){try{const _r=await fetch(_0x130605+'/auth/register/email',{'method':'POST','headers':{'Content-Type':'application/json'},'body':JSON['stringify']({'email':_email,'password':_password,'name':_name})});const _j=await _r['json']();if(_j['success']){_0x13cd05(_j['data']);_0x17e761(_j['data']['userId'],_j['data']['token'],_j['data']['userName'],_j['data']['avatar'],'email');return true;}console['error']('REGISTER failed:',_j['error']);return false;}catch(_e){console['error']('REGISTER ERROR:',_e);return false;}};`,
  },
];

async function main() {
  let src = await fs.readFile(SRC, 'utf8');
  const results = [];
  for (const p of patches) {
    const idx = src.indexOf(p.anchor);
    if (idx === -1) {
      results.push({ label: p.label, status: 'FAIL (anchor not found)' });
      continue;
    }
    if (src.indexOf(p.anchor, idx + 1) !== -1) {
      results.push({ label: p.label, status: 'FAIL (anchor matched more than once)' });
      continue;
    }
    src = src.slice(0, idx) + p.replacement + src.slice(idx + p.anchor.length);
    results.push({ label: p.label, status: 'OK' });
  }

  const failed = results.filter((r) => r.status !== 'OK');
  console.table(results);
  if (failed.length) {
    console.error('Aborting: not all patches applied cleanly.');
    process.exit(1);
  }

  await fs.writeFile(DST, src, 'utf8');
  const stat = await fs.stat(DST);
  console.log(`Wrote ${DST} (${stat.size} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
