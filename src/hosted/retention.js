import {uuid} from './supabase.js';

// Operator-run retention task. Only tombstoned organizations older than the
// database-enforced 30-day window qualify; storage deletion is prefix-scoped.
export async function purgeDeletedOrganizations(client, now = new Date()) {
  const cutoff=new Date(now.getTime()-30*24*60*60*1000).toISOString();
  const rows=await client.call(`/rest/v1/atlas_organizations?deleted_at=lt.${encodeURIComponent(cutoff)}&select=id`,{service:true});
  let purged=0;
  for(const row of rows){
    if(!uuid(row.id))throw new Error('Invalid deleted organization identity.');
    const keys=[];
    async function collect(prefix,depth=0){
      if(depth>3)throw new Error('Unexpected evidence hierarchy; manual review required.');
      for(let offset=0;;offset+=100){
        const items=await client.call('/storage/v1/object/list/atlas-evidence',{service:true,method:'POST',body:{prefix,limit:100,offset,sortBy:{column:'name',order:'asc'}}});
        for(const item of items){
          if(typeof item.name!=='string'||item.name.includes('/')||item.name==='.'||item.name==='..')throw new Error('Invalid private object name.');
          const key=prefix+'/'+item.name;
          if(item.id)keys.push(key);else await collect(key,depth+1);
          if(keys.length>10000)throw new Error('Retention batch is too large; split the operator job.');
        }
        if(items.length<100)break;
      }
    }
    await collect(row.id);
    for(let index=0;index<keys.length;index+=100)await client.call('/storage/v1/object/atlas-evidence',{service:true,method:'DELETE',body:{prefixes:keys.slice(index,index+100)}});
    await client.rpc('atlas_purge_organization',{p_org_id:row.id},{service:true});
    purged++;
  }
  return {purged};
}
