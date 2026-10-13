(() => {
  'use strict';
  let sequence = 0;
  const n = value => Number(value).toFixed(1);
  const p = (x, y, z = 0) => [320 + (x - y) * 0.98, 188 + (x + y) * 0.43 - z];
  const points = items => items.map(point => point.map(n).join(',')).join(' ');
  const poly = (items, fill, extra = '') => `<polygon points="${points(items)}" fill="${fill}" ${extra}/>`;
  const shade = (hex, amount) => '#' + hex.replace('#', '').match(/.{2}/g).map(channel => Math.min(255, Math.max(0, parseInt(channel, 16) + amount)).toString(16).padStart(2, '0')).join('');
  function box(x, y, z, width, depth, height, color, studs = false, extra = '') {
    const a = p(x, y, z + height), b = p(x + width, y, z + height), c = p(x + width, y + depth, z + height), d = p(x, y + depth, z + height);
    let output = `<g ${extra}>${poly([d,c,p(x + width,y + depth,z),p(x,y + depth,z)], shade(color,-32))}${poly([b,c,p(x + width,y + depth,z),p(x + width,y,z)], shade(color,-53))}${poly([a,b,c,d], color)}`;
    if (studs) {
      const step = Math.max(12, Math.min(width, depth) / 5);
      for (let u = step / 2; u < width; u += step) for (let v = step / 2; v < depth; v += step) {
        const q = p(x + u, y + v, z + height + 0.6);
        output += `<ellipse cx="${n(q[0])}" cy="${n(q[1])}" rx="2.5" ry="1.2" fill="${shade(color,14)}" opacity=".6"/>`;
      }
    }
    return output + '</g>';
  }
  function flag(x,y,z,color) {
    const a=p(x,y,z), b=p(x,y,z+38);
    return `<path d="M${a.join(' ')}V${n(b[1])}" stroke="#e8effb" stroke-width="2"/><path d="M${b.join(' ')}l21 5-21 11Z" fill="${color}"/>`;
  }
  function person(x,y,z,color='#5080f4') {
    return `<g>${box(x-3,y-3,z,5,5,8,'#242a40')}${box(x+3,y-3,z,5,5,8,'#242a40')}${box(x-5,y-4,z+8,13,8,13,color)}${box(x-8,y-3,z+9,3,5,11,'#ffcf8a')}${box(x+8,y-3,z+9,3,5,11,'#ffcf8a')}${box(x-3,y-3,z+21,8,7,8,'#ffd393')}</g>`;
  }
  function tree(x,y,z,type='pine',color='#51834e') {
    let out=box(x-2,y-2,z,5,5,17,'#8a6146');
    if(type==='palm'){
      const c=p(x,y,z+29);
      out+=`<g fill="${color}"><path d="M${c.join(' ')}q-28-21-40-5l35 9q-30 7-28 22l33-21q20 24 31 21l-25-24q28-13 38-3q-8-19-36-7Z"/></g>`;
    } else {
      out+=box(x-13,y-13,z+15,27,27,17,color);
      if(type==='pine')out+=box(x-9,y-9,z+30,19,19,13,shade(color,10))+box(x-5,y-5,z+42,11,11,9,shade(color,18));
    }
    return out;
  }
  function windows(x,y,z,width,height,color='#b3ecf3') {
    let out='';
    for(let h=13;h<height-4;h+=14)for(let w=8;w<width-5;w+=13)out+=poly([p(x+w,y,z+h),p(x+w+6,y,z+h),p(x+w+6,y,z+h+7),p(x+w,y,z+h+7)],color,'opacity=".74"');
    return out;
  }
  const cloud = (x,y,scale=1) => `<g transform="translate(${x} ${y}) scale(${scale})" fill="#fff" opacity=".45"><path d="M-37 9c-5-12 4-22 16-21 1-21 37-24 43-3 24-1 29 24 7 28h-54Z"/></g>`;
  function backdrop(kind,id) {
    const palettes = {sky:['#a9d0eb','#d6e9f6'],lava:['#241b31','#714234'],candy:['#b6b5eb','#ede0ed'],space:['#090f24','#233466'],forest:['#afcdd7','#c6ded4'],factory:['#a6b9c9','#d6dbe0'],city:['#1d2c42','#596a88'],island:['#76c9dd','#a2e4de'],neon:['#0a1024','#272543'],snow:['#bbd1dd','#e2eff3'],desert:['#c5c9d5','#ead2ae'],midnight:['#101626','#30374e']};
    const colors=palettes[kind]||palettes.sky;
    let output=`<defs><linearGradient id="${id}-sky" x2="0" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient><radialGradient id="${id}-halo"><stop stop-color="#9aa2ff" stop-opacity=".34"/><stop offset="1" stop-color="#9aa2ff" stop-opacity="0"/></radialGradient></defs><rect width="640" height="360" fill="url(#${id}-sky)"/>`;
    if(['space','neon','midnight','city'].includes(kind)){
      output+='<circle cx="484" cy="72" r="27" fill="#b2b9ed" opacity=".5"/><circle cx="494" cy="65" r="25" fill="'+colors[0]+'" opacity=".9"/>';
      for(let i=0;i<34;i++)output+=`<circle cx="${(i*137+27)%630}" cy="${(i*79+13)%210}" r="${i%3===0?1.3:.7}" fill="#c7d7ff" opacity="${i%3===0?.8:.4}"/>`;
      output+='<ellipse cx="320" cy="285" rx="272" ry="110" fill="url(#'+id+'-halo)"/>';
    }else if(kind==='lava'){
      output+='<path d="M0 157 58 102 115 150 199 72 277 155 346 113 412 168 524 82 640 166V360H0Z" fill="#302437" opacity=".6"/><path d="M0 297Q150 231 333 293T640 288V360H0Z" fill="#ef663d" opacity=".26"/>';
    }else{
      output+=cloud(84,66,1.2)+cloud(536,91,1.6)+cloud(410,35,.8);
      if(['forest','factory','island','desert','snow'].includes(kind))output+='<path d="M0 181 83 134 155 168 225 139 328 183 404 141 488 174 575 138 640 173V360H0Z" fill="'+(kind==='desert'?'#c3a688':kind==='snow'?'#e9f4f6':'#839dac')+'" opacity=".24"/>';
    }
    return output;
  }
  function obby(variant,id) {
    const type=['sky','lava','candy','space'][variant%4];
    let out=backdrop(type,id);
    const colors={sky:['#79c983','#9da8ec','#f3bf6e','#8ab8e5'],lava:['#595667','#e77b45','#c28e62','#776a7f'],candy:['#f0a6c6','#b6a5ef','#9edccf','#f4da8f'],space:['#7884c7','#8de3e6','#b599e3','#8596cb']}[type];
    if(type==='lava')out+=box(-150,-120,-44,300,245,6,'#e96e3e')+`<path d="M120 255q72-19 154 20t175-2" fill="none" stroke="#ffc483" stroke-width="3" opacity=".45"/>`;
    if(type==='space')out+='<path d="M-40 262 682 52M-45 316 684 105M-45 370 682 158M98 20 640 258M-20 40 641 332" stroke="#90b5f2" stroke-width=".7" opacity=".13"/>';
    const platforms=[[-138,35,0,83,73],[-53,40,16,28,30],[-40,0,29,30,29],[2,-14,43,29,27],[10,-60,56,30,30],[57,-65,68,30,30],[70,-120,82,74,62]];
    const rocks=[[-140,40,-16,62,58,16],[-131,47,-36,43,41,20],[80,-110,60,49,43,21],[89,-100,43,32,30,19]];
    if(type!=='space')rocks.forEach(([x,y,z,w,d,h])=>out+=box(x,y,z,w,d,h,type==='lava'?'#514858':type==='candy'?'#b68cbf':'#868d91'));
    platforms.forEach(([x,y,z,w,d],i)=>{out+=box(x,y,z,w,d,9,colors[i%colors.length],true,i===3?'class="sp-focus-block"':'');if(i===1||i===4)out+=box(x+3,y+3,z+9,w-6,d-6,2,type==='lava'?'#ffbd59':'#ecf4f7');});
    for(let i=0;i<4;i++)out+=box(-57+i*10,86-i*9,-2+i*4,8,8,5,colors[(i+1)%4]);
    out+=box(-120,50,9,43,31,2,type==='space'?'#d7e2f0':'#eef5dc')+box(-114,57,11,30,18,1,'#8caf82');
    out+=person(-104,69,13,type==='lava'?'#efab63':type==='space'?'#e9edf4':'#437bc7');
    if(type==='sky'||type==='candy')out+=tree(-132,42,9,'block',colors[0])+tree(-63,95,9,'block',colors[0]);
    if(type==='space')out+=box(-135,38,9,13,18,25,'#d1dce8')+box(-133,37,20,10,2,8,'#74cce1');
    const towerColor=type==='lava'?'#a69ba0':type==='candy'?'#e6c5dc':type==='space'?'#c3cce5':'#d5d9c9';
    out+=box(91,-107,91,35,29,30,towerColor)+box(89,-109,121,39,33,5,shade(towerColor,14));
    out+=box(88,-108,126,8,8,10,towerColor)+box(118,-108,126,8,8,10,towerColor)+box(118,-86,126,8,8,10,towerColor)+box(88,-86,126,8,8,10,towerColor);
    out+=flag(106,-91,135,colors[2]);
    out+=box(95,-76,92,12,3,17,'#596571');
    const q=p(15,-9,54);out+=`<g class="sp-selection" fill="none" stroke="#67d3fc" stroke-width="1.4">${poly([p(1,-15,42),p(32,-15,42),p(32,15,42),p(1,15,42)],'none')}<path d="M${q.join(' ')}v-25m-4 4 4-4 4 4"/></g>`;
    return {html:out,objects:['SpawnLocation','FloatingPlatforms','Checkpoint','FinishTower'],accent:colors[1],name:['Cloud Castle','Lava Run','Candy Cloud','Moonbase'][variant%4]};
  }
  function tycoon(variant,id) {
    const type=['forest','factory','city','island'][variant%4];
    let out=backdrop(type,id);
    out+=box(-147,-127,-24,294,254,22,type==='island'?'#44b8c7':type==='city'?'#526074':type==='factory'?'#95a4ac':'#70a06d');
    if(type==='island')out+=box(-134,-111,-2,268,218,4,'#ddcca2');
    if(type==='city')out+=box(-138,-117,-2,276,234,3,'#424b5d');
    const grass=type==='island'?'#91b572':type==='city'?'#607985':type==='factory'?'#8ca19c':'#9db878';
    out+=box(-133,-115,1,105,229,3,grass)+box(3,-115,1,132,104,3,grass)+box(3,15,1,132,99,3,grass);
    out+=box(-26,-119,1,28,237,1,'#b5b7ab')+box(-135,-11,1,270,23,1,'#b5b7ab');
    for(let i=0;i<7;i++)out+=box(-15,-99+i*31,2,5,13,.5,'#e1dec8');
    const objects=[];
    function add(x,y,draw){objects.push({depth:x+y,draw});}
    if(type==='forest'){
      for(let i=0;i<4;i++)for(let j=0;j<4;j++)add(-123+i*20,-101+j*18,()=>box(-123+i*20,-101+j*18,4,14,11,2,'#6e5946')+box(-120+i*20,-99+j*18,6,6,6,8,j%2?'#dfb455':'#7eb46b'));
      add(21,-96,()=>box(21,-96,4,76,63,38,'#c18d64')+box(18,-99,42,82,69,8,'#8e6056')+box(52,-33,4,18,1,24,'#705743')+windows(21,-96,4,76,36));
      add(54,33,()=>box(54,33,4,47,51,20,'#a98b72')+box(52,31,24,51,55,5,'#97aaa9')+box(63,41,29,28,29,2,'#abcfd8'));
    }else if(type==='factory'){
      add(-122,-93,()=>box(-122,-93,4,78,65,34,'#9eabb4')+box(-124,-95,38,82,69,5,'#c5d0d4')+box(-100,-88,43,13,15,36,'#839199')+box(-72,-79,43,13,15,46,'#839199')+windows(-122,-93,5,76,34));
      add(18,-101,()=>box(18,-101,4,78,57,31,'#aec2cf')+box(16,-103,35,82,61,5,'#e0ba69')+windows(18,-101,4,78,31));
      add(37,24,()=>{let part=box(37,24,4,83,34,7,'#506177');for(let i=0;i<9;i++)part+=box(41+i*8,24,11,2,34,1,'#899aab');return part+box(54,34,12,12,13,8,'#dfb570')+box(91,32,12,14,16,10,'#c3d3dd');});
      add(-115,32,()=>box(-115,32,4,64,49,20,'#7995a4')+box(-111,36,24,56,41,2,'#a6c9d3'));
    }else if(type==='city'){
      [[-121,-102,48,51,99,'#7282a7'],[-69,-101,33,51,65,'#d59c8c'],[19,-103,50,62,81,'#879bb9'],[81,-96,38,52,50,'#bca895'],[-117,27,66,61,42,'#8cabc1'],[26,34,84,53,26,'#9a829e']].forEach(([x,y,w,d,h,color])=>add(x,y,()=>box(x,y,4,w,d,h,color)+box(x-2,y-2,h+4,w+4,d+4,4,shade(color,24))+windows(x,y,4,w,h,type==='city'?'#a6e4ea':'#d4eff0')));
      add(35,48,()=>box(35,48,34,28,10,13,'#ee82cb')+box(70,48,34,28,10,13,'#7de2e5'));
    }else{
      [[-111,-89,49,49],[-67,41,50,45],[43,-101,68,56]].forEach(([x,y,w,d])=>add(x,y,()=>box(x,y,4,w,d,22,'#e4d4ae')+box(x-3,y-3,26,w+6,d+6,7,'#ba8a67')+box(x+8,y,8,17,1,13,'#89b8c0')));
      add(39,35,()=>box(39,35,4,67,59,2,'#e5dfce')+box(46,42,6,53,45,1,'#5cbccc'));
    }
    [[-134,101],[-125,-119],[124,-107],[123,104],[-47,112],[117,2]].forEach(([x,y],i)=>add(x,y,()=>tree(x,y,4,type==='island'?'palm':'pine',type==='city'?'#56857b':type==='island'?'#4e9a69':i%2?'#547e60':'#638f61')));
    add(-7,36,()=>person(-7,36,2,'#e6b46e'));
    objects.sort((a,b)=>a.depth-b.depth).forEach(item=>out+=item.draw());
    return {html:out,objects:['Baseplate',type==='factory'?'ConveyorSystem':type==='city'?'CityBlocks':'Environment','UpgradePads','SpawnLocation'],accent:type==='city'?'#de96d1':'#91c783',name:['Pixel Farm','Rocket Factory','Neon City','Island Resort'][variant%4]};
  }
  function racing(variant,id){
    const type=['neon','snow','desert','midnight'][variant%4];
    let out=backdrop(type,id);
    const soil=type==='snow'?'#ccdde3':type==='desert'?'#ceac7b':'#394354',neon=type==='neon'?'#ed79cf':type==='midnight'?'#8c9ceb':type==='desert'?'#efad67':'#80b1da';
    out+=box(-151,-126,-24,302,252,22,soil);
    const loop=[[-122,-101],[107,-101],[125,-79],[125,80],[107,101],[-108,101],[-126,80],[-126,-79]];
    const path=items=>items.map((q,i)=>`${i?'L':'M'}${p(q[0],q[1],1).join(' ')}`).join(' ')+'Z';
    out+=`<path d="${path(loop)}" fill="none" stroke="${neon}" stroke-width="36" stroke-linejoin="round" opacity=".8"/><path d="${path(loop)}" fill="none" stroke="#353d50" stroke-width="29" stroke-linejoin="round"/><path d="${path(loop)}" fill="none" stroke="#b4c2d2" stroke-width="1" stroke-dasharray="9 10" stroke-linejoin="round" opacity=".6"/>`;
    out+=box(-83,-68,1,166,137,2,type==='snow'?'#eef5f6':type==='desert'?'#d2b485':'#444b69');
    out+=box(-62,-48,3,99,28,28,type==='desert'?'#cd9074':'#7a85ac')+box(-65,-51,31,105,34,5,'#c4d0df');
    out+=windows(-62,-48,3,99,28,'#afd5e5');
    for(let j=0;j<3;j++)for(let i=0;i<8;i++)out+=box(-62+i*12,19+j*10,3,9,8,5+j*3,j%2?neon:'#8c9bb0');
    for(let i=0;i<6;i++)out+=box(42+i*11,-50,3,8,34,3+i*3,'#8496a8');
    for(let row=0;row<3;row++)for(let col=0;col<6;col++)out+=poly([p(-49+col*7,85+row*7,3),p(-42+col*7,85+row*7,3),p(-42+col*7,92+row*7,3),p(-49+col*7,92+row*7,3)],(row+col)%2?'#303849':'#e9e6e0');
    out+=box(-47,75,2,5,5,48,'#c6d2df')+box(-47,119,2,5,5,48,'#c6d2df')+box(-49,75,46,9,49,8,neon);
    [[-124,-116],[-144,88],[139,102],[133,-102]].forEach(([x,y],i)=>out+=type==='desert'?box(x,y,2,8,8,19,'#869a72'):tree(x,y,2,'pine',type==='snow'?'#aec9d1':'#697d8b'));
    function car(x,y,color){return box(x,y,2,23,12,5,'#222a38')+box(x+2,y,7,19,12,6,color)+box(x+6,y+2,13,10,8,5,'#aacbd7')+box(x+1,y+1,7,3,2,2,'#f4e6b6');}
    out+=car(62,94,type==='desert'?'#ec7965':'#dc79c0')+car(-96,-99,'#6cbbdf')+car(111,-16,'#e5c96b');
    out+=person(-19,74,3,'#9faee3');
    const signs=[[-118,-75],[119,54]];
    signs.forEach(([x,y])=>out+=box(x,y,3,3,3,23,'#acb9c8')+box(x-2,y,23,11,3,8,neon));
    return {html:out,objects:['RaceCircuit','CheckpointGates','LapTimer','VehicleSpawns'],accent:neon,name:['Neon Sprint','Snow Circuit','Desert Drift','Midnight Race'][variant%4]};
  }
  const tools = ['↖','✥','↻','▧','⊕','◇','◫','▶'];
  window.renderStudioPreview = ({template='obby',variant=0,large=false}={}) => {
    const index=Math.abs(Math.trunc(Number(variant)||0))%4;
    const kind=['obby','tycoon','racing'].includes(template)?template:'obby';
    const id='sp-'+(++sequence);
    const scene=(kind==='tycoon'?tycoon:kind==='racing'?racing:obby)(index,id);
    return `<div class="sp-workspace${large?' sp-large':''}" aria-label="Illustrative ${scene.name} Roblox Studio workspace" style="--sp-accent:${scene.accent}"><div class="sp-menubar"><span class="sp-studio-mark">◈</span><span>File</span><span>Home</span><span>Model</span><span>Test</span><span>View</span><span class="sp-preview-badge">BUILD PREVIEW</span></div><div class="sp-tools">${tools.map((tool,i)=>`<span${i===1?' class="sp-tool-selected"':''}>${tool}</span>`).join('')}<span class="sp-tool-divider"></span><span class="sp-tool-caption">Move</span><span class="sp-tool-caption">Rotate</span><span class="sp-tool-caption">Scale</span><span class="sp-project">${scene.name}.rbxl</span></div><div class="sp-workarea"><div class="sp-explorer"><div class="sp-pane-title">Explorer <span>⌕</span></div><div class="sp-tree-root">⌄ <b>▧</b> Workspace</div>${scene.objects.map((item,i)=>`<div class="sp-tree-item${i===1?' sp-tree-selected':''}"><span>${i===2?'▤':'◇'}</span>${item}</div>`).join('')}<div class="sp-tree-root">⌄ <b>☀</b> Lighting</div><div class="sp-tree-item"><span>◈</span>Atmosphere</div><div class="sp-tree-root"><b>▣</b> Players</div><div class="sp-tree-root"><b>⌘</b> ReplicatedStorage</div><div class="sp-tree-root"><b>▤</b> ServerScriptService</div><div class="sp-tree-item sp-code-item"><span>▤</span>WorldBuilder</div><div class="sp-explorer-bottom">Objects / starter concept</div></div><div class="sp-viewport"><svg class="sp-scene" viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${scene.html}</svg><span class="sp-camera-mode">Perspective</span><div class="sp-axis" aria-hidden="true"><i>X</i><i>Y</i><i>Z</i></div><div class="sp-cursor" aria-hidden="true"><svg viewBox="0 0 18 22"><path d="m2 1 13 12-7 1-3 6Z" fill="#f5f7fb" stroke="#243445" stroke-width="1.3"/></svg><span>Preview</span></div><span class="sp-watermark">ILLUSTRATIVE WORKSPACE</span></div><div class="sp-properties"><div class="sp-pane-title">Properties</div><div class="sp-property-head">▧ Appearance</div><div><span>Color</span><i></i></div><div><span>Material</span><b>Plastic</b></div><div><span>Reflectance</span><b>0</b></div><div class="sp-property-head">⌁ Transform</div><div><span>Position</span><b>Vector3</b></div><div><span>Size</span><b>Vector3</b></div><div class="sp-property-head">◇ Behavior</div><div><span>Anchored</span><b>☑</b></div><div><span>CanCollide</span><b>☑</b></div></div></div><div class="sp-statusbar"><span>⌘ ${kind==='obby'?'Platform layout':kind==='tycoon'?'World layout':'Circuit layout'}</span><span>Concept · No Studio session</span></div></div>`;
  };
})();
