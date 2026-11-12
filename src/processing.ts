type PreparedJpeg = { blob: Blob; encoder: string };
type ProcessingJob = { tabId:number; generation:string; url:string; kind:'thumbnail'|'jpeg'; engine:JpegEngine; urgent?:boolean };
const preparationJobs = new Map<string, Promise<void>>();
const preparationQueue: { job:ProcessingJob; finish():void }[] = [];
let preparationRunning = false;
let activePreparation: {job:ProcessingJob; controller:AbortController}|undefined;
const preparationErrors = new Map<string,string>();
const preparationNativeStates = new Map<string,{unavailable?:boolean}>();

function processingKey(job:ProcessingJob):string { return JSON.stringify([job.tabId,job.generation,job.url,job.kind,job.engine]); }
function jpegCacheKey(tabId:number,generation:string,url:string,engine:JpegEngine):IDBValidKey[] {
  return [tabId,generation,url,'jpeg97-444-v1:'+engine];
}
function cancelCapturePreparation(tabId:number):void {
  for(const key of preparationNativeStates.keys())if(JSON.parse(key)[0]===tabId)preparationNativeStates.delete(key);
  for(const key of preparationErrors.keys())if(JSON.parse(key)[0]===tabId)preparationErrors.delete(key);
  if(activePreparation?.job.tabId===tabId)activePreparation.controller.abort();
  for(let i=preparationQueue.length-1;i>=0;i--)if(preparationQueue[i].job.tabId===tabId){
    const item=preparationQueue.splice(i,1)[0];preparationJobs.delete(processingKey(item.job));item.finish();
  }
}

async function storedProcessingCapture(tabId:number):Promise<StoredCapture|undefined>{
  return captureTransaction((sessions,_images,done)=>{const request=sessions.get(tabId);request.onsuccess=()=>done(request.result);});
}

async function readProcessingImage(job:ProcessingJob):Promise<Uint8Array|undefined>{
  return captureTransaction((sessions,images,done)=>{
    const session=sessions.get(job.tabId);
    session.onsuccess=()=>{
      const state=session.result as StoredCapture|undefined;
      if(state?.generation!==job.generation || !state.entries.some(page=>page.url===job.url&&page.saveState==='saved')){done(undefined);return;}
      const key=[job.tabId,job.generation,job.url];const manifest=images.get(key);
      manifest.onsuccess=()=>{
        const total=manifest.result?.total;
        if(!manifest.result?.complete||!Number.isSafeInteger(total)||total<1||total>64*1024*1024){done(undefined);return;}
        const bytes=new Uint8Array(total);let remaining=Math.ceil(total/(256*1024)),invalid=false;
        for(let offset=0;offset<total;offset+=256*1024){
          const request=images.get([...key,offset]);request.onsuccess=()=>{
            const part=request.result;
            if(part?.total!==total||part?.data?.length!==Math.min(256*1024,total-offset))invalid=true;
            else bytes.set(part.data,offset);
            if(!--remaining)done(invalid?undefined:bytes);
          };
        }
      };
    };
  });
}

async function cachedProcessingValue(job:ProcessingJob):Promise<unknown>{
  return captureTransaction((_sessions,images,done)=>{
    const key=job.kind==='thumbnail'?[job.tabId,job.generation,job.url,'thumbnail']:jpegCacheKey(job.tabId,job.generation,job.url,job.engine);
    const request=images.get(key);request.onsuccess=()=>done(request.result);
  });
}

async function performPreparation(job:ProcessingJob,signal:AbortSignal):Promise<void>{
  if(await cachedProcessingValue(job))return;
  const state=await storedProcessingCapture(job.tabId);
  if(state?.generation!==job.generation)return;
  const bytes=await readProcessingImage(job);
  if(!bytes||signal.aborted)return;
  let value:unknown;
  if(job.kind==='thumbnail')value={dataUrl:await createCapturedThumbnail(bytes)};
  else {
    let encoder='Built-in';
    const nativeKey=JSON.stringify([job.tabId,job.generation]);
    let nativeState=preparationNativeStates.get(nativeKey);
    if(!nativeState){nativeState={};preparationNativeStates.set(nativeKey,nativeState);}
    const converted=await jpegImageBytes(bytes,job.engine,job.engine==='auto'?nativeState:{},()=>{},used=>{encoder=used;},signal);
    value={blob:new Blob([new Uint8Array(converted)],{type:'image/jpeg'}),encoder};
  }
  if(signal.aborted)return;
  await captureTransaction<void>((sessions,images,done)=>{
    const request=sessions.get(job.tabId);request.onsuccess=()=>{
      const current=request.result as StoredCapture|undefined;
      if(current?.generation===job.generation && (job.kind!=='thumbnail'||(current.previewVersion??0)===(state.previewVersion??0))){
        const key=job.kind==='thumbnail'?[job.tabId,job.generation,job.url,'thumbnail']:jpegCacheKey(job.tabId,job.generation,job.url,job.engine);
        images.put(value,key);
      }
      done();
    };
  });
  void browser.runtime.sendMessage({action:'preparation-ready',tabId:job.tabId,generation:job.generation,url:job.url}).catch(()=>{});
}

function queuePreparation(job:ProcessingJob):Promise<void>{
  const key=processingKey(job);const running=preparationJobs.get(key);
  if(running){
    if(job.urgent){const queued=preparationQueue.find(item=>processingKey(item.job)===key);if(queued)queued.job.urgent=true;}
    return running;
  }
  let finish!:()=>void;const promise=new Promise<void>(resolve=>{finish=resolve;});
  preparationJobs.set(key,promise);preparationQueue.push({job,finish});
  void drainPreparationQueue();return promise;
}

async function drainPreparationQueue():Promise<void>{
  if(preparationRunning)return;preparationRunning=true;
  try{
    while(preparationQueue.length){
      const urgent=preparationQueue.findIndex(item=>item.job.urgent);
      const preferred=urgent>=0?urgent:preparationQueue.findIndex(item=>item.job.kind==='thumbnail');
      const item=preparationQueue.splice(preferred<0?0:preferred,1)[0];
      const controller=new AbortController();activePreparation={job:item.job,controller};
      try{await performPreparation(item.job,controller.signal);preparationErrors.delete(processingKey(item.job));}
      catch(error){if(!controller.signal.aborted)preparationErrors.set(processingKey(item.job),String(error));}
      finally{preparationJobs.delete(processingKey(item.job));item.finish();activePreparation=undefined;}
      await new Promise(resolve=>setTimeout(resolve,0)); // Yield to capture/storage messages.
    }
  }finally{preparationRunning=false;}
}

function enqueueCapturePreparation(tabId:number,generation:string,url:string):void{
  void (async()=>{
    const state=await storedProcessingCapture(tabId);if(state?.generation!==generation)return;
    void queuePreparation({tabId,generation,url,kind:'thumbnail',engine:'builtin'});
    if(state.preparation?.jpeg && state.entries.some(page=>page.url===url&&page.selected)){
      void queuePreparation({tabId,generation,url,kind:'jpeg',engine:state.preparation.engine});
    }
  })().catch(()=>{});
}

async function processingRequest(message:{action:string;tabId:number;generation:string;url?:string;engine?:JpegEngine;offset?:number;preparation?:PreparationOptions}){
  let state=await storedProcessingCapture(message.tabId);
  if(!state||state.generation!==message.generation)return {error:'Capture changed. Refresh the review.'};
  if(message.action==='processing-config'){
    if(!message.preparation||typeof message.preparation.jpeg!=='boolean'||!['auto','builtin','imagemagick'].includes(message.preparation.engine))return{error:'Invalid preparation settings.'};
    if(state.preparation && (state.preparation.jpeg!==message.preparation.jpeg||state.preparation.engine!==message.preparation.engine)){
      const pending=[...preparationJobs.entries()].filter(([key])=>JSON.parse(key)[0]===message.tabId).map(([,promise])=>promise);
      cancelCapturePreparation(message.tabId);await Promise.all(pending);
    }
    const preparation=message.preparation;
    await captureTransaction<void>((sessions,_images,done)=>{const request=sessions.get(message.tabId);request.onsuccess=()=>{
      const latest=request.result as StoredCapture|undefined;if(latest?.generation===message.generation){latest.preparation=preparation;sessions.put(latest,message.tabId);}done();
    };});
    state={...state,preparation};
  }
  if(['processing-config','processing-status','processing-progress'].includes(message.action)){
    if(message.action!=='processing-progress')for(const page of state.entries)if(page.url.startsWith('blob:')&&page.saveState==='saved')enqueueCapturePreparation(message.tabId,state.generation,page.url);
    return {ok:true,preparation:state.preparation,pending:[...preparationJobs.keys()].filter(key=>JSON.parse(key)[0]===message.tabId).length,
      errors:[...preparationErrors.entries()].filter(([key])=>JSON.parse(key)[0]===message.tabId).map(([,error])=>error)};
  }
  if(message.action!=='processing-jpeg'||!message.url||!state.entries.some(page=>page.url===message.url))return{miss:true};
  const engine=message.engine||'auto';if(!['auto','builtin','imagemagick'].includes(engine))return{error:'Invalid JPEG engine.'};
  const job:ProcessingJob={tabId:message.tabId,generation:message.generation,url:message.url,kind:'jpeg',engine,urgent:true};
  if(!await cachedProcessingValue(job))await queuePreparation(job);
  const value=await cachedProcessingValue(job) as PreparedJpeg|undefined;
  if(!value?.blob)return {miss:true,error:preparationErrors.get(processingKey(job))};
  const offset=message.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>=value.blob.size)return{error:'Invalid prepared JPEG offset.'};
  const bytes=new Uint8Array(await value.blob.slice(offset,offset+256*1024).arrayBuffer());
  let binary='';for(let index=0;index<bytes.length;index++)binary+=String.fromCharCode(bytes[index]);
  return {generation:message.generation,offset,total:value.blob.size,base64:btoa(binary),encoder:value.encoder};
}

browser.runtime.onMessage.addListener((message:Parameters<typeof processingRequest>[0],sender:{id?:string;url?:string})=>{
  if(!message.action?.startsWith('processing-'))return undefined;
  if(sender.id!==browser.runtime.id||!sender.url?.startsWith(browser.runtime.getURL(''))||!Number.isSafeInteger(message.tabId))return Promise.resolve({error:'Invalid processing sender.'});
  return processingRequest(message).catch((error:unknown)=>({error:String(error)}));
});
