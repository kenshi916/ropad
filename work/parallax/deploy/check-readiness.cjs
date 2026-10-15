'use strict';
// Read-only configuration checks: never emit values, addresses, paths, saved
// projects, API responses or exception messages. No network or file writes.
const fs=require('node:fs'),path=require('node:path');
const present=v=>typeof v==='string'&&v.trim().length>0;
// Inspect only the shipped frontend, not saved games or runtime captures. This
// catches deploying the old disconnected Sites preview instead of the app.
function checkFrontend(appDirectory){
  const root=path.resolve(appDirectory,'dist'),checks={frontendAssetsPresent:false,frontendPreviewDisabled:false};
  try{
    const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
    checks.frontendPreviewDisabled=!/hosting-status\.(?:js|css)|hosted-interface|production backend is not connected/i.test(html);
    const urls=[...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(match=>match[1]);
    const required=['builders.js','ropad-solana.js','ropad-trade.js','token-page.js','fee-sharing.js','release-center.js','roblox-account.js','roblox-oauth-callback.html','roblox-oauth-callback.js'];
    checks.frontendAssetsPresent=urls.length>0&&[...urls,...required].every(value=>{
      const url=new URL(value,'https://ropad.invalid/');
      if(url.origin!=='https://ropad.invalid'||url.username||url.password||/%2f|%5c/i.test(url.pathname))return false;
      const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
      if(!file.startsWith(root+path.sep))return false;
      const stat=fs.statSync(file);return stat.isFile()&&stat.size>0;
    });
  }catch{checks.frontendAssetsPresent=false;}
  return checks;
}
function checkReadiness({env=process.env,stateDirectory=env.PARALLAX_STATE_DIR||path.join(__dirname,'..','private'),appDirectory=path.join(__dirname,'..')}={}){
  const checks={singleProcessRequired:true,mainnetExplicitlyEnabled:env.ROPAD_SOLANA_MAINNET_ENABLED==='1',mainnetExplicitlyDisabled:env.ROPAD_SOLANA_MAINNET_ENABLED==='0',inferenceKeyConfigured:present(env.OPENROUTER_API_KEY),providerManagementKeyConfigured:present(env.OPENROUTER_MANAGEMENT_KEY),robloxPublishingKeyConfigured:present(env.ROBLOX_OPEN_CLOUD_API_KEY)},missing=[];let runtime;
  Object.assign(checks,checkFrontend(appDirectory));
  try{runtime=require('../runtime-config.cjs').readRuntimeConfig({stateDirectory,env});checks.runtimeConfigurationValid=true;}catch{checks.runtimeConfigurationValid=false;missing.push('valid_runtime_configuration');}
  checks.publicOriginConfigured=!!runtime?.publicOrigin;checks.publicBindConfigured=runtime?.bindHost==='0.0.0.0';checks.operatorWalletConfigured=!!runtime?.operatorWallets?.length;checks.providerAccountConfigured=present(runtime?.providerAccountId);
  checks.pumpLookupTableConfigured=present(runtime?.pumpLookupTableAddress);
  checks.dailyComputeBudgetAllowsWork=!!runtime&&(runtime.dailyComputeBudgetUsd??1)>0;
  checks.proxyHostnameMatchesOrigin=false;checks.workerRemoteOriginSupported=false;
  if(runtime?.publicOrigin){const u=new URL(runtime.publicOrigin);checks.proxyHostnameMatchesOrigin=env.ROPAD_DOMAIN===u.host;checks.workerRemoteOriginSupported=['ropad.fun','www.ropad.fun'].includes(u.hostname)&&!u.port;}
  try{checks.stateDirectoryExists=fs.statSync(stateDirectory).isDirectory();fs.accessSync(stateDirectory,fs.constants.R_OK|fs.constants.W_OK);checks.stateDirectoryAccessible=checks.stateDirectoryExists;}catch{checks.stateDirectoryExists=false;checks.stateDirectoryAccessible=false;}
  try{const st=fs.statSync(path.join(stateDirectory,'studio-pool.key'));checks.workerCredentialFilePresent=st.isFile()&&st.size>=64&&st.size<=66;}catch{checks.workerCredentialFilePresent=false;}
  try{const config=JSON.parse(fs.readFileSync(path.join(stateDirectory,'fee-accounting-config.json'),'utf8'));checks.feeRecipientsConfigured=!!require('../solana-fee-accounting.cjs').normalizeConfig(config);}catch{checks.feeRecipientsConfigured=false;}
  checks.creatorScopedPublishing=false;
  try{const config=JSON.parse(fs.readFileSync(path.join(stateDirectory,'roblox-publishing-config.json'),'utf8')),projects=config?.projects,entries=projects&&typeof projects==='object'&&!Array.isArray(projects)?Object.entries(projects):[];
    checks.creatorScopedPublishing=config.credentialMode==='creator_scoped'||entries.some(([,p])=>p?.credentialEnv!==undefined);
    checks.publishingTargetsConfigured=(config.credentialMode===undefined||['creator_scoped','operator_legacy'].includes(config.credentialMode))&&entries.length>0&&entries.every(([,p])=>p&&typeof p.owner==='string'&&p.owner.length>0&&[p.placeId,p.universeId].every(v=>(typeof v!=='number'||Number.isSafeInteger(v))&&/^[1-9]\d{0,18}$/.test(String(v))))&&new Set(entries.map(([,p])=>String(p.placeId))).size===entries.length;
    if(checks.creatorScopedPublishing){const resolve=require('../roblox-publishing.cjs').createCreatorCredentialResolver({targets:projects,env});checks.robloxPublishingKeyConfigured=checks.publishingTargetsConfigured&&entries.every(([projectId,p])=>!!resolve({projectId,owner:p.owner,placeId:String(p.placeId),universeId:String(p.universeId)})?.key);}
  }catch{checks.publishingTargetsConfigured=false;if(checks.creatorScopedPublishing)checks.robloxPublishingKeyConfigured=false;}
  const runtimeRequired=['runtimeConfigurationValid','publicOriginConfigured','publicBindConfigured','proxyHostnameMatchesOrigin','stateDirectoryAccessible','frontendAssetsPresent','frontendPreviewDisabled'],productRequired=['inferenceKeyConfigured','providerManagementKeyConfigured','operatorWalletConfigured','providerAccountConfigured','pumpLookupTableConfigured','dailyComputeBudgetAllowsWork','feeRecipientsConfigured','robloxPublishingKeyConfigured','publishingTargetsConfigured','workerCredentialFilePresent','workerRemoteOriginSupported'];
  for(const name of [...runtimeRequired,...productRequired])if(!checks[name]&&!missing.includes(name))missing.push(name);
  if(!checks.mainnetExplicitlyEnabled)missing.push('explicit_mainnet_opt_in');
  return {mode:'read_only_configuration_check',runtimeConfigured:runtimeRequired.every(name=>checks[name]),launchConfigurationComplete:[...runtimeRequired,...productRequired].every(name=>checks[name])&&checks.mainnetExplicitlyEnabled,checks,missing,unverified:['dns_and_tls','public_health_endpoint','browser_wallet_session_and_csrf','management_key_permission_and_provider_balance','operator_credit_allocations','live_studio_worker_presence','roblox_place_access_and_playability','mainnet_rpc_connectivity','frozen_mainnet_lookup_table_contents','wallet_signed_launch_and_trade','onchain_fee_sharing'],warning:'Configuration presence is not proof of deployment, available funds, connected workers or successful launches'};
}
if(require.main===module){const result=checkReadiness();process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.runtimeConfigured)process.exitCode=1;else if(!result.launchConfigurationComplete)process.exitCode=2;}
module.exports={checkReadiness,checkFrontend};
