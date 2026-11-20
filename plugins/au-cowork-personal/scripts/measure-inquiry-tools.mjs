// Deterministic tool-definition size proxy, not tokenizer output.
// Run from this package: node scripts/measure-inquiry-tools.mjs [immutable baseline].
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {centralTools} from '../src/central-tools.mjs';
import {zodToJsonSchema} from 'zod-to-json-schema';
const require=createRequire(import.meta.url),cwd=fileURLToPath(new URL('..',import.meta.url));
const baseline=process.argv[2]??'d38f879';
const pin=execFileSync('git',['rev-parse',`${baseline}^{commit}`],{cwd,encoding:'utf8'}).trim();
const prefix='plugins/au-cowork-personal/src/';
const source=name=>execFileSync('git',['show',`${pin}:${prefix}${name}`],{cwd,encoding:'utf8'});
const dependency=name=>JSON.stringify(pathToFileURL(require.resolve(name)).href);
const url=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const contracts=url(source('product/contracts.mjs').replace(/from\s+['"]zod['"]/,`from ${dependency('zod')}`));
// Only definition assembly runs. Replace the unused transport error import, not any definition.
const before=await import(url(source('central-tools.mjs')
 .replace(/from\s+['"]zod['"]/,`from ${dependency('zod')}`)
 .replace(/from\s+['"]zod-to-json-schema['"]/,`from ${dependency('zod-to-json-schema')}`)
 .replace(/from\s+['"]\.\/product\/contracts\.mjs['"]/,`from ${JSON.stringify(contracts)}`)
 .replace(/import\s*\{failure\}\s*from\s*['"]\.\/central-client\.mjs['"];?/,"const failure=()=>{throw Error('measurement does not execute tools')};")));
const definition=tool=>({name:tool.name,description:tool.description,inputSchema:zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'})});
const size=value=>{const json=JSON.stringify(value),utf8_bytes=Buffer.byteLength(json);return {utf8_bytes,characters:[...json].length,bytes_div_4_proxy:Math.ceil(utf8_bytes/4),sha256:createHash('sha256').update(json).digest('hex')};};
const report={measurement:'Compact JSON model-facing definitions; UTF-8 bytes / 4 rounded up is a deterministic proxy, NOT actual tokenizer tokens.',baseline:pin,profiles:{}};
for(const profile of ['personal','moderator']){
 const a=before.centralTools({},profile).map(definition),b=centralTools({},profile).map(definition);
 const touched=defs=>defs.filter(d=>['ac_ask','ac_read','ac_inquiry_act'].includes(d.name));
 report.profiles[profile]={before:{tools:a.length,total:size(a),inquiry_surface:size(touched(a))},after:{tools:b.length,total:size(b),inquiry_surface:size(touched(b))}};
}
console.log(JSON.stringify(report,null,2));
