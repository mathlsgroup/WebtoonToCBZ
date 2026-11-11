'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const {createHost,CHUNK}=require('../native-host/host.cjs');
let magick;
try {magick=execFileSync(process.platform==='win32'?'where.exe':'which',[process.platform==='win32'?'magick.exe':'magick'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/)[0];}catch{}

test('real ImageMagick encodes quality 97, native size and 4:4:4 for white and colored RGBA',{skip:!magick},async()=>{
  for(const colored of [false,true]){
    const host=createHost(magick);const width=257,height=257;
    const pixels=Buffer.alloc(width*height*4,255);
    if(colored)for(let i=0;i<pixels.length;i+=4){pixels[i]=i%256;pixels[i+1]=(i*3)%256;pixels[i+2]=255-pixels[i];}
    assert.equal((await host.handle({action:'ping'})).sampling,'4:4:4');
    await host.handle({action:'begin',width,height});
    for(let offset=0;offset<pixels.length;offset+=CHUNK)await host.handle({action:'write',offset,base64:pixels.subarray(offset,offset+CHUNK).toString('base64')});
    const encoded=await host.handle({action:'encode'});const parts=[];
    for(let offset=0;offset<encoded.total;offset+=CHUNK)parts.push(Buffer.from((await host.handle({action:'read',offset})).base64,'base64'));
    const jpeg=Buffer.concat(parts);
    const info=execFileSync(magick,['identify','-format','%w %h %Q %[jpeg:sampling-factor]','jpeg:-'],{input:jpeg,encoding:'utf8',windowsHide:true});
    assert.equal(info,width+' '+height+' 97 1x1,1x1,1x1');
    host.dispose();
  }
});

test('native host refuses arbitrary commands, paths, invalid dimensions and incomplete pixel transfers',{skip:!magick},async()=>{
  const host=createHost(magick);
  await assert.rejects(host.handle({action:'exec',command:'anything'}),/Unsupported/);
  await assert.rejects(host.handle({action:'begin',width:-1,height:2}),/dimensions/);
  await host.handle({action:'begin',width:2,height:2});
  await assert.rejects(host.handle({action:'encode'}),/incomplete/);
  await assert.rejects(host.handle({action:'write',offset:0,base64:'file:///private'}),/Invalid/);
  host.dispose();
});

test('native executable implements fragmented length-prefixed Firefox stdio messages',{skip:!magick},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'WebtoonToCBZ-native-test-'));
  const config=path.join(directory,'config.json');fs.writeFileSync(config,JSON.stringify({magick}));
  const child=spawn(process.execPath,[path.resolve('native-host/host.cjs'),'--config',config],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const response=new Promise((resolve,reject)=>{
    let buffer=Buffer.alloc(0);
    const timer=setTimeout(()=>reject(new Error('Native ping timed out')),10000);
    child.stdout.on('data',data=>{
      buffer=Buffer.concat([buffer,data]);
      if(buffer.length>=4&&buffer.length>=buffer.readUInt32LE(0)+4){clearTimeout(timer);resolve(JSON.parse(buffer.subarray(4).toString('utf8')));}
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{if(code){clearTimeout(timer);reject(new Error('Native host failed: '+code));}});
  });
  try{
    const body=Buffer.from(JSON.stringify({id:1,action:'ping'}));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
    child.stdin.write(header.subarray(0,2));
    await new Promise(resolve=>setTimeout(resolve,5));
    child.stdin.write(Buffer.concat([header.subarray(2),body]));
    const result=await response;
    assert.equal(result.id,1);assert.equal(result.protocol,1);assert.equal(result.quality,97);assert.equal(result.sampling,'4:4:4');
  }finally{
    child.stdin.end();await new Promise(resolve=>child.once('close',resolve));
    fs.unlinkSync(config);fs.rmdirSync(directory);
  }
});
