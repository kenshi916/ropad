'use strict';
// A frozen, mainnet lookup table saves enough packet space to atomically create
// a coin and permanently configure its creator fees. Only these SDK constants
// may be present; creator/mint/treasury addresses never come from the table.
const {PublicKey,SystemProgram,AddressLookupTableProgram,AddressLookupTableAccount}=require('@solana/web3.js');
const {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT}=require('@solana/spl-token');
const pump=require('@pump-fun/pump-sdk');
const FEE_LAUNCH_LOOKUP_ADDRESSES=Object.freeze([SystemProgram.programId,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,...['GLOBAL_PDA','PUMP_EVENT_AUTHORITY_PDA','FEE_PROGRAM_GLOBAL_PDA','PUMP_FEE_EVENT_AUTHORITY_PDA','AMM_GLOBAL_PDA','PUMP_AMM_EVENT_AUTHORITY_PDA','PUMP_FEE_CONFIG_PDA','PUMP_PROGRAM_ID','PUMP_FEE_PROGRAM_ID','PUMP_AMM_PROGRAM_ID'].map(name=>pump[name])].map(key=>key.toBase58()));
const fail=message=>Object.assign(new Error(message),{status:503,code:'FEE_LOOKUP_UNAVAILABLE'});
function validAddresses(addresses){return Array.isArray(addresses)&&addresses.length===FEE_LAUNCH_LOOKUP_ADDRESSES.length&&addresses.every((address,index)=>String(address)===FEE_LAUNCH_LOOKUP_ADDRESSES[index]);}
function validateLookupSnapshot(snapshot){
  try{if(!snapshot||typeof snapshot.address!=='string'||new PublicKey(snapshot.address).toBase58()!==snapshot.address||!validAddresses(snapshot.addresses)||!Number.isSafeInteger(snapshot.verificationSlot)||snapshot.verificationSlot<0||!Number.isSafeInteger(snapshot.lastExtendedSlot)||snapshot.lastExtendedSlot<0||snapshot.lastExtendedSlot>=snapshot.verificationSlot)throw Error();}catch{throw fail('The saved fee lookup table snapshot is invalid');}
  return snapshot;
}
function lookupAccount(snapshot){validateLookupSnapshot(snapshot);return new AddressLookupTableAccount({key:new PublicKey(snapshot.address),state:{addresses:snapshot.addresses.map(address=>new PublicKey(address)),authority:undefined,deactivationSlot:0xffffffffffffffffn,lastExtendedSlot:snapshot.lastExtendedSlot,lastExtendedSlotStartIndex:0}});}
async function loadFeeLaunchLookup(rpc,address){
  let key;try{if(typeof address!=='string'||(key=new PublicKey(address)).toBase58()!==address)throw Error();}catch{throw fail('Configure the frozen mainnet fee lookup table before launching a coin');}
  let response;try{response=await rpc.getAccountInfoAndContext(key,{commitment:'finalized'});}catch{throw fail('The mainnet fee lookup table could not be retrieved');}
  try{
    const {value,context}=response;if(!value||value.executable||!value.owner.equals(AddressLookupTableProgram.programId)||!Number.isSafeInteger(context?.slot)||context.slot<0)throw Error();
    const state=AddressLookupTableAccount.deserialize(value.data);
    if(state.authority!==undefined||state.deactivationSlot!==0xffffffffffffffffn||!Number.isSafeInteger(state.lastExtendedSlot)||state.lastExtendedSlot<0||state.lastExtendedSlot>=context.slot||!validAddresses(state.addresses))throw Error();
    const snapshot={address:key.toBase58(),addresses:state.addresses.map(address=>address.toBase58()),verificationSlot:context.slot,lastExtendedSlot:state.lastExtendedSlot};
    return {snapshot,account:lookupAccount(snapshot)};
  }catch{throw fail('The mainnet fee lookup table must be frozen, active, finalized and contain exactly the approved addresses');}
}
function lookupAddresses(message,snapshot){
  validateLookupSnapshot(snapshot);const rows=message.addressTableLookups;
  if(rows.length!==1||rows[0].accountKey.toBase58()!==snapshot.address)throw fail('The transaction does not use its verified fee lookup table');
  const row=rows[0],indexes=[...row.writableIndexes,...row.readonlyIndexes];
  if(!indexes.length||new Set(indexes).size!==indexes.length||indexes.some(index=>!Number.isInteger(index)||index<0||index>=snapshot.addresses.length)||row.writableIndexes.length)throw fail('The fee lookup table contains unexpected transaction indexes');
  return {writable:row.writableIndexes.map(index=>new PublicKey(snapshot.addresses[index])),readonly:row.readonlyIndexes.map(index=>new PublicKey(snapshot.addresses[index]))};
}
function verifyReceiptLookup(message,snapshot,loaded){
  const expected=lookupAddresses(message,snapshot);
  if(!loaded||!['writable','readonly'].every(role=>Array.isArray(loaded[role])&&loaded[role].length===expected[role].length&&loaded[role].every((key,index)=>String(key)===expected[role][index].toBase58())))throw fail('The finalized receipt resolved different fee lookup addresses');
}
module.exports={FEE_LAUNCH_LOOKUP_ADDRESSES,loadFeeLaunchLookup,validateLookupSnapshot,lookupAccount,lookupAddresses,verifyReceiptLookup};
