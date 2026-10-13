const fs=require('node:fs/promises');
const path=require('node:path');
const output=path.join(__dirname,'parallax','camera-catalog.json');
const rawDir=path.join(__dirname,'camera-catalog-sources');
const cameras=[], reports=[];
const httpsUrl=v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)?v:null;}catch{return null;}};
async function load(name,url,headers={}){
 const response=await fetch(url,{headers:{'Accept-Encoding':'gzip',...headers},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error(`${name}: HTTP ${response.status}`);
 const value=await response.json(); await fs.writeFile(path.join(rawDir,`${name}.json`),JSON.stringify(value));return value;
}
async function caltrans(d){
 const url=`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2,'0')}.json`;
 const json=await load(`caltrans-d${d}`,url);let count=0,excluded=0;
 for(const row of json.data||[]){
  const c=row.cctv,l=c.location||{},s=c.imageData?.static||{};
  const image=httpsUrl(s.currentImageURL),stream=httpsUrl(c.imageData?.streamingVideoURL);
  if(String(c.inService).toLowerCase()!=='true'||(!image&&!stream)){excluded++;continue;}
  const minutes=Number(s.currentImageUpdateFrequency);
  cameras.push({id:`caltrans-d${d}-${c.index}`,name:l.locationName||`Caltrans D${d} camera ${c.index}`,city:l.nearbyPlace?`${l.nearbyPlace}, US`:'California, US',region:'california',provider:'Caltrans',interval:Number.isFinite(minutes)&&minutes>0?Math.max(60,minutes*60):300,source:'https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm',license:'https://dot.ca.gov/conditions-of-use',image,stream,lat:Number(l.latitude),lon:Number(l.longitude),providerListed:true,providerAvailable:true,providerId:String(c.index),district:d,registry:url,providerIntervalMinutes:Number.isFinite(minutes)&&minutes>0?minutes:null});count++;
 }
 reports.push({provider:'Caltrans',district:d,listed:json.data?.length||0,included:count,excluded,registry:url});
}
async function finland(){
 const url='https://tie.digitraffic.fi/api/weathercam/v1/stations';
 const json=await load('finland',url,{'Digitraffic-User':'Parallax/PublicCameraCatalog'});let count=0,excludedStations=0,excludedPresets=0;
 const allowedStates=new Set([null,undefined,'','OK','OK_FAULT_DOUBT_CANCELLED','REPAIR_MAINTENANCE_DONE']);
 for(const f of json.features||[]){const p=f.properties||{};
  if(p.collectionStatus!=='GATHERING'||!allowedStates.has(p.state)){excludedStations++;continue;}
  for(const preset of p.presets||[]){
   if(preset.inCollection!==true||!/^C\d{7}$/.test(preset.id)){excludedPresets++;continue;}
   cameras.push({id:`fi-${preset.id}`,name:`${p.name||p.id} / ${preset.id}`,city:'Finland',region:'finland',provider:'Fintraffic / digitraffic.fi',interval:600,source:'https://www.digitraffic.fi/en/road-traffic/#weather-cameras',license:'https://creativecommons.org/licenses/by/4.0/',image:`https://weathercam.digitraffic.fi/${preset.id}.jpg`,stream:null,lat:f.geometry.coordinates[1],lon:f.geometry.coordinates[0],providerListed:true,providerAvailable:true,providerState:p.state??null,collectionStatus:p.collectionStatus,stationId:p.id,providerId:preset.id,registry:url,imageUrlBasis:'Provider-documented preset URL template'});count++;
  }
 }
 reports.push({provider:'Fintraffic / digitraffic.fi',listedStations:json.features?.length||0,includedPresets:count,excludedStations,excludedPresets,registry:url,notes:'Catalogue supplies names, coordinates and active preset IDs. Image URLs use the documented preset URL template. Null state is unknown; GATHERING and inCollection true are required. No per-image liveness validation.'});
}
async function singapore(){
 const url='https://api.data.gov.sg/v1/transport/traffic-images';const json=await load('singapore',url);
 const names={'2701':'Woodlands Causeway (Towards Johor)','2702':'Woodlands Checkpoint','2704':'BKE (Woodlands Checkpoint) - Woodlands F/O','4703':'Tuas Second Link','4712':'AYE(Tuas) - Tuas Ave 8 Exit','4713':'Tuas Checkpoint','4798':'Sentosa Tower 1','4799':'Sentosa Tower 2'};let count=0;
 for(const c of json.items?.at(-1)?.cameras||[]){if(!httpsUrl(c.image))continue;
 cameras.push({id:`sg-${c.camera_id}`,name:names[c.camera_id]||`Singapore camera ${c.camera_id}`,city:'Singapore',region:'singapore',provider:'LTA / data.gov.sg',interval:120,source:'https://data.gov.sg/datasets/d_6cdb6b405b25aaaacbaf7689bcc6fae0/view',license:'https://data.gov.sg/open-data-licence',image:c.image,stream:null,lat:c.location.latitude,lon:c.location.longitude,apiCameraId:c.camera_id,providerListed:true,providerAvailable:true,providerId:c.camera_id,registry:url,capturedAt:c.timestamp,imageUrlBasis:'Snapshot URL; resolve fresh image URL by apiCameraId at request time'});count++;
 }reports.push({provider:'LTA / data.gov.sg',included:count,registry:url});
}
async function tfl(){
 const url='https://api.tfl.gov.uk/Place/Type/JamCam';const json=await load('tfl',url);let count=0,excluded=0;
 for(const c of json){const props=Object.fromEntries((c.additionalProperties||[]).map(p=>[p.key,p.value]));const image=httpsUrl(props.imageUrl);
  if(props.available!=='true'||!image){excluded++;continue;}
  cameras.push({id:`tfl-${c.id.replace(/^JamCams_/,'')}`,name:c.commonName,city:'London, UK',region:'london',provider:'TfL',interval:120,source:'https://tfl.gov.uk/info-for/open-data-users/our-open-data',license:'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',image,stream:null,videoClip:httpsUrl(props.videoUrl),lat:c.lat,lon:c.lon,providerListed:true,providerAvailable:true,providerId:c.id,registry:url,displayConstraints:{mustNotCrop:true,maxDisplayAgeSeconds:900},mediaKind:'provider-snapshot'});count++;
 }reports.push({provider:'TfL',listed:json.length,included:count,excluded,registry:url,notes:'Only available=true. MP4 is videoClip, not a live stream. Preserve image branding, do not crop; retire stale displayed snapshots after 15 minutes.'});
}
(async()=>{
 await fs.mkdir(rawDir,{recursive:true});
 const tasks=[...Array.from({length:12},(_,i)=>()=>caltrans(i+1)),finland,singapore,tfl];
 let next=0;const failures=[];
 await Promise.all(Array.from({length:3},async()=>{while(next<tasks.length){const index=next++;try{await tasks[index]();}catch(e){failures.push(String(e));}}}));
 cameras.sort((a,b)=>a.id.localeCompare(b.id));
 const ids=new Set();for(const c of cameras){if(ids.has(c.id))throw new Error(`Duplicate id ${c.id}`);ids.add(c.id);if(!Number.isFinite(c.lat)||!Number.isFinite(c.lon))throw new Error(`Bad coordinates ${c.id}`);}
 const result={retrievedAt:new Date().toISOString(),scope:'Official public provider-listed camera views from all 12 Caltrans districts, Finland, Singapore and TfL London. Not worldwide coverage; image endpoints have not been individually checked.',cameras,reports,failures};
 await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({output,count:cameras.length,byProvider:cameras.reduce((r,c)=>(r[c.provider]=(r[c.provider]||0)+1,r),{}),streams:cameras.filter(c=>c.stream).length,videoClips:cameras.filter(c=>c.videoClip).length,reports,failures},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
