'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeListing,LIMITS} = require('../src/listing-config.cjs');

test('old plans may omit listing data and no brand or condition is guessed',()=>{
  assert.deepEqual(normalizeListing(),{title:'',description:'',condition:'',brand:'',size:'',color:'',parcel:'',categoryPath:[]});
  assert.deepEqual(normalizeListing(null),normalizeListing({}));
});
test('listing text and French category paths normalize without substituting facts',()=>{
  assert.deepEqual(normalizeListing({title:'  Pochette noire ',description:' Première ligne\r\nDeuxième ligne ',categoryPath:' Femmes / Accessoires / Autres accessoires ',condition:' Très bon état ',brand:' Sans marque ',size:' Taille unique ',color:' Noir ',parcel:' Petit '}),{title:'Pochette noire',description:'Première ligne\nDeuxième ligne',condition:'Très bon état',brand:'Sans marque',size:'Taille unique',color:'Noir',parcel:'Petit',categoryPath:['Femmes','Accessoires','Autres accessoires']});
  assert.deepEqual(normalizeListing({categoryPath:[' Femmes ','Petits / grands accessoires']}).categoryPath,['Femmes','Petits / grands accessoires']);
});
test('listing rejects malformed field types rather than serializing objects',()=>{
  for (const value of ['title',false,42,[]]) assert.throws(()=>normalizeListing(value),/格式/);
  for (const key of Object.keys(LIMITS).filter(key=>!key.startsWith('category'))) for (const value of [true,12,{},[]]) assert.throws(()=>normalizeListing({[key]:value}),/文字/);
  for (const value of [{},1,false]) assert.throws(()=>normalizeListing({categoryPath:value}),/分类路径/);
});
test('listing rejects ambiguous empty categories, excessive depth and long fields',()=>{
  for (const path of [[''],['Femmes',' '],['Femmes',null],['Femmes',{}],'Femmes /  / Accessoires']) assert.throws(()=>normalizeListing({categoryPath:path}),/空白|文字/);
  assert.throws(()=>normalizeListing({categoryPath:Array(9).fill('A')}),/8 层/);
  assert.equal(normalizeListing({categoryPath:Array(8).fill('A')}).categoryPath.length,8);
  assert.throws(()=>normalizeListing({categoryPath:['A'.repeat(101)]}),/100/);
  for (const key of ['title','description','condition','brand','size','color','parcel']) {
    assert.equal(normalizeListing({[key]:'a'.repeat(LIMITS[key])})[key].length,LIMITS[key]);
    assert.throws(()=>normalizeListing({[key]:'a'.repeat(LIMITS[key]+1)}),/不能超过/);
  }
});
test('listing rejects control characters and omits unrelated or secret fields',()=>{
  assert.throws(()=>normalizeListing({title:'A\nB'}),/控制字符/);
  assert.throws(()=>normalizeListing({brand:'A\tB'}),/控制字符/);
  assert.throws(()=>normalizeListing({description:'A\u0000B'}),/控制字符/);
  const input={title:'Test',token:'do-not-echo',rawPayload:{secret:true},categoryPath:['A']};
  const output=normalizeListing(input);
  assert.equal('token' in output,false);assert.equal('rawPayload' in output,false);
  output.categoryPath.push('B');assert.deepEqual(input.categoryPath,['A']);
});
