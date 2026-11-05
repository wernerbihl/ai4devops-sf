import { join } from 'node:path';
import type { DockerPort } from '../kestra/deployment.ts';
import { dockerBind, kestraImagePins } from '../kestra/deployment.ts';
import type { FactoryStore } from '../storage/store.ts';
import { ensure } from '../storage/database.ts';

/** Validate only a protected staged copy; an uncertain Docker run remains fenced. */
export async function validateStagedH2(input:{id:string;directory:string;store:FactoryStore;docker:DockerPort;imageId:string;closeReceiptId:string;sourceH2Hash:string}):Promise<string>{
 const {id,directory,store,docker,imageId,closeReceiptId,sourceH2Hash}=input;
 const key='maintenance:h2-validation:'+directory;
 ensure(!store.getActionByKey(key),'backup_h2','Prior H2 validation requires recovery');
 const action=store.enqueueAction({key,kind:'maintenance.h2_validation',payload:{installationId:id,directory,imageId,closeReceiptId,sourceH2Hash}});
 const label='sf.h2-validation='+action.id;
 const script=`java -cp /app/kestra org.h2.tools.Shell -url 'jdbc:h2:file:/sf-data/database;IFEXISTS=TRUE;DB_CLOSE_DELAY=0;DB_CLOSE_ON_EXIT=TRUE' -user sa -password '' -sql "SCRIPT TO '/dev/null'; SELECT 'SF_H2_BACKUP_OK' AS SF_H2_BACKUP_STATUS" | awk '/Error:/{bad=1} $0=="SF_H2_BACKUP_OK"{ok++} END{if(bad||ok!=1){print "SF_H2_INVALID";exit 1}print "SF_H2_VALID"}'`;
 const result=await docker.command(['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--tmpfs','/tmp:rw,nosuid,nodev','--label',label,'--mount',dockerBind(join(directory,'kestra','data'),'/sf-data'),'--entrypoint','/bin/sh',kestraImagePins.kestra.image,'-c',script]);
 ensure(result==='SF_H2_VALID','backup_h2','H2 validation failed');
 const remaining=await docker.command(['container','ls','--all','--no-trunc','--quiet','--filter','label='+label]);ensure(remaining.trim()==='','backup_h2','H2 validator remains active');
 store.completeAction(action.id);return action.id;
}
