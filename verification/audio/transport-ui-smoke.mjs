// Exercise the production adapter in real Chromium with MusicKit slots that
// disable Play and omit skip buttons despite a valid native audio session.
import {app,BrowserWindow} from 'electron';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const data=mkdtempSync(path.join(tmpdir(),'aml-transport-ui-'));
app.setPath('userData',data);app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
 await w.loadURL('data:text/html,<amp-playback-controls-play><button disabled>Play</button></amp-playback-controls-play><amp-playback-controls-item-skip direction="previous"></amp-playback-controls-item-skip><amp-playback-controls-item-skip direction="next"></amp-playback-controls-item-skip>');
 const src=readFileSync(new URL('../../electron/src/engine/transport-controls.js',import.meta.url),'utf8').replace('export function','function');
 const result=await w.webContents.executeJavaScript(`${src}\n(async()=>{
  let s={active:true,paused:true,canPrevious:true,canNext:true};const calls=[];
  const adapter=installTransportControls({state:()=>s,command:c=>calls.push(c)});
  const initial=document.querySelectorAll('[data-aml-transport]').length;
  document.querySelector('[data-aml-transport="play"]').click();
  s.paused=false;adapter.sync();document.querySelector('[data-aml-transport="play"]').click();
  document.querySelector('[data-aml-transport="next"]').click();document.querySelector('[data-aml-transport="previous"]').click();
  const nativeHidden=document.querySelector('button:not([data-aml-transport])').style.display==='none';
  // MusicKit replaces the slot on a SPA update: adapter remounts automatically.
  document.querySelector('amp-playback-controls-item-skip[direction="next"]').innerHTML='';
  await new Promise(r=>setTimeout(r,30));
  const remounted=!!document.querySelector('[data-aml-transport="next"]');
  s.active=false;adapter.sync();const restored=document.querySelectorAll('[data-aml-transport]').length===0&&document.querySelector('button').style.display==='';adapter.dispose();
  return {initial,calls,nativeHidden,remounted,restored};
 })()`);
 assert.equal(result.initial,3);assert.deepEqual(result.calls,['play','pause','next','previous']);assert.equal(result.nativeHidden,true);assert.equal(result.remounted,true);assert.equal(result.restored,true);
 console.log('PASS: native session controls stay available, dispatch once, remount and restore web controls');
 rmSync(data,{recursive:true,force:true});app.exit(0);
}).catch(e=>{console.error(e);rmSync(data,{recursive:true,force:true});app.exit(1)});
