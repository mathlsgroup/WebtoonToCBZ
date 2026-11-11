'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

if(process.platform!=='win32')throw new Error('This connector installer supports Windows only.');
const name='webtoon_to_cbz.imagemagick';
const registry='HKCU\\Software\\Mozilla\\NativeMessagingHosts\\'+name;
const base=path.resolve(process.env.LOCALAPPDATA,'WebtoonToCBZ');
const directory=path.join(base,'ImageMagickHost');
if(path.dirname(directory)!==base)throw new Error('Invalid connector directory.');
const manifest=path.join(directory,name+'.json');
let registered;
try {
  const result=execFileSync('reg.exe',['query',registry,'/ve'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  registered=result.match(/REG_SZ\s+([^\r\n]+)/)?.[1].trim();
} catch { /* First install. */ }
if(registered && path.resolve(registered).toLowerCase()!==manifest.toLowerCase())throw new Error('A different connector already owns this native host name.');
if(process.argv.includes('--uninstall')) {
  if(process.argv.includes('--dry-run')){console.log(JSON.stringify({removeRegistry:registry,removeFilesFrom:directory},null,2));process.exit(0);}
  if(registered)execFileSync('reg.exe',['delete',registry,'/f'],{stdio:'inherit'});
  for(const file of ['host.cjs','host.cmd','config.json',name+'.json']) {
    const target=path.join(directory,file);
    if(fs.existsSync(target))fs.unlinkSync(target);
  }
  if(fs.existsSync(directory)&&!fs.readdirSync(directory).length)fs.rmdirSync(directory);
  console.log('Removed the current-user Firefox ImageMagick connector.');
  process.exit(0);
}
const magickIndex=process.argv.indexOf('--magick');
const magick=path.resolve(magickIndex>=0?process.argv[magickIndex+1]:execFileSync('where.exe',['magick.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0]);
if(path.basename(magick).toLowerCase()!=='magick.exe' || !fs.statSync(magick).isFile())throw new Error('ImageMagick magick.exe was not found.');
const version=execFileSync(magick,['-version'],{encoding:'utf8',windowsHide:true});
if(!version.startsWith('Version: ImageMagick 7'))throw new Error('ImageMagick 7 is required.');
// Batch expansion is deliberately unavailable in installed paths.
for(const value of [directory,process.execPath,magick])if(/[\r\n"%!]/.test(value))throw new Error('Unsupported character in connector path.');
if(process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({directory,manifest,registry,node:process.execPath,magick,extension:'webtoon-to-cbz@example.local'},null,2));
  process.exit(0);
}
fs.mkdirSync(directory,{recursive:true});
fs.copyFileSync(path.join(__dirname,'host.cjs'),path.join(directory,'host.cjs'));
fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({magick},null,2));
fs.writeFileSync(path.join(directory,'host.cmd'),'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"'+process.execPath+'" "'+path.join(directory,'host.cjs')+'" --config "'+path.join(directory,'config.json')+'"\r\n');
fs.writeFileSync(manifest,JSON.stringify({name,description:'Webtoon to CBZ local ImageMagick JPEG encoder',
  path:path.join(directory,'host.cmd'),type:'stdio',allowed_extensions:['webtoon-to-cbz@example.local']},null,2));
execFileSync('reg.exe',['add',registry,'/ve','/t','REG_SZ','/d',manifest,'/f'],{stdio:'inherit'});
console.log('Installed the current-user Firefox connector. Reload the extension and click Check ImageMagick.');
