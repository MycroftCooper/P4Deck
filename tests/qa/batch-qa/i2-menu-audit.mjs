// Parse literal menu data without importing product modules.
import ts from 'typescript';
import {readFileSync,writeFileSync} from 'node:fs';
const file=ts.createSourceFile('catalog.ts',readFileSync('src/app/context-menu/catalog.ts','utf8'),ts.ScriptTarget.Latest,true);
const decl=file.statements.flatMap(s=>ts.isVariableStatement(s)?[...s.declarationList.declarations]:[]).find(d=>d.name.getText(file)==='menuCatalog');
function literal(n){if(ts.isAsExpression(n)||ts.isSatisfiesExpression(n))return literal(n.expression);if(ts.isObjectLiteralExpression(n))return Object.fromEntries(n.properties.map(p=>[p.name.getText(file).replace(/^['"]|['"]$/g,''),literal(p.initializer)]));if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);if(ts.isStringLiteral(n))return n.text;throw Error('Nonliteral menu shape: '+n.kind);}
const catalog=literal(decl.initializer),doc=readFileSync('ForAIDoc/Designer/右键菜单对象与菜单项总表.md','utf8');
const comparisons=doc.split('\n').filter(l=>/^\| [FHCVSW TU]\d{2} \|/.test(l)).map(line=>{const c=line.split('|').map(x=>x.trim()),id=c[1];const expected=[...c[3].split('；'),...c[4].split('；')].map(x=>x.trim()).filter(x=>/^[☐☑]/u.test(x)).map(x=>x.replace(/^[☐☑]\s*/u,''));const actual=catalog[id].items.map(x=>x.label);return{id,expected,actual,match:JSON.stringify(expected)===JSON.stringify(actual)};});
if(process.argv.includes('--stable')){
 const declarations=new Map([...doc.matchAll(/<!-- menu-stable-ids ([A-Z]\d{2}): (.*?) -->/g)].map(m=>[m[1],m[2].split(',').map(s=>s.trim())]));
 for(const c of comparisons){c.actualIds=catalog[c.id].items.map(i=>i.id);c.documentIds=declarations.get(c.id)??c.expected.map((_,i)=>c.id+'-'+String(i+1).padStart(2,'0'));c.idMatch=JSON.stringify(c.actualIds)===JSON.stringify(c.documentIds);}
}
const mismatches=comparisons.filter(x=>!x.match||x.idMatch===false);writeFileSync('tests/qa/batch-qa/evidence/'+(process.argv.includes('--stable')?'m01-stable-id-differences.json':process.argv.includes('--m01')?'m01-menu-differences.json':'i2-menu-differences.json'),JSON.stringify({comparisons,mismatches},null,2));console.log(JSON.stringify(mismatches));
