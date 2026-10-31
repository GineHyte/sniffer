// Fresh Cardano Preprod test wallets for the x402 live test.
// Secrets stay in <stateDir>/<name>.json (mode 0o600, dir 0o700). stdout only ever carries addresses/balances.
import {openSync,writeFileSync,closeSync,readFileSync,mkdirSync,chmodSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PrivateKey} from '@evolution-sdk/evolution';
import {toClientCardanoSigner} from '@x402/cardano';

export const NETWORK='cardano:preprod';
export const BLOCKFROST_PREPROD_URL='https://cardano-preprod.blockfrost.io/api/v0';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export function stateDir(){return process.env.X402_STATE_DIR||join(ROOT,'.local','x402');}
export function validateName(name){
 if(typeof name!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(name))throw new Error('Wallet name must match ^[a-z][a-z0-9-]{0,31}$.');
 return name;
}
export function walletPath(name,dir=stateDir()){return join(dir,`${validateName(name)}.json`);}

// The address the reference x402 client signer pays from (CIP-1852 account 0 base address, network id 0).
// toClientCardanoSigner does no I/O on construction; projectId is optional in CardanoProviderConfig.
export function deriveAddress(mnemonic){
 return toClientCardanoSigner({mnemonic,network:NETWORK,provider:{blockfrost:{baseUrl:BLOCKFROST_PREPROD_URL}}}).getAddress();
}

export function createWallet(name,{dir=stateDir(),generateMnemonic=()=>PrivateKey.generateMnemonic(256),now=()=>new Date()}={}){
 const path=walletPath(name,dir);
 mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
 const mnemonic=generateMnemonic();
 if(!PrivateKey.validateMnemonic(mnemonic))throw new Error('Generated mnemonic failed BIP-39 validation.');
 const address=deriveAddress(mnemonic);
 if(!address.startsWith('addr_test1'))throw new Error('Derived address is not a testnet address.');
 let fd;
 try{fd=openSync(path,'wx',0o600)}catch(error){if(error.code==='EEXIST')throw new Error(`Wallet "${name}" already exists. Refusing to overwrite.`);throw error;}
 try{writeFileSync(fd,JSON.stringify({mnemonic,address,network:'preprod',createdAt:now().toISOString()},null,1)+'\n');}
 finally{closeSync(fd);}
 chmodSync(path,0o600);
 return {address};
}

// Never surface parser errors: V8 JSON.parse messages quote file content, which here is a mnemonic.
export function readWallet(name,dir=stateDir()){
 const path=walletPath(name,dir);
 let text;
 try{text=readFileSync(path,'utf8')}catch(error){if(error.code==='ENOENT')throw new Error(`Wallet "${name}" not found. Create it with: node x402/wallets.mjs create ${name}`);throw new Error(`Wallet "${name}" is unreadable (${error.code}).`);}
 let wallet;
 try{wallet=JSON.parse(text)}catch{throw new Error(`Wallet "${name}" file is not valid JSON. Inspect it manually.`);}
 if(typeof wallet?.mnemonic!=='string'||typeof wallet.address!=='string'||wallet.network!=='preprod')throw new Error(`Wallet "${name}" file is incomplete. Inspect it manually.`);
 if(!wallet.address.startsWith('addr_test1'))throw new Error(`Wallet "${name}" address is not a testnet address.`);
 return wallet;
}

export function walletAddress(name,dir=stateDir()){return readWallet(name,dir).address;}

// GET /addresses/{addr}. 404 means the address has never been used (unfunded).
export async function fetchBalance(address,{projectId=process.env.BLOCKFROST_API_KEY_PREPROD,fetchImpl=fetch,baseUrl=BLOCKFROST_PREPROD_URL}={}){
 if(!projectId)throw new Error('BLOCKFROST_API_KEY_PREPROD is not set. Run with: node --env-file=.env ...');
 const response=await fetchImpl(`${baseUrl}/addresses/${encodeURIComponent(address)}`,{headers:{project_id:projectId},signal:AbortSignal.timeout(20000)});
 if(response.status===404)return {address,used:false,lovelace:0n};
 if(!response.ok)throw new Error(`Blockfrost /addresses returned HTTP ${response.status}.`);
 const body=await response.json();
 const entry=Array.isArray(body?.amount)?body.amount.find(item=>item?.unit==='lovelace'):undefined;
 if(!entry||!/^[0-9]+$/.test(String(entry.quantity)))throw new Error('Blockfrost /addresses response has no lovelace amount.');
 return {address,used:true,lovelace:BigInt(entry.quantity)};
}

export function formatAda(lovelace){
 const value=BigInt(lovelace);return `${value/1000000n}.${String(value%1000000n).padStart(6,'0')}`;
}

async function main([command,name]){
 if(command==='create'){process.stdout.write(createWallet(name).address+'\n');return;}
 if(command==='address'){process.stdout.write(walletAddress(name)+'\n');return;}
 if(command==='balance'){
  const balance=await fetchBalance(walletAddress(name));
  process.stdout.write(JSON.stringify({address:balance.address,used:balance.used,lovelace:balance.lovelace.toString(),tADA:formatAda(balance.lovelace)})+'\n');
  return;
 }
 throw new Error('Usage: node x402/wallets.mjs create|address|balance <name>');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
