// Compare MAIN-THREAD jitter: heavy concurrent queries run ON the main loop vs
// OFFLOADED to a worker thread. The main thread runs a 10ms heartbeat the whole
// time. Offloading should keep the main loop near-zero jitter while the worker
// is slammed.
const { Worker } = require('worker_threads')
const path = require('path')
const { MongoClient } = require('../index.js')

const URI = 'mongodb://localhost:27017/?serverMonitoringMode=poll'
const DB = 'rumongo_bench', COLL = 'worker'
const N = Number(process.env.N || 20000), CONC = Number(process.env.CONC || 10), FIELDS = 30
function makeDoc(i){const d={i,name:`u${i}`};for(let k=0;k<FIELDS;k++)d[`f${k}`]=`v${i}-${k}`;return d}
const maxOf=(t)=>t.reduce((a,b)=>Math.max(a,b),0)

function startHeartbeat(){
  const j=[];let last=process.hrtime.bigint()
  const t=setInterval(()=>{const n=process.hrtime.bigint();j.push(Number(n-last)/1e6-10);last=n},10)
  return ()=>{clearInterval(t);return maxOf(j)}
}

async function main(){
  const official=require('mongodb')
  const oc=new official.MongoClient(URI);await oc.connect()
  const ocoll=oc.db(DB).collection(COLL)
  await ocoll.deleteMany({})
  for(let s=0;s<N;s+=10000)await ocoll.insertMany(Array.from({length:Math.min(10000,N-s)},(_,k)=>makeDoc(s+k)))

  // --- ON MAIN THREAD ---
  const rust=await MongoClient.connect(URI)
  const runMain=async()=>{const docs=await rust.findLazy(DB,COLL,'{}','{}');let a=0;for(const d of docs)a+=d.getField('i');return a}
  let stop=startHeartbeat()
  let t0=Date.now()
  await Promise.all(Array.from({length:CONC},runMain))
  console.log(`MAIN-THREAD : ${CONC} queries in ${Date.now()-t0}ms, main-loop maxJitter=${stop().toFixed(1)}ms`)
  await rust.close()

  // --- ON WORKER THREAD ---
  const w=new Worker(path.join(__dirname,'worker_task.js'),{workerData:{uri:URI,db:DB,coll:COLL,conc:CONC}})
  await new Promise((res)=>w.once('message',(m)=>m.ready&&res()))
  stop=startHeartbeat()
  t0=Date.now()
  const ms=await new Promise((res)=>{w.on('message',(m)=>{if(m.done==='batch')res(m.ms)});w.postMessage('go')})
  console.log(`WORKER      : ${CONC} queries in ${ms}ms (worker), main-loop maxJitter=${stop().toFixed(1)}ms`)
  await new Promise((res)=>{w.on('message',(m)=>m.done==='stopped'&&res());w.postMessage('stop')})
  await w.terminate()

  await ocoll.drop().catch(()=>{});await oc.close();process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
