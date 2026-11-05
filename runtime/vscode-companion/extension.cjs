'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const SCOPES = ['read:user','user:email'];
function readRequest(file) {
  if (process.platform === 'win32' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) throw Error('Protected companion request unavailable');
  const dir = fs.lstatSync(path.dirname(file)); const stat = fs.lstatSync(file);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 8192) throw Error('Protected companion request unavailable');
  const r = JSON.parse(fs.readFileSync(file,'utf8'));
  const u = new URL(r.url);
  if (r.schemaVersion !== 1 || r.resource !== 'https://api.github.com' || JSON.stringify(r.scopes) !== JSON.stringify(SCOPES) || !/^[A-Za-z0-9_-]{43}$/.test(r.bearer) || !/^[A-Za-z0-9_-]{16,100}$/.test(r.nonce) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now()+300000 || typeof r.interactive !== 'boolean' || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/provider' || u.username || u.password || u.search || u.hash || (r.account !== undefined && (!r.account || typeof r.account.id !== 'string' || typeof r.account.label !== 'string'))) throw Error('Invalid protected companion request');
  return r;
}
async function runAuthentication(vscode, file) {
  const r = readRequest(file);
  const options = r.interactive ? {createIfNone:true,...(r.account ? {account:r.account} : {})} : {silent:true,...(r.account ? {account:r.account} : {})};
  const session = await vscode.authentication.getSession('github', SCOPES, options);
  if (!session || typeof session.accessToken !== 'string' || !session.accessToken || session.accessToken.length > 16384 || !session.account || typeof session.account.id !== 'string' || typeof session.account.label !== 'string' || (r.account && session.account.id !== r.account.id) || !Array.isArray(session.scopes) || session.scopes.length !== SCOPES.length || !SCOPES.every(s=>session.scopes.includes(s))) throw Error('Selected Copilot account or scopes unavailable');
  const body = JSON.stringify({nonce:r.nonce,resource:r.resource,scopes:SCOPES,account:{id:session.account.id,label:session.account.label},token:session.accessToken});
  await new Promise((resolve,reject)=>{
    const req=http.request(r.url,{method:'POST',headers:{authorization:'Bearer '+r.bearer,'content-type':'application/json','content-length':Buffer.byteLength(body)},timeout:10000},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('Companion authentication not accepted')))});
    req.on('timeout',()=>req.destroy()); req.on('error',()=>reject(Error('Companion authentication unavailable')));req.end(body);
  });
}
let timer;
function activate(context) {
  const vscode=require('vscode'); const file=process.env.SF_COMPANION_REQUEST;
  if (!file) return;
  let last='', busy=false;
  const poll=async()=>{if(busy)return;let request;try{request=readRequest(file)}catch{return}if(request.nonce===last)return;last=request.nonce;busy=true;try{await runAuthentication(vscode,file)}catch{void vscode.window.showErrorMessage('Software Factory could not authenticate the selected Copilot account.')}finally{busy=false}};
  timer=setInterval(()=>void poll(),1000);void poll();context.subscriptions.push({dispose(){clearInterval(timer)}});
}
function deactivate(){if(timer)clearInterval(timer)}
module.exports={activate,deactivate,runAuthentication,readRequest};
