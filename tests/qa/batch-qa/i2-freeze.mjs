import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const handoff=JSON.parse(await readFile('src/features/companySubmit/i2-handoff.json'));
const comparisons=[];
for(const [path,expected] of Object.entries(handoff.hashes))comparisons.push({path,expected,actual:createHash('sha256').update(await readFile(path)).digest('hex')});
const changed=comparisons.filter(x=>x.expected!==x.actual);
await writeFile(new URL('./evidence/i2-freeze.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),comparisons,changed},null,2));
console.log(JSON.stringify({files:comparisons.length,changed}));if(changed.length)process.exitCode=1;
