import test from 'node:test';
import assert from 'node:assert/strict';
import {brandMentioned,getResponseText,extractCitations,summarize,evaluate} from '../src/analyze.js';

test('detect aliases with Unicode and safe boundaries', ()=>{
  assert.equal(brandMentioned('Visit Luma Beauty in Praha 9', ['Luma Beauty']),true);
  assert.equal(brandMentioned('Lumabeautiful salon',['Luma Beauty']),false);
  assert.equal(brandMentioned('Kosmetika Šárka is nearby',['Kosmetika Šárka']),true);
  assert.equal(brandMentioned('X (Premium) is near here',['X (Premium)']),true);
});
test('parse API output + citation annotations',()=>{
 const data={output:[{type:'message',content:[{type:'output_text',text:'Test',annotations:[{type:'url_citation',url:'https://example.com/a',title:'A'},{type:'url_citation',url:'https://example.com/a',title:'A'}]}]}]};
 assert.equal(getResponseText(data),'Test');
 assert.equal(extractCitations(data).length,1);
});
test('live measurements take precedence over sample demo',()=>{
 const p={prompts:[{id:'p'}]};
 const observations=[{mode:'sample',brandMentioned:false,targetCited:false},{mode:'live',brandMentioned:true,targetCited:false}];
 assert.deepEqual([summarize(observations,p).source,summarize(observations,p).mentionRate],['live',100]);
});

test('empty measurements are not represented as sample data',()=>{
 const metrics=summarize([], {prompts:[]});
 assert.equal(metrics.source,'empty');
 assert.equal(metrics.mentionRate,0);
 assert.equal(metrics.trackedPrompts,0);
});

test('citation parser rejects unsafe URLs',()=>{
 const response={output:[{type:'message',content:[{type:'output_text',text:'ok',annotations:[
  {type:'url_citation',url:'javascript:alert(1)',title:'unsafe'},
  {type:'url_citation',url:'not a url'},
  {type:'url_citation',url:'https://example.com/path',title:'safe'}]}]}]};
 const cites=extractCitations(response);
 assert.equal(cites.length,1);
 assert.equal(cites[0].url,'https://example.com/path');
});


test('evaluate labels developer API data and does not infer a ranking',()=>{
 const response={output:[{type:'message',content:[{type:'output_text',text:'Luma Atelier and Aura Skin Lab are options.',annotations:[{type:'url_citation',url:'https://www.example.com/services',title:'Luma services'}]}]}]};
 const project={brand:'Luma Atelier',aliases:['Luma Beauty Atelier'],domain:'https://example.com',competitors:['Aura Skin Lab']};
 const prompt={id:'p1',text:'Best local facial?',language:'English',intent:'High intent'};
 const result=evaluate(response,project,prompt);
 assert.equal(result.mode,'live');
 assert.match(result.engine,/API/);
 assert.equal(result.brandMentioned,true);
 assert.equal(result.targetCited,true);
 assert.deepEqual(result.competitorsMentioned,['Aura Skin Lab']);
 assert.equal('rank' in result,false);
});
