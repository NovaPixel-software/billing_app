const fs=require('fs'),{execFileSync}=require('child_process');
const V=process.argv[2];
const idx=JSON.parse(fs.readFileSync(V+'/index.json','utf8').replace(/^﻿/,''));
const out={};let tot=0;
for(const [k,f] of Object.entries(idx)){
  const d=parseFloat(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',V+'/'+f]).toString());
  out[k]={file:f,dur:d};tot+=d;
}
fs.writeFileSync(V+'/durations.json',JSON.stringify(out,null,1));
console.log(Object.keys(out).length,'clips, total narration',tot.toFixed(1)+'s');
for(const [k,v] of Object.entries(out)) console.log(v.dur.toFixed(1).padStart(5),v.file,k.slice(0,60));
