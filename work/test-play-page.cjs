'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=fs.existsSync(path.join(__dirname,'parallax/dist/play-page.js'))?path.join(__dirname,'parallax/dist/play-page.js'):path.join(__dirname,'../dist/play-page.js');
const source=fs.readFileSync(file,'utf8');
function fixture(){const window={};vm.runInNewContext(source,{window},{filename:file});return window.RopadPlayPage;}
const game=(overrides={})=>({id:'game-123',gameName:'Skyline Circuit',brief:'Race across a floating city with checkpoints and a timed finish',modelId:'anthropic/claude-opus-5.5',status:'waiting_for_studio',lineage:{version:2},...overrides});

test('publication URL only accepts an exact HTTPS Roblox game host and positive place ID',()=>{
 const api=fixture();for(const url of ['https://www.roblox.com/games/12345','https://roblox.com/games/12345/Skyline-Circuit/'])assert.equal(api.publicationUrl(game({readiness:{publication:{url}}})),'https://www.roblox.com/games/12345');
 for(const url of ['http://www.roblox.com/games/123','https://www.roblox.com.evil.test/games/123','https://www.roblox.com@evil.test/games/123','https://evil@www.roblox.com/games/123','https://www.roblox.com:443/games/123','https://www.roblox.com/games/0','https://www.roblox.com/games/-1','https://www.roblox.com/games/123?redirect=evil','https://www.roblox.com/games/123#fragment','https://www.roblox.com/games/123/../users','https://www.roblox.com\\@evil.test/games/123','javascript:alert(1)','//www.roblox.com/games/123','https://www.roblox.com/games/123\n','https://www.roblox.com/games/123/slug/more','https://www.roblox.com/games/%31%32%33',null,{},123])assert.equal(api.publicationUrl(game({readiness:{publication:{url}}})),'',String(url));
});
test('missing release has a disabled play action, token navigation and honest status without fake gameplay',()=>{
 const html=fixture().render(game());assert.match(html,/^<main class="rp-play-page"/);assert.match(html,/<\/main>$/);assert.match(html,/disabled>Play in Roblox/);assert.match(html,/Your game is taking shape/);assert.match(html,/href="#\/token\/game-123"/);assert.match(html,/Artwork pending/);assert.match(html,/Roblox Player/);assert.doesNotMatch(html,/data-builder-action="review"|<iframe|<canvas|<video|LIVE|players online|href="https:\/\/www.roblox.com\/games/);
});
test('a creator supplied release opens Roblox with a clear availability label and no certification',()=>{
 const html=fixture().render(game({readiness:{publication:{url:'https://www.roblox.com/games/12345',verified:false,source:'creator_report'}}}));assert.match(html,/href="https:\/\/www.roblox.com\/games\/12345" target="_blank" rel="noopener noreferrer"/);assert.match(html,/Open in Roblox/);assert.match(html,/Creator supplied · Availability not verified/);assert.doesNotMatch(html,/disabled>Play|data-builder-action="review"|Open creator workspace|published successfully/i);
});
test('only an eligible creator sees release review and owner tools never appear for a spectator',()=>{
 const api=fixture(),ready=game({status:'ready',canManage:true,playtestReport:{result:'passed'},delivery:{available:true,format:'rbxlx',url:'/api/builds/game-123/artifact?format=rbxlx'}});
 const owner=api.render(ready);assert.match(owner,/data-builder-action="review"/);assert.match(owner,/#\/workspace\/game-123/);assert.match(owner,/Download Studio project/);assert.match(owner,/Not published yet/);
 for(const build of [{...ready,canManage:false},{...ready,canManage:'true'},{...ready,status:'building'},{...ready,playtestReport:{result:'failed'}}])assert.doesNotMatch(api.render(build),/data-builder-action="review"/);
 const publicHtml=api.render({...ready,canManage:false});assert.doesNotMatch(publicHtml,/CREATOR CONTROLS|Download Studio project|#\/workspace/);
});
test('saved images remain local and labeled artwork or capture; foreign or mismatched paths are rejected',()=>{
 const api=fixture(),base=game(),image='/api/builds/game-123/thumbnail/image?v=abc123';
 assert.match(api.render({...base,thumbnail:{imageUrl:image}}),/AI-generated game artwork/);assert.match(api.render({...base,thumbnail:{imageUrl:image}}),/data-play-image src="\/api\/builds\/game-123\/thumbnail\/image\?v=abc123"/);
 for(const url of ['https://evil.test/image.png','/api/builds/other/thumbnail/image?v=abc123','//evil.test/thumbnail/image?v=abc123',image+'&bad=1',image+'#hash',image+'" onerror="alert(1)', '/api/builds/game-123/thumbnail/image'])assert.doesNotMatch(api.render({...base,thumbnail:{imageUrl:url}}),/<img data-play-image /);
 assert.match(api.render({...base,screenshot:{url:'/api/builds/game-123/screen'}}),/Captured Roblox Studio view/);
 assert.doesNotMatch(api.render({...base,screenshot:{url:'https://evil.test/capture'}}),/<img data-play-image /);
 const frame={view:'overview',source:'pooled_studio_worker',jobId:'job-1',hash:'a'.repeat(64)};assert.match(api.render({...base,jobId:'job-1',visualFrames:[frame]}),/screen\?view=overview&amp;v=aaaa/);assert.doesNotMatch(api.render({...base,jobId:'job-2',visualFrames:[frame]}),/<img data-play-image /);
});
test('untrusted project fields are escaped and malformed identity or downloads never create unsafe links',()=>{
 const api=fixture(),attack='<img src=x onerror=alert(1)>';
 const html=api.render(game({gameName:attack,brief:attack,modelId:'other/unknown',modelName:attack,plan:{design:{objective:attack}},canManage:true,delivery:{available:true,format:'rbxlx',url:'https://evil.test/file'}}));assert.doesNotMatch(html,/<img src=x|onerror="|href="https:\/\/evil/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/Download Studio project/);
 for(const id of ['../secret','x" onclick="alert(1)','a/b','',null,'a'.repeat(129)]){const invalid=api.render(game({id}));assert.match(invalid,/^<main /);assert.match(invalid,/This game could not be opened/);assert.doesNotMatch(invalid,/token\/|workspace\//);}
 assert.doesNotMatch(api.render(game({id:'a'.repeat(128)})),/This game could not be opened/);
});
test('failed or cached broken images expose an honest fallback without making any requests',()=>{
 const api=fixture(),image={complete:false,naturalWidth:0,hidden:false},fallback={hidden:true},label={textContent:'AI-generated game artwork'},root={querySelector:q=>({'[data-play-image]':image,'[data-play-image-fallback]':fallback,'[data-play-image-label]':label}[q])};
 api.wire(game(),root);image.onerror();assert.equal(image.hidden,true);assert.equal(fallback.hidden,false);assert.equal(label.textContent,'Saved image unavailable');image.onload();assert.equal(fallback.hidden,true);assert.equal(image.hidden,false);assert.equal(label.textContent,'AI-generated game artwork');
 image.complete=true;api.wire(game(),root);assert.equal(image.hidden,true);assert.equal(fallback.hidden,false);assert.doesNotThrow(()=>api.wire(game(),{querySelector:()=>null}));
});
test('public game copy prefers the saved game summary or gameplay design over build instructions',()=>{
 const api=fixture(),brief='Keep it compact with 24 to 30 parts and write a scene plan';
 const summary=api.render(game({brief,plan:{summary:'Race across the city skyline and finish before the timer',design:{coreLoop:'Pass through neon gates',objective:'Reach the final rooftop'}}}));
 assert.match(summary,/About this game/);assert.match(summary,/Race across the city skyline and finish before the timer/);assert.match(summary,/Reach the final rooftop/);assert.doesNotMatch(summary,/24 to 30 parts|write a scene plan|From a prompt to a place/);
 const loop=api.render(game({brief,plan:{summary:' ',design:{coreLoop:'Collect stars and cross the city',objective:'Reach the final rooftop'}}}));assert.match(loop,/Collect stars and cross the city/);assert.doesNotMatch(loop,/24 to 30 parts/);
 const objective=api.render(game({brief,plan:{design:{objective:'Reach the final rooftop'}}}));assert.match(objective,/Reach the final rooftop/);assert.doesNotMatch(objective,/24 to 30 parts/);
 assert.match(api.render(game({brief:'Explore a quiet island'})),/Explore a quiet island/);
});
test('long descriptions stop on word boundaries without adding marketing copy',()=>{
 const summary=Array.from({length:100},(_,i)=>'checkpoint'+i).join(' '),html=fixture().render(game({plan:{summary}}));
 const heading=html.match(/<div class="rp-play-heading">[\s\S]*?<p>([^<]+)<\/p>/)[1];assert.ok(heading.length<=260);assert.ok(heading.endsWith('…'));assert.ok(summary.startsWith(heading.slice(0,-1)));assert.equal(summary[heading.length-1],' ');
 assert.doesNotMatch(html,/viral|popular|millions of players|award-winning/i);
});
test('historical game models retain their saved identity and provider instead of a current builder label',()=>{
 const api=fixture(),historical=api.render(game({modelId:'google/gemini-2.5-flash'}));assert.match(historical,/google\/gemini-2.5-flash/);assert.match(historical,/assets\/model-logos\/google.svg/);assert.doesNotMatch(historical,/AI builder|Claude Opus|GPT-6 Astra|<select/);
 assert.match(api.render(game({modelId:'google/gemini-2.5-flash',modelName:'Gemini 2.5 Flash'})),/<strong>Gemini 2.5 Flash<\/strong>/);
 assert.match(api.render(game({modelId:'',modelName:''})),/Model not selected/);
});
