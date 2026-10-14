import http from 'node:http';
import {createHostedHandler} from '../src/hosted/handler.js';
import {createAtlasHandler} from '../server.js';
import {fixtures,config} from './helpers/hosted-fixture.js';
const settings={...config};
const api=createHostedHandler({client:fixtures(),config:settings,env:{}});
const assets=createAtlasHandler({store:{},env:{}});
const server=http.createServer((req,res)=>req.url.startsWith('/api/')?api(req,res):assets(req,res));
server.listen(0,'127.0.0.1',()=>{
  settings.appOrigin=`http://localhost:${server.address().port}`;settings.appHost=new URL(settings.appOrigin).host;
  console.log(settings.appOrigin);
});
