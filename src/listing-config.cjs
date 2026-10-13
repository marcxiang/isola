'use strict';

const LIMITS = Object.freeze({title:100,description:2000,categoryLabel:100,categoryDepth:8,condition:100,brand:100,size:100,color:100,parcel:100});
const LABELS = {title:'商品标题',description:'商品描述',condition:'成色',brand:'品牌',size:'尺码',color:'颜色',parcel:'包裹规格'};

function text(value, key, max, multiline = false) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError(`${LABELS[key] || key}必须是文字。`);
  const clean = value.replace(/\r\n?/g,'\n').trim();
  if ((multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(clean)) throw new TypeError(`${LABELS[key] || key}包含不支持的控制字符。`);
  if (clean.length > max) throw new RangeError(`${LABELS[key] || key}不能超过 ${max} 个字符。`);
  return clean;
}

function normalizeListing(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('刊登资料格式无效。');
  const output = {};
  for (const key of ['title','description','condition','brand','size','color','parcel']) output[key] = text(input[key],key,LIMITS[key],key==='description');
  let path = input.categoryPath;
  if (path === undefined || path === null || typeof path === 'string' && !path.trim()) path = [];
  else if (typeof path === 'string') path = path.split(/\s*\/\s*/);
  if (!Array.isArray(path)) throw new TypeError('分类路径必须是分类名称列表，或用「 / 」分隔的文字。');
  if (path.length > LIMITS.categoryDepth) throw new RangeError(`分类路径最多 ${LIMITS.categoryDepth} 层。`);
  output.categoryPath = path.map(value => {
    const label = text(value,'分类名称',LIMITS.categoryLabel);
    if (!label) throw new TypeError('分类路径不能包含空白名称。');
    return label;
  });
  return output;
}

module.exports = {normalizeListing,LIMITS};
